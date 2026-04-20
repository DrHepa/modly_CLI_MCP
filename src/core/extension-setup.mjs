import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { ValidationError } from './errors.mjs';
import {
  acquireSetupRunLock,
  appendSetupRunLog,
  getSetupRunPaths,
  releaseSetupRunLock,
  writeLatestSetupRun,
} from './extension-setup-journal.mjs';
import { inspectStagedExtension } from './github-extension-staging.mjs';

const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = [500, 1000];

const TRANSIENT_NETWORK_PATTERNS = [
  /readtimeouterror/i,
  /timeout/i,
  /timed out/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /eai_again/i,
  /connection reset/i,
  /connreset/i,
  /tls.*timeout/i,
  /proxy.*timeout/i,
  /http\s*(502|503|504)/i,
  /\b(502|503|504)\b/,
];

const STRUCTURAL_FAILURE_PATTERNS = [
  /no matching distribution found/i,
  /could not find a version that satisfies the requirement/i,
  /wheel/i,
  /abi/i,
  /cuda/i,
  /compiler/i,
  /gcc/i,
  /g\+\+/i,
  /cl\.exe/i,
  /credential/i,
  /authentication/i,
  /unauthorized/i,
  /forbidden/i,
];

function normalizeExtensionPath(input, cwd) {
  const candidate = typeof input.extensionPath === 'string' && input.extensionPath.trim() !== ''
    ? input.extensionPath
    : input.stagePath;

  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ValidationError('Expected --stage-path to point to a prepared extension stage.', {
      code: 'SETUP_STAGE_INVALID',
      details: {
        setup: {
          phase: 'preflight',
          code: 'SETUP_STAGE_INVALID',
          extensionPath: input.extensionPath,
          stagePath: input.stagePath,
        },
      },
    });
  }

  return path.resolve(cwd, candidate.trim());
}

function normalizePythonExe(pythonExe) {
  if (typeof pythonExe !== 'string' || pythonExe.trim() === '') {
    throw new ValidationError('Expected --python-exe to be an explicit non-empty executable name.', {
      code: 'SETUP_PYTHON_EXE_INVALID',
      details: {
        setup: {
          phase: 'preflight',
          code: 'SETUP_PYTHON_EXE_INVALID',
          pythonExe,
        },
      },
    });
  }

  return pythonExe.trim();
}

function normalizeSetupPayload(setupPayload) {
  if (setupPayload === undefined) {
    return {};
  }

  if (setupPayload === null || typeof setupPayload !== 'object' || Array.isArray(setupPayload)) {
    throw new ValidationError('Expected setup payload to be a JSON object when provided.', {
      code: 'SETUP_PAYLOAD_INVALID',
      details: {
        setup: {
          phase: 'preflight',
          code: 'SETUP_PAYLOAD_INVALID',
        },
      },
    });
  }

  return setupPayload;
}

export function splitRunnerPolicy(setupPayload) {
  const { __modlyRunner, ...functionalPayload } = setupPayload;
  const runnerPolicy = __modlyRunner && typeof __modlyRunner === 'object' && !Array.isArray(__modlyRunner)
    ? { ...__modlyRunner }
    : {};

  return {
    functionalPayload,
    runnerPolicy,
  };
}

function normalizePositiveInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeNonNegativeInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function buildSetupEnv({ env = process.env, runnerPolicy = {} } = {}) {
  const nextEnv = { ...env };
  const timeout = normalizePositiveInteger(runnerPolicy.timeout);
  const retries = normalizeNonNegativeInteger(runnerPolicy.retries);
  const indexUrl = normalizeNonEmptyString(runnerPolicy.indexUrl);
  const extraIndexUrl = normalizeNonEmptyString(runnerPolicy.extraIndexUrl);
  const cacheDir = normalizeNonEmptyString(runnerPolicy.cacheDir);

  if (timeout !== null) {
    nextEnv.PIP_DEFAULT_TIMEOUT = String(timeout);
  }

  if (retries !== null) {
    nextEnv.PIP_RETRIES = String(retries);
  }

  if (indexUrl !== null) {
    nextEnv.PIP_INDEX_URL = indexUrl;
  }

  if (extraIndexUrl !== null) {
    nextEnv.PIP_EXTRA_INDEX_URL = extraIndexUrl;
  }

  if (cacheDir !== null) {
    nextEnv.PIP_CACHE_DIR = cacheDir;
  }

  return nextEnv;
}

