import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { deriveWorkflowRecipeSnapshotFromFile } from '../../src/mcp/tools/internal/workflow-recipe-catalog.mjs';
import { resolveRecipeRuntime } from '../../src/mcp/tools/internal/recipe-runtime.mjs';

const FIXTURES_DIR = path.resolve('test/fixtures/workflow-recipes');

test('resolveRecipeRuntime accepts a derived workflow snapshot object without allowing raw workflow ids yet', async () => {
  const snapshot = await deriveWorkflowRecipeSnapshotFromFile(path.join(FIXTURES_DIR, 'eligible-hunyuan.json'), {
    relativePath: 'eligible-hunyuan.json',
  });

  const runtime = resolveRecipeRuntime(snapshot);

  assert.equal(runtime.id, 'workflow/recipe-hunyuan3d-template');
  assert.equal(runtime.kind, 'derived');
  assert.deepEqual(runtime.steps.map((step) => step.id), ['generate_mesh', 'optimize_mesh', 'export_mesh']);
  assert.deepEqual(runtime.steps.map((step) => step.surface), [
    'modly.workflowRun.createFromImage',
    'modly.processRun.create',
    'modly.processRun.create',
  ]);
});
