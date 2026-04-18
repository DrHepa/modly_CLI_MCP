import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  buildModlyLauncherOpenSpec,
  openModlyLauncher,
  resolveModlyLauncher,
} from '../../src/core/modly-launcher.mjs';

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-launcher-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function writeExecutable(filePath, contents = '#!/usr/bin/env bash\n') {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
  chmodSync(filePath, 0o755);
}

function createFakeModlyRepo(root, launcherNames = ['launch.sh']) {
  mkdirSync(path.join(root, 'api'), { recursive: true });
  mkdirSync(path.join(root, 'electron', 'main'), { recursive: true });
  writeFileSync(path.join(root, 'api', 'main.py'), 'print("ok")\n', 'utf8');

  for (const launcherName of launcherNames) {
    writeExecutable(path.join(root, launcherName));
  }
}

test('resolveModlyLauncher gives precedence to MODLY_LAUNCHER', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'custom-modly');
  createFakeModlyRepo(repoRoot, ['launch.sh']);

  const result = await resolveModlyLauncher({
    cwd: tempRoot,
    env: { MODLY_LAUNCHER: path.join(repoRoot, 'launch.sh') },
    platform: 'linux',
  });

  assert.equal(result.path, path.join(repoRoot, 'launch.sh'));
  assert.equal(result.root, repoRoot);
  assert.equal(result.entry, 'launch.sh');
  assert.equal(result.source, 'env');
});

test('resolveModlyLauncher ignores invalid MODLY_LAUNCHER and falls through to ancestor repo', async (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const repoRoot = path.join(workspaceRoot, 'modly');
  const cwd = path.join(repoRoot, 'packages', 'cli');

  createFakeModlyRepo(repoRoot, ['launch.sh']);
  mkdirSync(cwd, { recursive: true });

  const result = await resolveModlyLauncher({
    cwd,
    env: { MODLY_LAUNCHER: path.join(tempRoot, 'invalid', 'launch.sh') },
    platform: 'linux',
  });

  assert.equal(result.path, path.join(repoRoot, 'launch.sh'));
  assert.equal(result.root, repoRoot);
  assert.equal(result.source, 'ancestor');
});

test('resolveModlyLauncher discovers sibling ../modly repo launchers', async (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'Tools');
  const cliRoot = path.join(workspaceRoot, 'modly_CLI_MCP');
  const upstreamRoot = path.join(workspaceRoot, 'modly');
  mkdirSync(cliRoot, { recursive: true });
  createFakeModlyRepo(upstreamRoot, ['launch.sh']);

  const result = await resolveModlyLauncher({
    cwd: cliRoot,
    env: {},
    platform: 'linux',
  });

  assert.equal(result.path, path.join(upstreamRoot, 'launch.sh'));
  assert.equal(result.root, upstreamRoot);
  assert.equal(result.source, 'sibling');
});

test('resolveModlyLauncher ignores invalid MODLY_LAUNCHER and falls through to sibling modly repo', async (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'Tools');
  const cliRoot = path.join(workspaceRoot, 'modly_CLI_MCP');
  const siblingRoot = path.join(workspaceRoot, 'modly');

  mkdirSync(cliRoot, { recursive: true });
  createFakeModlyRepo(siblingRoot, ['launch.sh']);

  const result = await resolveModlyLauncher({
    cwd: cliRoot,
    env: { MODLY_LAUNCHER: path.join(tempRoot, 'invalid', 'launch.sh') },
    platform: 'linux',
  });

  assert.equal(result.path, path.join(siblingRoot, 'launch.sh'));
  assert.equal(result.root, siblingRoot);
  assert.equal(result.source, 'sibling');
});

test('resolveModlyLauncher prefers an ancestor repo before sibling modly', async (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'Tools');
  const ancestorRoot = path.join(workspaceRoot, 'modly_CLI_MCP');
  const cwd = path.join(ancestorRoot, 'packages', 'cli');
  const siblingRoot = path.join(workspaceRoot, 'modly');

  createFakeModlyRepo(ancestorRoot, ['launch.sh']);
  createFakeModlyRepo(siblingRoot, ['launch.sh']);
  mkdirSync(cwd, { recursive: true });

  const result = await resolveModlyLauncher({
    cwd,
    env: {},
    platform: 'linux',
  });

  assert.equal(result.path, path.join(ancestorRoot, 'launch.sh'));
  assert.equal(result.root, ancestorRoot);
  assert.equal(result.source, 'ancestor');
});

