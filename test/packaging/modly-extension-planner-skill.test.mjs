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

test('dependency library remains outside published package files', () => {
  assert.ok(!packageJson.files.includes('docs/extension-dependency-library/**'));
  assert.ok(!packageJson.files.some((entry) => entry.startsWith('docs/extension-dependency-library')));
});
