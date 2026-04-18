import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cliEntry = path.resolve('src/cli/index.mjs');

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-cli-entrypoint-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

test('CLI entrypoint autoejecuta correctamente cuando se invoca mediante symlink', { skip: process.platform === 'win32' ? 'symlink contract covered by packaging test on non-Windows platforms' : false }, (t) => {
  const tempRoot = createTempRoot(t);
  const binDir = path.join(tempRoot, 'node_modules', '.bin');
  const symlinkPath = path.join(binDir, 'modly');

  mkdirSync(binDir, { recursive: true });
  symlinkSync(cliEntry, symlinkPath);

  const result = spawnSync(process.execPath, [symlinkPath, '--help'], {
    cwd: tempRoot,
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /modly/u);
  assert.match(result.stdout, /capabilities/u);
});