test('resolveModlyLauncher prioritizes launch.sh on POSIX and launch.bat on Windows', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'modly');
  createFakeModlyRepo(repoRoot, ['launch.sh', 'launch.bat']);

  const posixResult = await resolveModlyLauncher({
    cwd: repoRoot,
    env: {},
    platform: 'linux',
  });
  const windowsResult = await resolveModlyLauncher({
    cwd: repoRoot,
    env: {},
    platform: 'win32',
  });

  assert.equal(posixResult.entry, 'launch.sh');
  assert.equal(windowsResult.entry, 'launch.bat');
});

test('resolveModlyLauncher rejects cross-platform launcher fallback on POSIX', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'modly');
  createFakeModlyRepo(repoRoot, ['launch.bat']);

  const result = await resolveModlyLauncher({
    cwd: repoRoot,
    env: {},
    platform: 'linux',
  });

  assert.equal(result, null);
});

test('resolveModlyLauncher rejects partial sibling repos missing the expected launcher', async (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'Tools');
  const cliRoot = path.join(workspaceRoot, 'modly_CLI_MCP');
  const siblingRoot = path.join(workspaceRoot, 'modly');
  mkdirSync(cliRoot, { recursive: true });
  createFakeModlyRepo(siblingRoot, ['launch.bat']);

  const result = await resolveModlyLauncher({
    cwd: cliRoot,
    env: {},
    platform: 'linux',
  });

  assert.equal(result, null);
});

test('resolveModlyLauncher rejects partial sibling repos missing required Modly markers', async (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'Tools');
  const cliRoot = path.join(workspaceRoot, 'modly_CLI_MCP');
  const siblingRoot = path.join(workspaceRoot, 'modly');

  mkdirSync(cliRoot, { recursive: true });
  writeExecutable(path.join(siblingRoot, 'launch.sh'));

  const result = await resolveModlyLauncher({
    cwd: cliRoot,
    env: {},
    platform: 'linux',
  });

  assert.equal(result, null);
});

test('resolveModlyLauncher rejects cross-platform launcher fallback on Windows', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'modly');
  createFakeModlyRepo(repoRoot, ['launch.sh']);

  const result = await resolveModlyLauncher({
    cwd: repoRoot,
    env: {},
    platform: 'win32',
  });

  assert.equal(result, null);
});

test('openModlyLauncher builds the correct command and cwd', async () => {
  const bashSpec = buildModlyLauncherOpenSpec({
    launcherPath: '/tmp/modly/launch.sh',
    platform: 'linux',
  });
  assert.deepEqual(bashSpec, {
    command: 'bash',
    args: ['launch.sh'],
    cwd: '/tmp/modly',
    detached: true,
    launcherPath: '/tmp/modly/launch.sh',
    launcherEntry: 'launch.sh',
  });

  const spawned = [];
  const opened = await openModlyLauncher({
    launcherPath: '/tmp/modly/launch.bat',
    platform: 'win32',
    windowsCommand: 'cmd.exe',
    spawnImpl(command, args, options) {
      spawned.push({ command, args, options });
      const emitter = new EventEmitter();
      emitter.pid = 4321;
      emitter.unref = () => {
        emitter.unrefCalled = true;
      };
      process.nextTick(() => emitter.emit('spawn'));
      return emitter;
    },
  });

  assert.deepEqual(spawned, [
    {
      command: 'cmd.exe',
      args: ['/c', 'launch.bat'],
      options: {
        cwd: '/tmp/modly',
        stdio: 'ignore',
        detached: true,
      },
    },
  ]);
  assert.deepEqual(opened, {
    command: 'cmd.exe',
    args: ['/c', 'launch.bat'],
    cwd: '/tmp/modly',
    detached: true,
    launcherPath: '/tmp/modly/launch.bat',
    launcherEntry: 'launch.bat',
    pid: 4321,
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(opened.detached, true);
  assert.equal(opened.pid, 4321);
});

test('openModlyLauncher supports explicit foreground mode', async () => {
  const spawned = [];

  const opened = await openModlyLauncher({
    launcherPath: '/tmp/modly/launch.sh',
    platform: 'linux',
    detached: false,
    spawnImpl(command, args, options) {
      spawned.push({ command, args, options });
      const emitter = new EventEmitter();
      emitter.pid = 9876;
      process.nextTick(() => emitter.emit('close', 0, null));
      return emitter;
    },
  });

  assert.deepEqual(spawned, [
    {
      command: 'bash',
      args: ['launch.sh'],
      options: {
        cwd: '/tmp/modly',
        stdio: 'inherit',
        detached: false,
      },
    },
  ]);
  assert.deepEqual(opened, {
    command: 'bash',
    args: ['launch.sh'],
    cwd: '/tmp/modly',
    detached: false,
    launcherPath: '/tmp/modly/launch.sh',
    launcherEntry: 'launch.sh',
    pid: 9876,
  });
});
