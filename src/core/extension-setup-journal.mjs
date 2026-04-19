import path from 'node:path';
import process from 'node:process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { ValidationError } from './errors.mjs';

function ensureSetupRunDir(extensionPath) {
  const rootPath = path.join(extensionPath, '.modly', 'setup-runs');
  mkdirSync(rootPath, { recursive: true });
  return rootPath;
}

function defaultNow() {
  return new Date().toISOString();
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function getSetupRunPaths(extensionPath, runId = null) {
  const rootPath = path.join(extensionPath, '.modly', 'setup-runs');
  return {
    rootPath,
    latestPath: path.join(rootPath, 'latest.json'),
    lockPath: path.join(rootPath, 'active.lock'),
    logPath: runId ? path.join(rootPath, `${runId}.log`) : null,
  };
}

export function readLatestSetupRun(extensionPath) {
  const { latestPath } = getSetupRunPaths(extensionPath);
  if (!existsSync(latestPath)) {
    return null;
  }

  return JSON.parse(readFileSync(latestPath, 'utf8'));
}

export function writeLatestSetupRun(extensionPath, journal) {
  const { rootPath, latestPath } = getSetupRunPaths(extensionPath);
  ensureSetupRunDir(extensionPath);
  const tmpPath = path.join(rootPath, `latest.${process.pid}.${Date.now()}.tmp`);
  const snapshot = { ...journal };
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, latestPath);
  return snapshot;
}

export function appendSetupRunLog(extensionPath, runId, _streamName, chunk) {
  const normalizedChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const logPath = getSetupRunPaths(extensionPath, runId).logPath;
  ensureSetupRunDir(extensionPath);
  appendFileSync(logPath, normalizedChunk);
  return {
    logPath,
    bytesWritten: normalizedChunk.byteLength,
  };
}

export function reconcileLatestSetupRun(extensionPath, deps = {}) {
  const now = deps.now ?? defaultNow;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const latest = readLatestSetupRun(extensionPath);

  if (!latest || latest.status !== 'running') {
    return latest;
  }

  if (Number.isInteger(latest.pid) && isProcessAlive(latest.pid)) {
    return latest;
  }

  const staleReason = Number.isInteger(latest.pid) ? 'pid_not_alive' : 'lock_without_process';
  const interrupted = writeLatestSetupRun(extensionPath, {
    ...latest,
    status: 'interrupted',
    finishedAt: latest.finishedAt ?? now(),
    staleReason,
  });

  const { lockPath } = getSetupRunPaths(extensionPath);
  rmSync(lockPath, { force: true });
  return interrupted;
}

function readActiveSetupRunLock(lockPath) {
  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function createSetupAlreadyRunningError(extensionPath, setup = {}) {
  const logHint = setup.logPath ? ` Log: ${setup.logPath}.` : '';
  return new ValidationError(
    `Another setup run is already active for this extension path. Inspect it with modly ext setup-status --stage-path "${extensionPath}".${logHint}`,
    {
      code: 'SETUP_ALREADY_RUNNING',
      details: {
        setup: {
          phase: 'preflight',
          code: 'SETUP_ALREADY_RUNNING',
          extensionPath,
          stagePath: extensionPath,
          runId: setup.runId ?? null,
          pid: setup.pid ?? null,
          logPath: setup.logPath ?? null,
          statusCommand: `modly ext setup-status --stage-path "${extensionPath}"`,
        },
      },
    },
  );
}

export function acquireSetupRunLock(extensionPath, options = {}) {
  const now = options.now ?? defaultNow;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const { lockPath } = getSetupRunPaths(extensionPath);
  ensureSetupRunDir(extensionPath);
  const latest = reconcileLatestSetupRun(extensionPath, { now, isProcessAlive });

  if (latest?.status === 'running') {
    throw createSetupAlreadyRunningError(extensionPath, latest);
  }

  const lockPid = options.pid ?? process.pid;

  const tryAcquire = () => {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({
          runId: options.runId ?? null,
          pid: lockPid,
          startedAt: options.startedAt ?? now(),
        }, null, 2)}\n`,
        'utf8',
      );
    } finally {
      closeSync(fd);
    }

    return {
      extensionPath,
      stagePath: extensionPath,
      lockPath,
      runId: options.runId ?? null,
      pid: lockPid,
    };
  };

  while (true) {
    try {
      return tryAcquire();
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }

    const latestAfterConflict = reconcileLatestSetupRun(extensionPath, { now, isProcessAlive });
    if (latestAfterConflict?.status === 'running') {
      throw createSetupAlreadyRunningError(extensionPath, latestAfterConflict);
    }

    const activeLock = readActiveSetupRunLock(lockPath);
    if (!activeLock) {
      continue;
    }

    if (Number.isInteger(activeLock.pid) && !isProcessAlive(activeLock.pid)) {
      rmSync(lockPath, { force: true });
      continue;
    }

    throw createSetupAlreadyRunningError(extensionPath, {
      runId: activeLock.runId ?? null,
      pid: activeLock.pid ?? null,
      logPath: latestAfterConflict?.logPath ?? null,
    });
  }
}

export function releaseSetupRunLock(lockHandle) {
  if (!lockHandle?.lockPath) {
    return;
  }

  rmSync(lockHandle.lockPath, { force: true });
}
