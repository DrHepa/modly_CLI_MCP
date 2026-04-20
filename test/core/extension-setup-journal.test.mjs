import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

function createTempStage(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-setup-journal-test-'));
  const stagePath = path.join(tempRoot, 'stage');
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return stagePath;
}

test('setup journal helpers persist latest metadata and append run logs under a reusable extension path', async (t) => {
  const stagePath = createTempStage(t);
  const extensionPath = path.join(path.dirname(stagePath), 'extensions', 'octo.tools');
  const {
    getSetupRunPaths,
    writeLatestSetupRun,
    readLatestSetupRun,
    appendSetupRunLog,
  } = await import('../../src/core/extension-setup-journal.mjs');

  const firstSnapshot = writeLatestSetupRun(extensionPath, {
    runId: 'run-001',
    extensionPath,
    status: 'running',
    startedAt: '2026-04-19T15:20:00.000Z',
    logPath: getSetupRunPaths(extensionPath, 'run-001').logPath,
    stdoutBytes: 0,
    stderrBytes: 0,
    totalBytes: 0,
  });

  assert.equal(firstSnapshot.runId, 'run-001');
  assert.equal(firstSnapshot.logPath, path.join(extensionPath, '.modly', 'setup-runs', 'run-001.log'));
  assert.equal(readLatestSetupRun(extensionPath).startedAt, '2026-04-19T15:20:00.000Z');

  appendSetupRunLog(extensionPath, 'run-001', 'stdout', Buffer.from('hello\n'));
  appendSetupRunLog(extensionPath, 'run-001', 'stderr', Buffer.from('boom\n'));

  const finalSnapshot = writeLatestSetupRun(extensionPath, {
    ...readLatestSetupRun(extensionPath),
    status: 'succeeded',
    lastOutputAt: '2026-04-19T15:20:01.000Z',
    finishedAt: '2026-04-19T15:20:02.000Z',
    stdoutBytes: 6,
    stderrBytes: 5,
    totalBytes: 11,
  });

  assert.equal(finalSnapshot.status, 'succeeded');
  assert.equal(finalSnapshot.finishedAt, '2026-04-19T15:20:02.000Z');
  assert.equal(finalSnapshot.totalBytes, 11);
  assert.equal(readFileSync(getSetupRunPaths(extensionPath, 'run-001').logPath, 'utf8'), 'hello\nboom\n');
});

test('setup journal lock reconciles stale running state before reacquiring the stage lock', async (t) => {
  const stagePath = createTempStage(t);
  const {
    getSetupRunPaths,
    writeLatestSetupRun,
    readLatestSetupRun,
    acquireSetupRunLock,
    releaseSetupRunLock,
  } = await import('../../src/core/extension-setup-journal.mjs');

  const firstLock = acquireSetupRunLock(stagePath, {
    runId: 'run-stale',
    pid: 4321,
    startedAt: '2026-04-19T15:21:00.000Z',
    isProcessAlive: () => true,
  });

  writeLatestSetupRun(stagePath, {
    runId: 'run-stale',
    stagePath,
    pid: 4321,
    status: 'running',
    startedAt: '2026-04-19T15:21:00.000Z',
    logPath: getSetupRunPaths(stagePath, 'run-stale').logPath,
  });

  assert.throws(
    () => acquireSetupRunLock(stagePath, {
      runId: 'run-next',
      pid: 9876,
      startedAt: '2026-04-19T15:21:30.000Z',
      isProcessAlive: () => true,
    }),
    (error) => error?.code === 'SETUP_ALREADY_RUNNING',
  );

  releaseSetupRunLock(firstLock);

  const secondLock = acquireSetupRunLock(stagePath, {
    runId: 'run-next',
    pid: 9876,
    startedAt: '2026-04-19T15:22:00.000Z',
    now: () => '2026-04-19T15:22:10.000Z',
    isProcessAlive: () => false,
  });

  const latestSnapshot = readLatestSetupRun(stagePath);
  assert.equal(latestSnapshot.status, 'interrupted');
  assert.equal(latestSnapshot.runId, 'run-stale');
  assert.equal(latestSnapshot.staleReason, 'pid_not_alive');
  assert.equal(latestSnapshot.finishedAt, '2026-04-19T15:22:10.000Z');
  assert.equal(secondLock.runId, 'run-next');

  releaseSetupRunLock(secondLock);
  assert.equal(getSetupRunPaths(stagePath).lockPath, path.join(stagePath, '.modly', 'setup-runs', 'active.lock'));
});