function buildFinalSetupPayload({ setupPayload, pythonExe, extensionPath }) {
  const { python_exe: _ignoredPythonExe, ext_dir: _ignoredExtDir, ...userPayloadSansReserved } = setupPayload;

  return {
    ...userPayloadSansReserved,
    python_exe: pythonExe,
    ext_dir: extensionPath,
  };
}

function buildPlan({ extensionPath, pythonExe, allowThirdParty, payload, setupContract }) {
  if (!setupContract) {
    return {
      consentGranted: allowThirdParty,
      cwd: extensionPath,
      command: null,
      args: [],
      setupContract: null,
    };
  }

  return {
    consentGranted: allowThirdParty,
    cwd: extensionPath,
    command: pythonExe,
    args: [setupContract.entry, JSON.stringify(payload)],
    setupContract,
  };
}

function matchesAnyPattern(input, patterns) {
  return patterns.some((pattern) => pattern.test(input));
}

export function classifySetupFailure({ stderr = '', stdout = '', error = null } = {}) {
  const combined = [stderr, stdout, error?.message].filter(Boolean).join('\n');

  if (matchesAnyPattern(combined, TRANSIENT_NETWORK_PATTERNS)) {
    return 'transient_network';
  }

  if (matchesAnyPattern(combined, STRUCTURAL_FAILURE_PATTERNS)) {
    return 'structural';
  }

  return 'unknown';
}

export function resolveAttemptPolicy(runnerPolicy = {}) {
  const configuredRetries = normalizeNonNegativeInteger(runnerPolicy.retries) ?? 0;
  const retries = Math.min(configuredRetries, MAX_TRANSIENT_RETRIES);
  return {
    retries,
    maxAttempts: 1 + retries,
    backoffScheduleMs: RETRY_BACKOFF_MS.slice(0, retries),
  };
}

function resolveCatalogStatus(setupContract) {
  return setupContract?.catalogStatus ?? null;
}

function buildBlockedResult({ extensionPath, plan, inspection, blockers }) {
  return {
    status: 'blocked',
    blocked: true,
    catalogStatus: resolveCatalogStatus(plan?.setupContract),
    extensionPath,
    stagePath: extensionPath,
    plan,
    blockers,
    execution: null,
    journal: null,
    artifacts: {
      before: inspection,
      after: null,
    },
  };
}

function buildResult({ status, extensionPath, plan, blockers = [], execution, before, after, journal = null }) {
  return {
    status,
    blocked: status === 'blocked',
    catalogStatus: resolveCatalogStatus(plan?.setupContract),
    extensionPath,
    stagePath: extensionPath,
    plan,
    blockers,
    execution,
    journal,
    artifacts: {
      before,
      after,
    },
  };
}

function resolveRequiredPayloadInputs(setupContract) {
  if (Array.isArray(setupContract?.requiredPayloadInputs)) {
    return setupContract.requiredPayloadInputs;
  }

  if (Array.isArray(setupContract?.requiredInputs)) {
    return setupContract.requiredInputs;
  }

  return [];
}

function findMissingRequiredInputs({ setupContract, payload }) {
  const injectedInputs = new Set(Array.isArray(setupContract?.injectedInputs) ? setupContract.injectedInputs : []);
  return resolveRequiredPayloadInputs(setupContract).filter((key) => !injectedInputs.has(key) && !(key in payload));
}

function hasNewWarnings(beforeWarnings = [], afterWarnings = []) {
  if (afterWarnings.length > beforeWarnings.length) {
    return true;
  }

  const beforeKeys = new Set(beforeWarnings.map((warning) => JSON.stringify(warning)));
  return afterWarnings.some((warning) => !beforeKeys.has(JSON.stringify(warning)));
}

function classifySuccessfulSetup(beforeInspection, afterInspection) {
  if (afterInspection.status !== 'prepared') {
    return 'configured_degraded';
  }

  if (hasNewWarnings(beforeInspection?.warnings, afterInspection?.warnings)) {
    return 'configured_degraded';
  }

  return 'configured';
}

