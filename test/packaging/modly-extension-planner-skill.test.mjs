import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const skillPath = path.join(repoRoot, 'skills/modly-extension-planner/SKILL.md');
const skill = readFileSync(skillPath, 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function listSkillFiles(directory) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry);
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      files.push(...listSkillFiles(absolutePath));
      continue;
    }

    if (entry === 'SKILL.md') {
      files.push(absolutePath);
    }
  }

  return files;
}

function assertSkillMentionsAll(label, terms) {
  for (const term of terms) {
    assert.match(skill, term, `${label} must include ${term}`);
  }
}

test('modly extension planner remains a single in-place skill', () => {
  const skillFiles = listSkillFiles(path.join(repoRoot, 'skills'));
  const matchingSkills = skillFiles.filter((file) => {
    const content = readFileSync(file, 'utf8');
    return /^---\nname: modly-extension-planner\b/um.test(content);
  });

  assert.deepEqual(
    matchingSkills.map((file) => path.relative(repoRoot, file)),
    ['skills/modly-extension-planner/SKILL.md'],
  );
  assert.doesNotMatch(skill, /version:\s*["']?1\.0["']?/u, 'planner skill must be evolved beyond v1');
});

test('modly extension planner declares all v2 workflow sections', () => {
  assertSkillMentionsAll('planner v2 sections', [
    /^## When to Use$/m,
    /^## Critical Rules$/m,
    /^## Input Contract$/m,
    /^## Workflow$/m,
    /^## Evidence Lookup$/m,
    /^## Fallback Public-Source Review Checklist$/m,
    /^## Output Contract$/m,
    /^## V1 ext-dev Boundaries$/m,
    /^## Forbidden Claims$/m,
    /^## Output Checklist$/m,
  ]);
});

test('modly extension planner documents the required JSON-first output contract', () => {
  assert.match(skill, /JSON-first/iu);
  assertSkillMentionsAll('planner output contract', [
    /`plan`/u,
    /`human_summary`/u,
    /`evidence_trace`/u,
    /`platform_matrix`/u,
    /`dependency_lanes`/u,
    /`model_weights_plan`/u,
    /`risks_unknowns`/u,
    /`blocked_claims`/u,
    /`assumptions`/u,
    /`next_steps`/u,
    /`not_a_compatibility_guarantee`/u,
  ]);
});

test('modly extension planner treats the dependency library as evidence only with fallback handling', () => {
  assertSkillMentionsAll('dependency-library evidence guidance', [
    /docs\/extension-dependency-library\//u,
    /evidence-only/iu,
    /not .*compatibility (?:oracle|guarantee)|not a compatibility (?:oracle|guarantee)/iu,
    /non-packaged|not packaged|not package/iu,
    /unavailable|absent|missing/iu,
    /stale/iu,
    /fallback/iu,
  ]);
});

test('modly extension planner reads dependency_groups packages instead of a flat dependencies field', () => {
  assertSkillMentionsAll('dependency inventory shape guidance', [
    /entry\.dependency_groups\[\]\.packages\[\]/u,
    /do not expect or invent a flat `dependencies` field/iu,
    /`id`, `kind`, `scope`, `purpose`, and `accelerator_lanes`/u,
    /`name`, `specifier`, `native_abi_risk`, `source`, `confidence`, `evidence_ids`, `optional`, `fallback`, and `build_mode`/u,
    /upstream_requirements\.stack_lanes\[\]\.packages\[\]/u,
    /separate from inventory packages|exact-stack lane context/iu,
  ]);
});

test('modly extension planner blocks dangerous unsupported claims', () => {
  assertSkillMentionsAll('forbidden-claim guards', [
    /AMD\/ROCm/iu,
    /UltraShape/iu,
    /fabricated .*model IDs|model IDs.*fabricated|canonical .*\/model\/all/iu,
    /local absolute paths|absolute local paths/iu,
    /`file:\/\/`|file:\/\//u,
    /traversal|`\.\.`/iu,
    /private identifiers|private refs|private repository/iu,
    /headless .*Electron|Electron-only .*headless/iu,
    /compatibility guarantee/iu,
  ]);
});

test('modly extension planner preserves v1 ext-dev and architecture boundaries', () => {
  assertSkillMentionsAll('v1 boundary contract', [
    /manifest\.json/u,
    /modly ext-dev/u,
    /model-simple/u,
    /model-managed-setup/u,
    /process-extension/u,
    /mandatory metadata/iu,
    /resolution/u,
    /implementation_profile/u,
    /setup_contract/u,
    /support_state/u,
    /surface_owner/u,
    /headless_eligible/u,
    /linux_arm64_risk/u,
    /plan-only/iu,
    /FastAPI/u,
    /Electron/u,
  ]);
});

test('modly extension planner documents the functional GitHub install and setup seam', () => {
  assertSkillMentionsAll('functional install/setup seam', [
    /^## Functional Modly Extension Contract$/m,
    /modly ext stage github.*preflight|stage github.*preflight/iu,
    /modly ext apply.*live install seam|apply.*live install seam/iu,
    /modly ext repair.*reapplies|repair.*prepared stage/iu,
    /modly ext setup.*not a universal installer|setup.*explicit, limited setup contract/iu,
    /modly ext setup-status.*observes local setup state|setup-status.*observer/iu,
    /applied_degraded/iu,
    /separate Modly seam success from extension setup\/runtime failure/iu,
  ]);
});

test('modly extension planner gives creation guidance for root manifest generator setup assets and runtime contracts', () => {
  assertSkillMentionsAll('functional extension artifact contract', [
    /root-level artifacts/iu,
    /`manifest\.json`.*required identity|required identity.*`manifest\.json`/iu,
    /`generator\.py`.*`generator_class`|`generator_class`.*`generator\.py`/iu,
    /process entrypoints.*`manifest\.process`|`manifest\.process`.*process entrypoints/iu,
    /`setup\.py`.*manifest\.setup|manifest\.setup.*`setup\.py`/iu,
    /Modly-injected JSON context/iu,
    /Modly packaged-app `cp311` on Windows/iu,
    /release-backed wheelhouse/iu,
    /checksum verification/iu,
    /--no-index --find-links/u,
    /no silent PyPI fallback/iu,
    /pip check/iu,
    /import probes/iu,
    /Windows reserved segments.*`AUX`.*`CON`.*`NUL`.*`PRN`/isu,
    /root `generator\.py` exposes the manifest `generator_class`/iu,
    /is_downloaded\(\).*sentinel files|sentinel files.*is_downloaded\(\)/iu,
    /final artifact path/iu,
    /diagnostic checkpoints/iu,
    /GLB.*nonzero geometry|nonzero geometry.*GLB/iu,
    /For process-extension plans/iu,
    /inputs, outputs, logs, progress, cancellation expectations, and artifact validation/iu,
  ]);
});

test('modly extension planner encodes a release validation ladder and candidate lane policy', () => {
  assertSkillMentionsAll('release validation ladder', [
    /Release and validation ladder/iu,
    /static contract checks/iu,
    /full setup on target lane/iu,
    /model asset download\/readiness checks/iu,
    /first real generation smoke test/iu,
    /artifact validation and workspace fetch/iu,
    /candidate\/pre-release lanes remain opt-in and outside the stable manifest/iu,
    /community-provided.*platform\/GPU\/driver\/VRAM/iu,
  ]);
});

test('modly extension planner uses library entries as reference extension patterns without overclaiming', () => {
  assertSkillMentionsAll('reference extension patterns', [
    /^## Reference Extension Patterns$/m,
    /drhepa-pixal3d/u,
    /Release-backed CUDA model extension/iu,
    /model-managed-setup/iu,
    /candidate Blackwell lanes stay opt-in until validated/iu,
    /TRELLIS, TripoSG, Hunyuan3D entries/iu,
    /drhepa-kimodo.*drhepa-unirig|drhepa-unirig.*drhepa-kimodo/isu,
    /sd15.*sdxl-base.*flux-schnell|flux-schnell.*sd15.*sdxl-base/isu,
    /what extensions exist/iu,
    /list entry ids, repo identities, relationship, platform statuses, dependency summary/iu,
    /do not infer Windows\/Linux\/AMD support from family similarity/iu,
  ]);
});

test('dependency library remains outside published package files', () => {
  assert.ok(!packageJson.files.includes('docs/extension-dependency-library/**'));
  assert.ok(!packageJson.files.some((entry) => entry.startsWith('docs/extension-dependency-library')));
});