test('setup journal lock rejects a concurrent acquire while the existing active lock owner is still alive before latest.json exists', async (t) => {
  const stagePath = createTempStage(t);
  const { acquireSetupRunLock, releaseSetupRunLock, getSetupRunPaths } = await import('../../src/core/extension-setup-journal.mjs');

  const firstLock = acquireSetupRunLock(stagePath, {
    runId: 'run-live',
    pid: 4321,
    startedAt: '2026-04-19T16:50:00.000Z',
    isProcessAlive: () => true,
  });

  assert.throws(
    () => acquireSetupRunLock(stagePath, {
      runId: 'run-racer',
      pid: 9876,
      startedAt: '2026-04-19T16:50:01.000Z',
      isProcessAlive: (pid) => pid === 4321,
    }),
    (error) => {
      assert.equal(error?.code, 'SETUP_ALREADY_RUNNING');
      assert.equal(error?.details?.setup?.runId, 'run-live');
      assert.equal(error?.details?.setup?.pid, 4321);
      assert.equal(error?.details?.setup?.stagePath, stagePath);
      return true;
    },
  );

  assert.equal(readFileSync(getSetupRunPaths(stagePath).lockPath, 'utf8').includes('run-live'), true);
  releaseSetupRunLock(firstLock);
});

test('setup journal lock clears a stale active lock without latest.json when the recorded owner pid is no longer alive', async (t) => {
  const stagePath = createTempStage(t);
  const { acquireSetupRunLock, releaseSetupRunLock } = await import('../../src/core/extension-setup-journal.mjs');

  acquireSetupRunLock(stagePath, {
    runId: 'run-stale-lock',
    pid: 2222,
    startedAt: '2026-04-19T16:51:00.000Z',
    isProcessAlive: () => true,
  });

  const recoveredLock = acquireSetupRunLock(stagePath, {
    runId: 'run-next',
    pid: 3333,
    startedAt: '2026-04-19T16:51:10.000Z',
    isProcessAlive: (pid) => pid !== 2222,
  });

  assert.equal(recoveredLock.runId, 'run-next');
  assert.equal(recoveredLock.pid, 3333);
  releaseSetupRunLock(recoveredLock);
});

test('setup journal exposes observable terminal states for setup status snapshots', async () => {
  const { isObservableSetupTerminal } = await import('../../src/core/extension-setup-journal.mjs');

  assert.equal(isObservableSetupTerminal({ status: 'running' }), false);
  assert.equal(isObservableSetupTerminal({ status: 'succeeded' }), true);
  assert.equal(isObservableSetupTerminal({ status: 'failed' }), true);
  assert.equal(isObservableSetupTerminal({ status: 'interrupted' }), true);
  assert.equal(isObservableSetupTerminal({ status: 'unknown' }), false);
  assert.equal(isObservableSetupTerminal(null), false);
});

test('setup journal reads only appended log bytes from a local offset', async (t) => {
  const stagePath = createTempStage(t);
  const extensionPath = path.join(path.dirname(stagePath), 'extensions', 'octo.tools');
  const {
    appendSetupRunLog,
    getSetupRunPaths,
    readSetupRunLogDelta,
  } = await import('../../src/core/extension-setup-journal.mjs');

  appendSetupRunLog(extensionPath, 'run-follow', 'stdout', Buffer.from('hello\n'));
  const logPath = getSetupRunPaths(extensionPath, 'run-follow').logPath;

  const firstRead = readSetupRunLogDelta(logPath, 0);
  assert.deepEqual(firstRead, {
    text: 'hello\n',
    nextOffset: 6,
    bytesRead: 6,
    missing: false,
  });

  const secondRead = readSetupRunLogDelta(logPath, firstRead.nextOffset);
  assert.deepEqual(secondRead, {
    text: '',
    nextOffset: 6,
    bytesRead: 0,
    missing: false,
  });

  appendSetupRunLog(extensionPath, 'run-follow', 'stderr', Buffer.from('boom\n'));
  const thirdRead = readSetupRunLogDelta(logPath, secondRead.nextOffset);
  assert.deepEqual(thirdRead, {
    text: 'boom\n',
    nextOffset: 11,
    bytesRead: 5,
    missing: false,
  });
});

test('setup journal delta reader reports missing logs without failing', async (t) => {
  const stagePath = createTempStage(t);
  const { getSetupRunPaths, readSetupRunLogDelta } = await import('../../src/core/extension-setup-journal.mjs');
  const logPath = getSetupRunPaths(stagePath, 'run-missing').logPath;

  assert.deepEqual(readSetupRunLogDelta(logPath, 0), {
    text: '',
    nextOffset: 0,
    bytesRead: 0,
    missing: true,
  });
});

test('setup journal identifies whether a latest snapshot can be followed locally from its persisted logPath', async () => {
  const { isFollowableSetupRun } = await import('../../src/core/extension-setup-journal.mjs');

  assert.equal(isFollowableSetupRun({ runId: 'run-1', logPath: '/tmp/run-1.log' }), true);
  assert.equal(isFollowableSetupRun({ runId: 'run-1', logPath: '' }), false);
  assert.equal(isFollowableSetupRun({ runId: null, logPath: '/tmp/run-1.log' }), false);
  assert.equal(isFollowableSetupRun(null), false);
});
