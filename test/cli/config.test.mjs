import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { renderConfigHelp, renderHelp } from '../../src/cli/help.mjs';
import { runConfigCommand } from '../../src/cli/commands/config.mjs';

const cliEntry = path.resolve('src/cli/index.mjs');

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-config-cli-test-'));
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

test('global and config help advertise launcher locate/open commands', () => {
  const globalHelp = renderHelp();
  const configHelp = renderConfigHelp();

  assert.match(globalHelp, /config <subcommand>\s+paths get \| paths set \| launcher locate \| launcher open/u);
  assert.match(globalHelp, /launcher open runs in the background by default; use --foreground for foreground mode/u);
  assert.match(configHelp, /launcher locate/u);
  assert.match(configHelp, /launcher open/u);
  assert.match(configHelp, /background by default; --foreground/u);
});

test('runConfigCommand locate returns structured launcher data and human output', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'modly');
  createFakeModlyRepo(repoRoot, ['launch.sh']);

  const result = await runConfigCommand({
    args: ['launcher', 'locate'],
    config: {},
    client: {},
    cwd: repoRoot,
    env: {},
    platform: 'linux',
  });

  assert.deepEqual(result.data.launcher, {
    path: path.join(repoRoot, 'launch.sh'),
    root: repoRoot,
    entry: 'launch.sh',
    source: 'ancestor',
    preferredOrder: ['launch.sh'],
  });
  assert.match(result.humanMessage, /launcher: .*launch\.sh/u);
  assert.match(result.humanMessage, /source: ancestor/u);
});

test('runConfigCommand open returns execution metadata after opening launcher', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'modly');
  createFakeModlyRepo(repoRoot, ['launch.sh']);
  const opened = [];

  const result = await runConfigCommand({
    args: ['launcher', 'open'],
    config: {},
    client: {},
    cwd: repoRoot,
    env: {},
    platform: 'linux',
    spawnLauncher(command, args, options) {
      opened.push({ command, args, options });
      return {
        pid: 2468,
        unref() {},
        once(event, handler) {
          if (event === 'spawn') {
            process.nextTick(handler);
          }

          return this;
        },
      };
    },
  });

  assert.deepEqual(opened, [
    {
      command: 'bash',
      args: ['launch.sh'],
      options: {
        cwd: repoRoot,
        stdio: 'ignore',
        detached: true,
      },
    },
  ]);
  assert.deepEqual(result.data.opened, {
    command: 'bash',
    args: ['launch.sh'],
    cwd: repoRoot,
    detached: true,
    launcherPath: path.join(repoRoot, 'launch.sh'),
    launcherEntry: 'launch.sh',
    pid: 2468,
  });
  assert.equal(result.data.mode, 'background');
  assert.match(result.humanMessage, /opened launcher in background with bash launch\.sh/u);
});

test('runConfigCommand open supports --foreground', async (t) => {
  const tempRoot = createTempRoot(t);
  const repoRoot = path.join(tempRoot, 'modly');
  createFakeModlyRepo(repoRoot, ['launch.sh']);
  const opened = [];

  const result = await runConfigCommand({
    args: ['launcher', 'open', '--foreground'],
    config: {},
    client: {},
    cwd: repoRoot,
    env: {},
    platform: 'linux',
    spawnLauncher(command, args, options) {
      opened.push({ command, args, options });
      return {
        pid: 1357,
        once(event, handler) {
          if (event === 'close') {
            process.nextTick(() => handler(0, null));
          }

          return this;
        },
      };
    },
  });

  assert.deepEqual(opened, [
    {
      command: 'bash',
      args: ['launch.sh'],
      options: {
        cwd: repoRoot,
        stdio: 'inherit',
        detached: false,
      },
    },
  ]);
  assert.equal(result.data.mode, 'foreground');
  assert.equal(result.data.opened.detached, false);
  assert.match(result.humanMessage, /opened launcher in foreground with bash launch\.sh/u);
});

test('CLI locate emits useful JSON output without touching the backend', (t) => {
  const tempRoot = createTempRoot(t);
  const workspaceRoot = path.join(tempRoot, 'Tools');
  const cliRoot = path.join(workspaceRoot, 'modly_CLI_MCP');
  const upstreamRoot = path.join(workspaceRoot, 'modly');
  mkdirSync(cliRoot, { recursive: true });
  createFakeModlyRepo(upstreamRoot, ['launch.sh']);

  const result = spawnSync(process.execPath, [cliEntry, '--json', 'config', 'launcher', 'locate'], {
    cwd: cliRoot,
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.launcher.path, path.join(upstreamRoot, 'launch.sh'));
  assert.equal(payload.data.launcher.source, 'sibling');
});

test('runConfigCommand locate fails with an explicit launcher discovery error', async () => {
  await assert.rejects(
    runConfigCommand({
      args: ['launcher', 'locate'],
      config: {},
      client: {},
      cwd: os.tmpdir(),
      env: {},
      platform: 'linux',
    }),
    {
      code: 'NOT_FOUND',
      message:
        'modly config launcher locate could not locate a valid Modly launcher. Checked MODLY_LAUNCHER, current repo/ancestors, and sibling ../modly with repo markers api/main.py + electron/main.',
    },
  );
});

test('CLI locate emits explicit JSON error when no launcher candidate resolves', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-config-cli-empty-'));

  try {
    const result = spawnSync(process.execPath, [cliEntry, '--json', 'config', 'launcher', 'locate'], {
      cwd: tempRoot,
      env: { ...process.env },
      encoding: 'utf8',
    });

    assert.equal(result.status, 4, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'NOT_FOUND');
    assert.match(payload.error.message, /modly config launcher locate could not locate a valid Modly launcher/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