async function runSetupCommand({ spawnImpl, now, plan, startedAt, env, onSpawn, onOutput }) {
  return new Promise((resolve, reject) => {
    const startedAtValue = startedAt ?? now();
    const child = spawnImpl(plan.command, plan.args, {
      cwd: plan.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      onOutput?.('stdout', chunk);
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      onOutput?.('stderr', chunk);
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      const finishedAt = now();
      resolve({
        startedAt: startedAtValue,
        finishedAt,
        durationMs: finishedAt - startedAtValue,
        exitCode,
        ...(signal == null ? {} : { signal }),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function createInitialJournal({ runId, extensionPath, startedAt, setupContract }) {
  return {
    runId,
    extensionPath,
    stagePath: extensionPath,
    pid: null,
    status: 'running',
    startedAt,
    lastOutputAt: null,
    finishedAt: null,
    logPath: getSetupRunPaths(extensionPath, runId).logPath,
    exitCode: null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    totalBytes: 0,
    contract: {
      kind: setupContract?.kind ?? null,
      entry: setupContract?.entry ?? null,
      catalogStatus: setupContract?.catalogStatus ?? null,
    },
    attempt: 0,
    maxAttempts: 1,
    failureClass: null,
    retryable: false,
    attempts: [],
  };
}

function finalizeJournal(journal, updates = {}) {
  return {
    ...journal,
    ...updates,
  };
}

function recordJournalOutput({ journal, extensionPath, runId, streamName, chunk, now }) {
  const { logPath, bytesWritten } = appendSetupRunLog(extensionPath, runId, streamName, chunk);
  const nextJournal = finalizeJournal(journal, {
    logPath,
    lastOutputAt: now(),
    stdoutBytes: journal.stdoutBytes + (streamName === 'stdout' ? bytesWritten : 0),
    stderrBytes: journal.stderrBytes + (streamName === 'stderr' ? bytesWritten : 0),
    totalBytes: journal.totalBytes + bytesWritten,
  });
  writeLatestSetupRun(extensionPath, nextJournal);
  return nextJournal;
}

export async function configureStagedExtension(input = {}, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const inspectStage = deps.inspectStage ?? inspectStagedExtension;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const now = deps.now ?? Date.now;
  const extensionPath = normalizeExtensionPath(input, cwd);
  const pythonExe = normalizePythonExe(input.pythonExe);
  const allowThirdParty = input.allowThirdParty === true;
  const setupPayload = normalizeSetupPayload(input.setupPayload);
  const { functionalPayload, runnerPolicy } = splitRunnerPolicy(setupPayload);
  const finalPayload = buildFinalSetupPayload({
    setupPayload: functionalPayload,
    pythonExe,
    extensionPath,
  });
  const setupEnv = buildSetupEnv({
    env: deps.env ?? process.env,
    runnerPolicy,
  });
  const attemptPolicy = resolveAttemptPolicy(runnerPolicy);
  const sleep = deps.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const inspection = await inspectStage(extensionPath);
  const setupContract = inspection.setupContract ?? null;
  const blockers = [];

  if (!allowThirdParty) {
    blockers.push({
      code: 'THIRD_PARTY_CONSENT_REQUIRED',
      message: 'Explicit --allow-third-party consent is required before executing staged setup contracts.',
    });
  }

  if (inspection.status !== 'prepared') {
    blockers.push({
      code: 'SETUP_STAGE_INVALID',
      message: inspection.diagnostics?.detail ?? 'Prepared stage inspection failed before setup execution.',
      detail: inspection.diagnostics ?? null,
    });
  }

  if (!setupContract) {
    blockers.push({
      code: 'SETUP_CONTRACT_UNSUPPORTED',
      message: 'Only an explicit root setup.py contract is supported for staged extension setup in this version.',
    });
  }

  const missingInputs = findMissingRequiredInputs({
    setupContract,
    payload: finalPayload,
  });

  if (missingInputs.length > 0) {
    blockers.push({
      code: 'SETUP_INPUT_REQUIRED',
      message: 'The staged setup contract requires explicit setup payload inputs before execution.',
      detail: missingInputs,
    });
  }

  const plan = buildPlan({
    extensionPath,
    pythonExe,
    allowThirdParty,
    payload: finalPayload,
    setupContract,
  });

  if (blockers.length > 0) {
    return buildBlockedResult({
      extensionPath,
      plan,
      inspection,
      blockers,
    });
  }

  const runId = deps.createRunId?.() ?? randomUUID();
  const startedAt = now();
  let lockHandle = null;
  let journal = createInitialJournal({
    runId,
    extensionPath,
    startedAt,
    setupContract,
  });
  const attempts = [];

  try {
    lockHandle = acquireSetupRunLock(extensionPath, {
      runId,
      startedAt,
      isProcessAlive: deps.isProcessAlive,
    });
    journal = finalizeJournal(journal, {
      maxAttempts: attemptPolicy.maxAttempts,
    });
    writeLatestSetupRun(extensionPath, journal);

    let execution;
    for (let attempt = 1; attempt <= attemptPolicy.maxAttempts; attempt += 1) {
      journal = finalizeJournal(journal, {
        status: 'running',
        attempt,
        maxAttempts: attemptPolicy.maxAttempts,
        failureClass: null,
        retryable: false,
        pid: null,
        exitCode: null,
        signal: null,
        finishedAt: null,
      });
      writeLatestSetupRun(extensionPath, journal);

      execution = await runSetupCommand({
        spawnImpl,
        now,
        plan,
        startedAt: attempt === 1 ? startedAt : undefined,
        env: setupEnv,
        onSpawn: (child) => {
          journal = finalizeJournal(journal, {
            pid: child.pid ?? null,
          });
          writeLatestSetupRun(extensionPath, journal);
        },
        onOutput: (streamName, chunk) => {
          journal = recordJournalOutput({
            journal,
            extensionPath,
            runId,
            streamName,
            chunk,
            now,
          });
        },
      });

      const failureClass = execution.exitCode === 0
        ? null
        : classifySetupFailure({
          stderr: execution.stderr,
          stdout: execution.stdout,
        });
      const retryable = execution.exitCode !== 0
        && failureClass === 'transient_network'
        && attempt < attemptPolicy.maxAttempts;
      const attemptRecord = {
        attempt,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        exitCode: execution.exitCode,
        failureClass,
        retryable,
      };
      attempts.push(attemptRecord);
      execution = {
        ...execution,
        attempt,
        maxAttempts: attemptPolicy.maxAttempts,
        failureClass,
        retryable,
        attempts: [...attempts],
      };
      journal = finalizeJournal(journal, {
        pid: journal.pid,
        status: execution.exitCode === 0 ? 'succeeded' : 'failed',
        finishedAt: execution.finishedAt,
        exitCode: execution.exitCode,
        signal: execution.signal ?? null,
        attempt,
        maxAttempts: attemptPolicy.maxAttempts,
        failureClass,
        retryable,
        attempts: [...attempts],
      });
      writeLatestSetupRun(extensionPath, journal);

      if (execution.exitCode === 0 || !retryable) {
        break;
      }

      await sleep(attemptPolicy.backoffScheduleMs[attempt - 1] ?? 0);
    }

    if (execution.exitCode !== 0) {
      return buildResult({
        status: 'blocked',
        extensionPath,
        plan,
        blockers: [
          {
            code: 'SETUP_EXECUTION_FAILED',
            message: 'The staged setup contract exited with a non-zero code.',
            detail: {
              exitCode: execution.exitCode,
            },
          },
        ],
        execution,
        before: inspection,
        after: null,
        journal,
      });
    }

    const afterInspection = await inspectStage(extensionPath);

    return buildResult({
      status: classifySuccessfulSetup(inspection, afterInspection),
      extensionPath,
      plan,
      blockers: [],
      execution,
      before: inspection,
      after: afterInspection,
      journal,
    });
  } catch (error) {
    if (lockHandle) {
      journal = finalizeJournal(journal, {
        status: 'interrupted',
        finishedAt: now(),
        staleReason: 'spawn_error',
      });
      writeLatestSetupRun(extensionPath, journal);
    }

    throw error;
  } finally {
    releaseSetupRunLock(lockHandle);
  }
}
