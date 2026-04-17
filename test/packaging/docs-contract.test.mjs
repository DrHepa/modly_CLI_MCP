import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

const packageJson = readJson('package.json');
const readme = readText('README.md');
const globalDoc = readText('docs/install/global.md');
const repoLocalDoc = readText('docs/install/repo-local.md');
const operatorSkill = readText('skills/modly-operator/SKILL.md');
const template = readJson('templates/opencode/opencode.json');

function assertExperimentalRecipeContract(name, content) {
  assert.match(content, /`modly\.recipe\.execute`/u, `${name} must name modly.recipe.execute explicitly`);
  assert.match(content, /experimental/iu, `${name} must describe recipe execution as experimental`);
  assert.match(content, /opt-?in/iu, `${name} must describe recipe execution as opt-in`);
  assert.match(content, /hidden by default/iu, `${name} must state recipe execution is hidden by default`);
  assert.match(content, /disabled unless/iu, `${name} must state recipe execution is disabled unless the flag is set`);
  assert.match(content, /MODLY_EXPERIMENTAL_RECIPE_EXECUTE/u, `${name} must use the exact recipe opt-in flag name`);
}

test('package bins and published assets stay aligned with the packaging contract', () => {
  assert.deepEqual(Object.keys(packageJson.bin).sort(), ['modly', 'modly-mcp']);
  assert.equal(packageJson.bin.modly, 'src/cli/index.mjs');
  assert.equal(packageJson.bin['modly-mcp'], 'src/mcp/server.mjs');

  assert.deepEqual(packageJson.files, [
    'src/**',
    'README.md',
    'LICENSE',
    'docs/install/**',
    'templates/opencode/**',
  ]);
});

test('OpenCode template uses the verified schema and consumable modly-mcp command', () => {
  assert.ok(!('mcpServers' in template));
  assert.equal(template.$schema, 'https://opencode.ai/config.json');
  assert.ok('mcp' in template);
  assert.deepEqual(Object.keys(template.mcp), ['modly']);
  assert.equal(template.mcp.modly.type, 'local');
  assert.equal(template.mcp.modly.enabled, true);
  assert.equal(template.mcp.modly.timeout, 30000);
  assert.deepEqual(template.mcp.modly.command, ['modly-mcp']);
});

test('docs and README stay aligned with supported global and repo-local flows', () => {
  for (const [name, content] of [
    ['README.md', readme],
    ['docs/install/global.md', globalDoc],
    ['docs/install/repo-local.md', repoLocalDoc],
  ]) {
    assert.ok(!/"mcpServers"\s*:/u.test(content), `${name} must not use mcpServers as config root`);
    assert.match(content, /checkout fuente|source checkout/u, `${name} must explicitly forbid source-checkout integration`);
  }

  assert.match(readme, /`modly`/u);
  assert.match(readme, /`modly-mcp`/u);
  assert.match(readme, /https:\/\/opencode\.ai\/config\.json/u);
  assert.match(readme, /"mcp": \{/u);
  assert.match(readme, /"type": "local"/u);
  assert.match(readme, /"enabled": true/u);
  assert.match(readme, /"timeout": 30000/u);
  assert.match(readme, /\["\.\.\."\]/u);
  assert.match(readme, /templates\/opencode\/run_server\.mjs/u);
  assert.match(readme, /`workflow-run wait`/u);
  assert.match(readme, /`modly\.workflowRun\.wait`/u);
  assert.match(readme, /do \*\*not\*\* imply workflow management, \*\*Add to Scene\*\*, or blocking `from-image` behavior/u);
  assertExperimentalRecipeContract('README.md', readme);

  assert.match(globalDoc, /`modly` and `modly-mcp`/u);
  assert.match(globalDoc, /npm install -g modly-cli-mcp/u);
  assert.match(globalDoc, /modly --help/u);
  assert.match(globalDoc, /modly-mcp --help/u);
  assert.match(globalDoc, /https:\/\/opencode\.ai\/config\.json/u);
  assert.match(globalDoc, /"command": \["modly-mcp"\]/u);
  assert.match(globalDoc, /\*\*not\*\* `mcpServers`|not `mcpServers`/iu);
  assertExperimentalRecipeContract('docs/install/global.md', globalDoc);

  assert.match(repoLocalDoc, /tools\/modly_mcp\/run_server\.mjs/u);
  assert.match(repoLocalDoc, /node_modules\/.bin\/modly-mcp/u);
  assert.match(repoLocalDoc, /tools\/_tmp\/modly_mcp\/local\.env/u);
  assert.match(repoLocalDoc, /node tools\/modly_mcp\/run_server\.mjs --check/u);
  assert.match(repoLocalDoc, /https:\/\/opencode\.ai\/config\.json/u);
  assert.match(repoLocalDoc, /does \*\*not\*\* use `dotenv`/u);
  assertExperimentalRecipeContract('docs/install/repo-local.md', repoLocalDoc);
});

test('operator skill documents the same experimental recipe opt-in contract', () => {
  assertExperimentalRecipeContract('skills/modly-operator/SKILL.md', operatorSkill);
});
