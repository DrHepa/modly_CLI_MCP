import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });

  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function runNpm(args, options = {}) {
  return run(npmCommand, args, options);
}

function parsePackJson(stdout) {
  const payload = JSON.parse(stdout);
  assert.ok(Array.isArray(payload), 'npm pack --json must return an array');
  assert.ok(payload.length > 0, 'npm pack --json must return at least one entry');
  return payload[0];
}

test('packed artifact can be installed and exposes working modly + modly-mcp bins', (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-packaging-contract-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const dryRun = runNpm(['pack', '--dry-run', '--json'], { cwd: repoRoot });
  assert.equal(dryRun.status, 0, dryRun.stderr);

  const dryRunPack = parsePackJson(dryRun.stdout);
  const publishedFiles = new Set((dryRunPack.files ?? []).map((file) => file.path));

  for (const requiredFile of [
    'README.md',
    'docs/install/global.md',
    'docs/install/repo-local.md',
    'docs/install/codex-global.md',
    'docs/install/codex-repo-local.md',
    'skills/modly-operator/SKILL.md',
    'skills/modly-extension-planner/SKILL.md',
    'templates/opencode/opencode.json',
    'templates/opencode/repo-local.opencode.json',
    'templates/opencode/run_server.mjs',
    'templates/codex/global.config.toml',
    'templates/codex/repo-local.config.toml',
    'src/cli/index.mjs',
    'src/mcp/server.mjs',
  ]) {
    assert.ok(publishedFiles.has(requiredFile), `packed artifact must publish ${requiredFile}`);
  }

  const packDir = path.join(tempRoot, 'pack');
  const consumerDir = path.join(tempRoot, 'consumer');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  const packed = runNpm(['pack', '--json', repoRoot], { cwd: packDir });
  assert.equal(packed.status, 0, packed.stderr);

  const packedMeta = parsePackJson(packed.stdout);
  const tarballPath = path.join(packDir, packedMeta.filename);
  assert.equal(existsSync(tarballPath), true, 'npm pack must generate a tarball');

  const init = runNpm(['init', '-y'], { cwd: consumerDir });
  assert.equal(init.status, 0, init.stderr);

  const install = runNpm(['install', tarballPath], { cwd: consumerDir });
  assert.equal(install.status, 0, install.stderr);

  const installedManifest = JSON.parse(
    readFileSync(path.join(consumerDir, 'node_modules', 'modly-cli-mcp', 'package.json'), 'utf8'),
  );

  assert.ok(!('main' in installedManifest), 'installed package must not declare a root main entrypoint');
  assert.ok(!('exports' in installedManifest && installedManifest.exports?.['.'] !== undefined), 'installed package must not advertise a supported package-root import');

  const binDir = path.join(consumerDir, 'node_modules', '.bin');
  const modlyBin = path.join(binDir, process.platform === 'win32' ? 'modly.cmd' : 'modly');
  const modlyMcpBin = path.join(binDir, process.platform === 'win32' ? 'modly-mcp.cmd' : 'modly-mcp');

  assert.equal(existsSync(modlyBin), true, 'installed package must expose the modly bin');
  assert.equal(existsSync(modlyMcpBin), true, 'installed package must expose the modly-mcp bin');

  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
  };

  const modlyHelp = run(process.platform === 'win32' ? 'modly.cmd' : 'modly', ['--help'], { cwd: consumerDir, env });
  assert.equal(modlyHelp.status, 0, modlyHelp.stderr);
  assert.match(modlyHelp.stdout, /modly/u);

  const modlyMcpHelp = run(process.platform === 'win32' ? 'modly-mcp.cmd' : 'modly-mcp', ['--help'], { cwd: consumerDir, env });
  assert.notEqual(modlyMcpHelp.status, null, modlyMcpHelp.stderr);
  assert.match(`${modlyMcpHelp.stdout}\n${modlyMcpHelp.stderr}`, /modly-mcp/u);
  assert.match(`${modlyMcpHelp.stdout}\n${modlyMcpHelp.stderr}`, /stdio/u);

  const installedTemplate = JSON.parse(readFileSync(path.join(consumerDir, 'node_modules', 'modly-cli-mcp', 'templates', 'opencode', 'opencode.json'), 'utf8'));
  const installedRepoLocalTemplate = JSON.parse(readFileSync(path.join(consumerDir, 'node_modules', 'modly-cli-mcp', 'templates', 'opencode', 'repo-local.opencode.json'), 'utf8'));
  assert.equal(installedTemplate.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(installedRepoLocalTemplate.skills.paths, ['node_modules/modly-cli-mcp/skills']);

  const installedOperatorSkill = readFileSync(path.join(consumerDir, 'node_modules', 'modly-cli-mcp', 'skills', 'modly-operator', 'SKILL.md'), 'utf8');
  assert.match(installedOperatorSkill, /^---\nname: modly-operator/um);

  const installedCodexGlobalTemplate = readFileSync(path.join(consumerDir, 'node_modules', 'modly-cli-mcp', 'templates', 'codex', 'global.config.toml'), 'utf8');
  const installedCodexRepoLocalTemplate = readFileSync(path.join(consumerDir, 'node_modules', 'modly-cli-mcp', 'templates', 'codex', 'repo-local.config.toml'), 'utf8');
  assert.match(installedCodexGlobalTemplate, /command = "modly-mcp"/u);
  assert.match(installedCodexRepoLocalTemplate, /command = "node"/u);
  assert.match(installedCodexRepoLocalTemplate, /args = \["tools\/modly_mcp\/run_server\.mjs"\]/u);
});
