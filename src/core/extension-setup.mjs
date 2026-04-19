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

function normalizeStagePath(stagePath, cwd) {
  if (typeof stagePath !== 'string' || stagePath.trim() === '') {
    throw new ValidationError('Expected --stage-path to point to a prepared extension stage.', {
      code: 'SETUP_STAGE_INVALID',
      details: {
        setup: {
          phase: 'preflight',
          code: 'SETUP_STAGE_INVALID',
          stagePath,
        },
      },
    });
  }

  return path.resolve(cwd, stagePath.trim());
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

function buildFinalSetupPayload({ setupPayload, pythonExe, stagePath }) {
  const { python_exe: _ignoredPythonExe, ext_dir: _ignoredExtDir, ...userPayloadSansReserved } = setupPayload;

  return {
    ...userPayloadSansReserved,
    python_exe: pythonExe,
    ext_dir: stagePath,
  };
}

function buildPlan({ stagePath, pythonExe, allowThirdParty, payload, setupContract }) {
  if (!setupContract) {
    return {
      consentGranted: allowThirdParty,
      cwd: stagePath,
      command: null,
      args: [],
      setupContract: null,
    };
  }

  return {
    consentGranted: allowThirdParty,
    cwd: stagePath,
    command: pythonExe,
    args: [setupContract.entry, JSON.stringify(payload)],
    setupContract,
  };
}

function resolveCatalogStatus(setupContract) {
  return setupContract?.catalogStatus ?? null;
}

function buildBlockedResult({ stagePath, plan, inspection, blockers }) {
  return {
    status: 'blocked',
    blocked: true,
    catalogStatus: resolveCatalogStatus(plan?.setupContract),
    stagePath,
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

function buildResult({ status, stagePath, plan, blockers = [], execution, before, after, journal = null }) {
  return {
    status,
    blocked: status === 'blocked',
    catalogStatus: resolveCatalogStatus(plan?.setupContract),
    stagePath,
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

async function runSetupCommand({ spawnImpl, now, plan, startedAt, onSpawn, onOutput }) {
  return new Promise((resolve, reject) => {
    const startedAtValue = startedAt ?? now();
    const child = spawnImpl(plan.command, plan.args, {
      cwd: plan.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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

function createInitialJournal({ runId, stagePath, startedAt, setupContract }) {
  return {
    runId,
    stagePath,
    pid: null,
    status: 'running',
    startedAt,
    lastOutputAt: null,
    finishedAt: null,
    logPath: getSetupRunPaths(stagePath, runId).logPath,
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
  };
}

function finalizeJournal(journal, updates = {}) {
  return {
    ...journal,
    ...updates,
  };
}

function recordJournalOutput({ journal, stagePath, runId, streamName, chunk, now }) {
  const { logPath, bytesWritten } = appendSetupRunLog(stagePath, runId, streamName, chunk);
  const nextJournal = finalizeJournal(journal, {
    logPath,
    lastOutputAt: now(),
    stdoutBytes: journal.stdoutBytes + (streamName === 'stdout' ? bytesWritten : 0),
    stderrBytes: journal.stderrBytes + (streamName === 'stderr' ? bytesWritten : 0),
    totalBytes: journal.totalBytes + bytesWritten,
  });
  writeLatestSetupRun(stagePath, nextJournal);
  return nextJournal;
}

export async function configureStagedExtension(input = {}, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const inspectStage = deps.inspectStage ?? inspectStagedExtension;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const now = deps.now ?? Date.now;
  const stagePath = normalizeStagePath(input.stagePath, cwd);
  const pythonExe = normalizePythonExe(input.pythonExe);
  const allowThirdParty = input.allowThirdParty === true;
  const setupPayload = normalizeSetupPayload(input.setupPayload);
  const finalPayload = buildFinalSetupPayload({
    setupPayload,
    pythonExe,
    stagePath,
  });
  const inspection = await inspectStage(stagePath);
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
    stagePath,
    pythonExe,
    allowThirdParty,
    payload: finalPayload,
    setupContract,
  });

  if (blockers.length > 0) {
    return buildBlockedResult({
      stagePath,
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
    stagePath,
    startedAt,
    setupContract,
  });

  try {
    lockHandle = acquireSetupRunLock(stagePath, {
      runId,
      startedAt,
      isProcessAlive: deps.isProcessAlive,
    });
    writeLatestSetupRun(stagePath, journal);

    const execution = await runSetupCommand({
      spawnImpl,
      now,
      plan,
      startedAt,
      onSpawn: (child) => {
        journal = finalizeJournal(journal, {
          pid: child.pid ?? null,
        });
        writeLatestSetupRun(stagePath, journal);
      },
      onOutput: (streamName, chunk) => {
        journal = recordJournalOutput({
          journal,
          stagePath,
          runId,
          streamName,
          chunk,
          now,
        });
      },
    });

    journal = finalizeJournal(journal, {
      pid: journal.pid,
      status: execution.exitCode === 0 ? 'succeeded' : 'failed',
      finishedAt: execution.finishedAt,
      exitCode: execution.exitCode,
      signal: execution.signal ?? null,
    });
    writeLatestSetupRun(stagePath, journal);

    if (execution.exitCode !== 0) {
      return buildResult({
        status: 'blocked',
        stagePath,
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

    const afterInspection = await inspectStage(stagePath);

    return buildResult({
      status: classifySuccessfulSetup(inspection, afterInspection),
      stagePath,
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
      writeLatestSetupRun(stagePath, journal);
    }

    throw error;
  } finally {
    releaseSetupRunLock(lockHandle);
  }
}
