import path from 'node:path';
import { spawn } from 'node:child_process';

import { ValidationError } from './errors.mjs';
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

function buildBlockedResult({ stagePath, plan, inspection, blockers }) {
  return {
    status: 'blocked',
    blocked: true,
    stagePath,
    plan,
    blockers,
    execution: null,
    artifacts: {
      before: inspection,
      after: null,
    },
  };
}

function buildResult({ status, stagePath, plan, blockers = [], execution, before, after }) {
  return {
    status,
    blocked: status === 'blocked',
    stagePath,
    plan,
    blockers,
    execution,
    artifacts: {
      before,
      after,
    },
  };
}

function findMissingRequiredInputs(requiredInputs, payload) {
  return requiredInputs.filter((key) => !(key in payload));
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

async function runSetupCommand({ spawnImpl, now, plan }) {
  return new Promise((resolve, reject) => {
    const startedAt = now();
    const child = spawnImpl(plan.command, plan.args, {
      cwd: plan.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('close', (exitCode) => {
      const finishedAt = now();
      resolve({
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
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

  const missingInputs = findMissingRequiredInputs(setupContract?.requiredInputs ?? [], setupPayload);

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
    payload: setupPayload,
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

  const execution = await runSetupCommand({
    spawnImpl,
    now,
    plan,
  });

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
  });
}
