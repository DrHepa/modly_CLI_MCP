import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const FIXTURES_DIR = path.resolve('test/fixtures/workflow-recipes');

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'));
}

function getNodeTypes(workflow) {
  return workflow.nodes.map((node) => node.type);
}

test('eligible workflow fixtures keep explicit template naming and supported model steps', () => {
  const hunyuan = readFixture('eligible-hunyuan');
  const triposg = readFixture('eligible-triposg');

  assert.equal(hunyuan.name, 'Recipe Hunyuan3d / Template');
  assert.ok(getNodeTypes(hunyuan).includes('hunyuan3d-mini/generate'));
  assert.equal(triposg.name, 'Recipe TripoSG / Template');
  assert.ok(getNodeTypes(triposg).includes('triposg/generate'));
});

test('invalid workflow fixtures cover unsupported node and executable branching cases', () => {
  const invalidTextNode = readFixture('invalid-text-node');
  const invalidBranch = readFixture('invalid-branch');

  assert.ok(getNodeTypes(invalidTextNode).includes('textNode'));

  const branchFromGenerate = invalidBranch.edges.filter((edge) => edge.from === 'generate');
  assert.equal(branchFromGenerate.length, 2);
  assert.deepEqual(
    branchFromGenerate.map((edge) => edge.to).sort(),
    ['export-secondary', 'optimize'],
  );
});
