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
const codexGlobalDoc = readText('docs/install/codex-global.md');
const codexRepoLocalDoc = readText('docs/install/codex-repo-local.md');
const mvpSpec = readText('docs/specs/modly-cli-mvp.md');
const operatorSkill = readText('skills/modly-operator/SKILL.md');
const plannerSkill = readText('skills/modly-extension-planner/SKILL.md');
const template = readJson('templates/opencode/opencode.json');
const codexGlobalTemplate = readText('templates/codex/global.config.toml');
const codexRepoLocalTemplate = readText('templates/codex/repo-local.config.toml');

function assertExperimentalRecipeContract(name, content) {
  assert.match(content, /`modly\.recipe\.execute`/u, `${name} must name modly.recipe.execute explicitly`);
  assert.match(content, /experimental/iu, `${name} must describe recipe execution as experimental`);
  assert.match(content, /opt-?in/iu, `${name} must describe recipe execution as opt-in`);
  assert.match(content, /hidden by default/iu, `${name} must state recipe execution is hidden by default`);
  assert.match(content, /disabled unless/iu, `${name} must state recipe execution is disabled unless the flag is set`);
  assert.match(content, /MODLY_EXPERIMENTAL_RECIPE_EXECUTE/u, `${name} must use the exact recipe opt-in flag name`);
}

