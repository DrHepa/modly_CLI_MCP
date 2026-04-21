import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  deriveWorkflowRecipeSnapshotFromFile,
  listWorkflowRecipeCatalog,
  resolveDerivedRecipeSnapshotForExecution,
  revalidateDerivedRecipeSnapshot,
  validateWorkflowRecipeDocument,
} from '../../src/mcp/tools/internal/workflow-recipe-catalog.mjs';
import { ValidationError } from '../../src/core/errors.mjs';

const FIXTURES_DIR = path.resolve('test/fixtures/workflow-recipes');

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toStoredModlyWorkflow(workflow) {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.type === 'imageNode' || node.type === 'outputNode') {
        return node;
      }

      return {
        ...node,
        type: 'extensionNode',
        data: {
          ...node.data,
          extensionId: node.type,
        },
      };
    }),
    edges: workflow.edges.map((edge) => ({
      source: edge.from,
      target: edge.to,
    })),
  };
}

test('validateWorkflowRecipeDocument accepts the eligible workflow subset for Hunyuan and TripoSG fixtures', () => {
  const hunyuan = validateWorkflowRecipeDocument(readFixture('eligible-hunyuan'));
  const triposg = validateWorkflowRecipeDocument(readFixture('eligible-triposg'));

  assert.deepEqual(hunyuan, {
    displayName: 'Recipe Hunyuan3d / Template',
    modelId: 'hunyuan3d-mini',
    steps: ['generate_mesh', 'optimize_mesh', 'export_mesh'],
  });

  assert.deepEqual(triposg, {
    displayName: 'Recipe TripoSG / Template',
    modelId: 'triposg',
    steps: ['generate_mesh', 'optimize_mesh', 'export_mesh'],
  });
});

test('validateWorkflowRecipeDocument accepts the real Modly stored workflow shape with extensionNode and source/target edges', () => {
  const hunyuan = validateWorkflowRecipeDocument(toStoredModlyWorkflow(readFixture('eligible-hunyuan')));
  const triposg = validateWorkflowRecipeDocument(toStoredModlyWorkflow(readFixture('eligible-triposg')));

  assert.deepEqual(hunyuan, {
    displayName: 'Recipe Hunyuan3d / Template',
    modelId: 'hunyuan3d-mini',
    steps: ['generate_mesh', 'optimize_mesh', 'export_mesh'],
  });

  assert.deepEqual(triposg, {
    displayName: 'Recipe TripoSG / Template',
    modelId: 'triposg',
    steps: ['generate_mesh', 'optimize_mesh', 'export_mesh'],
  });
});

test('validateWorkflowRecipeDocument fails closed for unsupported nodes, executable branching, and multiple model steps', () => {
  assert.throws(
    () => validateWorkflowRecipeDocument(readFixture('invalid-text-node')),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details?.reason, 'unsupported_workflow_node');
      assert.equal(error.details?.nodeType, 'textNode');
      return true;
    },
  );

  assert.throws(
    () => validateWorkflowRecipeDocument(readFixture('invalid-branch')),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details?.reason, 'unsupported_workflow_branching');
      assert.equal(error.details?.from, 'generate');
      return true;
    },
  );

  const multipleModelSteps = clone(readFixture('eligible-triposg'));
  multipleModelSteps.nodes.push({ id: 'generate-secondary', type: 'hunyuan3d-mini/generate' });
  multipleModelSteps.edges.push({ from: 'image-input', to: 'generate-secondary' });

  assert.throws(
    () => validateWorkflowRecipeDocument(multipleModelSteps),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details?.reason, 'multiple_generate_steps');
      return true;
    },
  );
});

test('deriveWorkflowRecipeSnapshotFromFile derives a linear snapshot with source fingerprint and strips local input artifacts', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-workflow-recipe-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const workflow = clone(readFixture('eligible-hunyuan'));
  workflow.nodes[0].data = {
    ...workflow.nodes[0].data,
    filePath: '/tmp/local-input.png',
    previewUrl: 'file:///tmp/local-preview.png',
    preview: { width: 512, height: 512 },
  };

  const filePath = path.join(directory, 'eligible-hunyuan.json');
  const content = JSON.stringify(workflow, null, 2);
  await writeFile(filePath, content);
  const fileStat = await stat(filePath);

  const snapshot = await deriveWorkflowRecipeSnapshotFromFile(filePath, {
    relativePath: 'eligible-hunyuan.json',
  });

  assert.deepEqual(snapshot, {
    id: 'workflow/recipe-hunyuan3d-template',
    kind: 'derived',
    displayName: 'Recipe Hunyuan3d / Template',
    modelId: 'hunyuan3d-mini',
    sourceWorkflow: {
      relativePath: 'eligible-hunyuan.json',
      name: 'Recipe Hunyuan3d / Template',
      sha256: createHash('sha256').update(content).digest('hex'),
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    },
    steps: ['generate_mesh', 'optimize_mesh', 'export_mesh'],
    limits: {
      pollingFirst: true,
      branching: false,
      automaticRetries: false,
    },
  });

  assert.equal(Object.hasOwn(snapshot, 'previewUrl'), false);
  assert.equal(JSON.stringify(snapshot).includes('/tmp/local-input.png'), false);
  assert.equal(JSON.stringify(snapshot).includes('preview'), false);
});

