import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const wrapperTemplate = path.join(repoRoot, 'templates', 'opencode', 'run_server.mjs');

function createConsumerRepo(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-wrapper-contract-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const wrapperPath = path.join(tempRoot, 'tools', 'modly_mcp', 'run_server.mjs');
  mkdirSync(path.dirname(wrapperPath), { recursive: true });
  copyFileSync(wrapperTemplate, wrapperPath);

  return { tempRoot, wrapperPath };
}

function writeExecutable(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
  chmodSync(filePath, 0o755);
}

function createFakeBin(filePath, source) {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst payload = { source: ${JSON.stringify(source)}, args: process.argv.slice(2), env: { MODLY_API_URL: process.env.MODLY_API_URL ?? null, MODLY_PROFILE: process.env.MODLY_PROFILE ?? null } };\nif (process.env.WRAPPER_OUTPUT_FILE) { writeFileSync(process.env.WRAPPER_OUTPUT_FILE, JSON.stringify(payload)); }\n`,
  );
}

function runWrapper({ wrapperPath, args = [], env = {}, pathEntries = [] }) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: path.dirname(path.dirname(path.dirname(wrapperPath))),
    env: {
      ...process.env,
      ...env,
      PATH: [...pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
    },
    encoding: 'utf8',
  });
}

test('wrapper prefers node_modules/.bin/modly-mcp and applies local.env to the child process', (t) => {
  const { tempRoot, wrapperPath } = createConsumerRepo(t);
  const outputFile = path.join(tempRoot, 'local-output.json');
  const globalBinDir = path.join(tempRoot, 'fake-global-bin');
  const localBin = path.join(tempRoot, 'node_modules', '.bin', 'modly-mcp');
  const globalBin = path.join(globalBinDir, 'modly-mcp');
  const envFile = path.join(tempRoot, 'tools', '_tmp', 'modly_mcp', 'local.env');

  createFakeBin(localBin, 'local');
  createFakeBin(globalBin, 'global');
  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, '# comments are ignored\nMODLY_API_URL=http://127.0.0.1:8765\nMODLY_PROFILE = "repo-local"\n', 'utf8');

  const result = runWrapper({
    wrapperPath,
    args: ['--stdio'],
    env: { WRAPPER_OUTPUT_FILE: outputFile },
    pathEntries: [globalBinDir],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(outputFile), 'wrapper must launch the resolved command');

  const payload = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(payload.source, 'local');
  assert.deepEqual(payload.args, ['--stdio']);
  assert.deepEqual(payload.env, {
    MODLY_API_URL: 'http://127.0.0.1:8765',
    MODLY_PROFILE: 'repo-local',
  });
});

test('wrapper falls back to global modly-mcp on PATH when no local bin exists', (t) => {
  const { tempRoot, wrapperPath } = createConsumerRepo(t);
  const outputFile = path.join(tempRoot, 'global-output.json');
  const globalBinDir = path.join(tempRoot, 'fake-global-bin');
  const globalBin = path.join(globalBinDir, 'modly-mcp');

  createFakeBin(globalBin, 'global');

  const result = runWrapper({
    wrapperPath,
    args: ['--stdio'],
    env: { WRAPPER_OUTPUT_FILE: outputFile },
    pathEntries: [globalBinDir],
  });

  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(payload.source, 'global');
  assert.deepEqual(payload.args, ['--stdio']);
});

test('wrapper --check reports local resolution without starting MCP', (t) => {
  const { tempRoot, wrapperPath } = createConsumerRepo(t);
  const outputFile = path.join(tempRoot, 'should-not-exist.json');
  const localBin = path.join(tempRoot, 'node_modules', '.bin', 'modly-mcp');
  const envFile = path.join(tempRoot, 'tools', '_tmp', 'modly_mcp', 'local.env');

  createFakeBin(localBin, 'local');
  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, 'MODLY_API_URL=http://127.0.0.1:8765\n', 'utf8');

  const result = runWrapper({
    wrapperPath,
    args: ['--check'],
    env: { WRAPPER_OUTPUT_FILE: outputFile },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(outputFile), false, '--check must not spawn the MCP process');

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.resolution.mode, 'local');
  assert.equal(payload.envFile.exists, true);
  assert.deepEqual(payload.envFile.appliedKeys, ['MODLY_API_URL']);
});

test('wrapper --check reports global resolution when only PATH is available', (t) => {
  const { tempRoot, wrapperPath } = createConsumerRepo(t);
  const outputFile = path.join(tempRoot, 'should-not-exist.json');
  const globalBinDir = path.join(tempRoot, 'fake-global-bin');
  const globalBin = path.join(globalBinDir, 'modly-mcp');

  createFakeBin(globalBin, 'global');

  const result = runWrapper({
    wrapperPath,
    args: ['--check'],
    env: { WRAPPER_OUTPUT_FILE: outputFile },
    pathEntries: [globalBinDir],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(outputFile), false, '--check must not spawn the MCP process');

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.resolution.mode, 'global');
  assert.equal(payload.envFile.exists, false);
  assert.deepEqual(payload.envFile.appliedKeys, []);
});