function assertExecutionSurfaceTaxonomy(name, content) {
  assert.match(content, /canonical run primitive/iu, `${name} must name canonical run primitives explicitly`);
  assert.match(content, /orchestration wrapper/iu, `${name} must describe wrappers explicitly`);
  assert.match(content, /legacy compatibility/iu, `${name} must describe legacy compatibility explicitly`);
  assert.match(content, /workflow-run/u, `${name} must mention workflow-run`);
  assert.match(content, /process-run/u, `${name} must mention process-run`);
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
    'templates/codex/**',
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

test('Codex templates use the verified config root and consumable modly-mcp/wrapper commands', () => {
  assert.match(codexGlobalTemplate, /\[mcp_servers\.modly\]/u);
  assert.match(codexGlobalTemplate, /command = "modly-mcp"/u);
  assert.match(codexRepoLocalTemplate, /\[mcp_servers\.modly\]/u);
  assert.match(codexRepoLocalTemplate, /command = "node"/u);
  assert.match(codexRepoLocalTemplate, /args = \["tools\/modly_mcp\/run_server\.mjs"\]/u);
});

test('docs and README stay aligned with supported OpenCode and Codex install flows', () => {
  for (const [name, content] of [
    ['README.md', readme],
    ['docs/install/global.md', globalDoc],
    ['docs/install/repo-local.md', repoLocalDoc],
    ['docs/install/codex-global.md', codexGlobalDoc],
    ['docs/install/codex-repo-local.md', codexRepoLocalDoc],
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
  assert.match(readme, /"command": \["modly-mcp"\]/u);
  assert.match(readme, /"node",\s+"tools\/modly_mcp\/run_server\.mjs"/u);
  assert.match(readme, /OpenCode/u);
  assert.match(readme, /Codex/u);
  assert.match(readme, /~\/\.codex\/config\.toml/u);
  assert.match(readme, /`\.codex\/config\.toml`/u);
  assert.match(readme, /trusted project/iu);
  assert.match(readme, /templates\/opencode\/run_server\.mjs/u);
  assert.match(readme, /templates\/codex\/global\.config\.toml/u);
  assert.match(readme, /templates\/codex\/repo-local\.config\.toml/u);
  assert.match(readme, /`workflow-run wait`/u);
  assert.match(readme, /`modly\.workflowRun\.wait`/u);
  assert.match(readme, /do \*\*not\*\* imply workflow management, \*\*Add to Scene\*\*, or blocking `from-image` behavior/u);
  assertExperimentalRecipeContract('README.md', readme);
  assertExecutionSurfaceTaxonomy('README.md', readme);

  assert.match(globalDoc, /`modly` and `modly-mcp`/u);
  assert.match(globalDoc, /npm install -g modly-cli-mcp/u);
  assert.match(globalDoc, /modly --help/u);
  assert.match(globalDoc, /modly-mcp --help/u);
  assert.match(globalDoc, /https:\/\/opencode\.ai\/config\.json/u);
  assert.match(globalDoc, /"command": \["modly-mcp"\]/u);
  assert.match(globalDoc, /\*\*not\*\* `mcpServers`|not `mcpServers`/iu);
  assertExperimentalRecipeContract('docs/install/global.md', globalDoc);
  assertExecutionSurfaceTaxonomy('docs/install/global.md', globalDoc);

  assert.match(repoLocalDoc, /tools\/modly_mcp\/run_server\.mjs/u);
  assert.match(repoLocalDoc, /node_modules\/.bin\/modly-mcp/u);
  assert.match(repoLocalDoc, /tools\/_tmp\/modly_mcp\/local\.env/u);
  assert.match(repoLocalDoc, /node tools\/modly_mcp\/run_server\.mjs --check/u);
  assert.match(repoLocalDoc, /https:\/\/opencode\.ai\/config\.json/u);
  assert.match(repoLocalDoc, /does \*\*not\*\* use `dotenv`/u);
  assertExperimentalRecipeContract('docs/install/repo-local.md', repoLocalDoc);
  assertExecutionSurfaceTaxonomy('docs/install/repo-local.md', repoLocalDoc);
  assert.match(codexGlobalDoc, /~\/\.codex\/config\.toml/u);
  assert.match(codexGlobalDoc, /codex mcp add modly -- modly-mcp/u);
  assert.match(codexGlobalDoc, /command = "modly-mcp"/u);
  assert.match(codexGlobalDoc, /MODLY_API_URL/u);
  assert.match(codexGlobalDoc, /MODLY_AUTOMATION_URL/u);
  assert.match(codexGlobalDoc, /MODLY_PROCESS_URL/u);
  assertExperimentalRecipeContract('docs/install/codex-global.md', codexGlobalDoc);
  assertExecutionSurfaceTaxonomy('docs/install/codex-global.md', codexGlobalDoc);

  assert.match(codexRepoLocalDoc, /`\.codex\/config\.toml`/u);
  assert.match(codexRepoLocalDoc, /trusted project/iu);
  assert.match(codexRepoLocalDoc, /tools\/modly_mcp\/run_server\.mjs/u);
  assert.match(codexRepoLocalDoc, /tools\/_tmp\/modly_mcp\/local\.env/u);
  assert.match(codexRepoLocalDoc, /node tools\/modly_mcp\/run_server\.mjs --check/u);
  assert.match(codexRepoLocalDoc, /local-first/u);
  assert.match(codexRepoLocalDoc, /global-fallback|falls back to a global/u);
  assert.match(codexRepoLocalDoc, /command = "node"/u);
  assert.match(codexRepoLocalDoc, /args = \["tools\/modly_mcp\/run_server\.mjs"\]/u);
  assertExperimentalRecipeContract('docs/install/codex-repo-local.md', codexRepoLocalDoc);
  assertExecutionSurfaceTaxonomy('docs/install/codex-repo-local.md', codexRepoLocalDoc);
  assertExecutionSurfaceTaxonomy('docs/specs/modly-cli-mvp.md', mvpSpec);
});

test('README documents the root package as bin-only without root or deep import support', () => {
  assert.doesNotMatch(readme, /`src\/core\/\*`/u, 'README.md must not advertise src/core/* as public package surface');
  assert.match(readme, /bin-only/u, 'README.md must call the root package bin-only explicitly');
  assert.match(readme, /root imports?[^\n]*not supported|package root imports?[^\n]*not supported/u, 'README.md must state that package-root imports are not supported');
  assert.match(readme, /deep imports?[^\n]*not supported|`src\/` imports?[^\n]*not supported/u, 'README.md must state that deep imports are not supported');
});

test('README and MVP spec separate ext runtime from ext-dev planning in V1', () => {
  for (const [name, content] of [
    ['README.md', readme],
    ['docs/specs/modly-cli-mvp.md', mvpSpec],
  ]) {
    assert.match(content, /`ext-dev`/u, `${name} must mention ext-dev explicitly`);
    assert.match(content, /plan-only/iu, `${name} must describe ext-dev as plan-only`);
    assert.match(content, /manifest\.json/u, `${name} must document manifest.json-only scope for V1`);
    assert.match(content, /model-simple/u, `${name} must document the model-simple bucket`);
    assert.match(content, /model-managed-setup/u, `${name} must document the model-managed-setup bucket`);
    assert.match(content, /process-extension/u, `${name} must document the process-extension bucket`);
    assert.match(content, /resolution/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /implementation_profile/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /setup_contract/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /support_state/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /surface_owner/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /headless_eligible/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /linux_arm64_risk/u, `${name} must mention mandatory metadata keys`);
    assert.match(content, /does \*\*not\*\* install, build, release, or repair|does not install, build, release, or repair|no instala, build, release ni repair/u, `${name} must keep ext-dev strictly plan-only`);
    assert.match(content, /FastAPI/u, `${name} must mention FastAPI boundaries`);
    assert.match(content, /Electron/u, `${name} must mention Electron boundaries`);
  }

  assert.match(readme, /`ext`.*runtime|runtime.*`ext`/isu, 'README.md must describe ext as the runtime-oriented surface');
  assert.match(mvpSpec, /`ext`.*runtime|runtime.*`ext`/isu, 'docs/specs/modly-cli-mvp.md must describe ext as the runtime-oriented surface');
  assert.match(readme, /`bucket-detect`/u, 'README.md must document ext-dev commands');
  assert.match(readme, /`preflight`/u, 'README.md must document ext-dev commands');
  assert.match(readme, /`scaffold`/u, 'README.md must document ext-dev commands');
  assert.match(readme, /`audit`/u, 'README.md must document ext-dev commands');
  assert.match(readme, /`release-plan`/u, 'README.md must document ext-dev commands');
});

test('operator skill documents the same experimental recipe opt-in contract', () => {
  assertExperimentalRecipeContract('skills/modly-operator/SKILL.md', operatorSkill);
});

test('modly extension planner skill stays aligned and registered in repo guidance', () => {
  assert.match(plannerSkill, /^---\nname: modly-extension-planner/um, 'planner skill must define frontmatter name');
  assert.match(plannerSkill, /Trigger:/u, 'planner skill must document trigger text');
  assert.match(plannerSkill, /plan-only/iu, 'planner skill must keep V1 plan-only');
  assert.match(plannerSkill, /manifest\.json/u, 'planner skill must document manifest.json-only scope');
  assert.match(plannerSkill, /model-simple/u, 'planner skill must document bucket heuristics');
  assert.match(plannerSkill, /model-managed-setup/u, 'planner skill must document bucket heuristics');
  assert.match(plannerSkill, /process-extension/u, 'planner skill must document bucket heuristics');
  assert.match(plannerSkill, /resolution/u, 'planner skill must document mandatory metadata');
  assert.match(plannerSkill, /surface_owner/u, 'planner skill must document mandatory metadata');
  assert.match(plannerSkill, /JSON/u, 'planner skill must prefer JSON output');
  assert.match(plannerSkill, /FastAPI/u, 'planner skill must mention FastAPI boundaries');
  assert.match(plannerSkill, /Electron/u, 'planner skill must mention Electron boundaries');
  assert.match(readme, /modly-extension-planner/u, 'README.md must register the new planner skill in repo guidance');
});