test('validateWorkflowRecipeDocument supports the minimal generate-only subset', () => {
  const workflow = clone(readFixture('eligible-hunyuan'));
  workflow.nodes = workflow.nodes.filter((node) => !['optimize', 'export'].includes(node.id));
  workflow.edges = workflow.edges.filter((edge) => edge.from !== 'generate' && edge.from !== 'optimize');

  assert.deepEqual(validateWorkflowRecipeDocument(workflow), {
    displayName: 'Recipe Hunyuan3d / Template',
    modelId: 'hunyuan3d-mini',
    steps: ['generate_mesh'],
  });
});

test('listWorkflowRecipeCatalog returns only valid eligible derived snapshots from the explicit catalog directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-workflow-recipe-catalog-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(path.join(directory, 'eligible-hunyuan.json'), JSON.stringify(readFixture('eligible-hunyuan'), null, 2));
  await writeFile(path.join(directory, 'eligible-triposg.json'), JSON.stringify(readFixture('eligible-triposg'), null, 2));
  await writeFile(path.join(directory, 'invalid-text-node.json'), JSON.stringify(readFixture('invalid-text-node'), null, 2));
  await writeFile(path.join(directory, 'invalid-branch.json'), JSON.stringify(readFixture('invalid-branch'), null, 2));

  const hiddenWorkflow = clone(readFixture('eligible-hunyuan'));
  hiddenWorkflow.name = 'Test_Uni';
  await writeFile(path.join(directory, 'hidden.json'), JSON.stringify(hiddenWorkflow, null, 2));

  const catalog = await listWorkflowRecipeCatalog({ catalogDir: directory });

  assert.deepEqual(
    catalog.map((entry) => ({ id: entry.id, relativePath: entry.sourceWorkflow.relativePath, kind: entry.kind })),
    [
      {
        id: 'workflow/recipe-hunyuan3d-template',
        relativePath: 'eligible-hunyuan.json',
        kind: 'derived',
      },
      {
        id: 'workflow/recipe-triposg-template',
        relativePath: 'eligible-triposg.json',
        kind: 'derived',
      },
    ],
  );
});

test('resolveDerivedRecipeSnapshotForExecution resolves a stable derived recipe id from the explicit catalog directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-workflow-recipe-execution-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(path.join(directory, 'eligible-hunyuan.json'), JSON.stringify(readFixture('eligible-hunyuan'), null, 2));

  const snapshot = await resolveDerivedRecipeSnapshotForExecution('workflow/recipe-hunyuan3d-template', {
    catalogDir: directory,
  });

  assert.equal(snapshot.id, 'workflow/recipe-hunyuan3d-template');
  assert.equal(snapshot.kind, 'derived');
  assert.equal(snapshot.sourceWorkflow.relativePath, 'eligible-hunyuan.json');
  assert.deepEqual(snapshot.steps, ['generate_mesh', 'optimize_mesh', 'export_mesh']);
});

test('revalidateDerivedRecipeSnapshot fails closed when the source workflow drifts or leaves the eligible subset', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-workflow-recipe-revalidate-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const filePath = path.join(directory, 'eligible-hunyuan.json');
  await writeFile(filePath, JSON.stringify(readFixture('eligible-hunyuan'), null, 2));

  const snapshot = await deriveWorkflowRecipeSnapshotFromFile(filePath, {
    relativePath: 'eligible-hunyuan.json',
  });

  const drifted = clone(readFixture('eligible-hunyuan'));
  drifted.name = 'Recipe Hunyuan3d Drifted / Template';
  await writeFile(filePath, JSON.stringify(drifted, null, 2));

  await assert.rejects(
    () => revalidateDerivedRecipeSnapshot(snapshot, { catalogDir: directory }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details?.reason, 'derived_recipe_drift');
      assert.equal(error.details?.recipe, 'workflow/recipe-hunyuan3d-template');
      return true;
    },
  );

  await writeFile(filePath, JSON.stringify(readFixture('invalid-text-node'), null, 2));

  await assert.rejects(
    () => revalidateDerivedRecipeSnapshot(snapshot, { catalogDir: directory }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details?.reason, 'derived_recipe_revalidation_failed');
      assert.equal(error.details?.recipe, 'workflow/recipe-hunyuan3d-template');
      return true;
    },
  );
});
