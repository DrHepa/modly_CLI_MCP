import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflowPath = path.join(workflowsDir, 'ci.yml');

function listWorkflowFiles() {
  if (!existsSync(workflowsDir)) {
    return [];
  }

  return readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort();
}

function readWorkflowText() {
  assert.ok(existsSync(workflowPath), 'baseline CI workflow must exist at .github/workflows/ci.yml');
  return readFileSync(workflowPath, 'utf8');
}

function extractRunCommands(workflowText) {
  return [...workflowText.matchAll(/^\s+run:\s*(.+)$/gmu)].map((match) => match[1].trim());
}

test('baseline CI workflow exists as the only workflow introduced for this change', () => {
  assert.deepEqual(listWorkflowFiles(), ['ci.yml']);
});

test('workflow triggers on pull requests and pushes to main and dev only', () => {
  const workflowText = readWorkflowText();

  assert.match(workflowText, /^on:\s*\n\s+pull_request:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- main\s*\n\s+- dev\s*$/mu);
});

test('workflow uses a single Node 20 runtime without matrix expansion', () => {
  const workflowText = readWorkflowText();

  assert.match(workflowText, /uses:\s*actions\/setup-node@/u);
  assert.match(workflowText, /node-version:\s*20\b/u);
  assert.doesNotMatch(workflowText, /\bmatrix:\b/u);
});

test('workflow runs the mandatory commands in the approved order', () => {
  const workflowText = readWorkflowText();

  assert.deepEqual(extractRunCommands(workflowText), [
    'npm ci',
    'npm test',
    'npm run lint',
    'npm run type-check',
  ]);
});

test('workflow keeps each command as a separate failing step without out-of-scope behavior', () => {
  const workflowText = readWorkflowText();

  assert.equal((workflowText.match(/^\s+run:\s*/gmu) ?? []).length, 4);
  assert.doesNotMatch(workflowText, /continue-on-error:\s*true/u);
  assert.doesNotMatch(workflowText, /\bcache:\b/u);
});
