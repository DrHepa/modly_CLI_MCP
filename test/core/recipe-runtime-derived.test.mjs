import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { deriveWorkflowRecipeSnapshotFromFile } from '../../src/mcp/tools/internal/workflow-recipe-catalog.mjs';
import {
  buildRecipeSteps,
  parseRecipeResume,
  resolveRecipeRuntime,
  updateRecipeStepFromRun,
} from '../../src/mcp/tools/internal/recipe-runtime.mjs';

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

test('parseRecipeResume treats null step.error as absent to allow safe resume from real MCP responses', () => {
  const resume = parseRecipeResume({
    steps: [
      {
        id: 'generate_mesh',
        status: 'running',
        error: null,
        run: {
          kind: 'workflowRun',
          runId: 'run-123',
          status: 'pending',
        },
      },
    ],
  });

  assert.deepEqual(resume, {
    steps: [
      {
        id: 'generate_mesh',
        status: 'running',
        run: {
          kind: 'workflowRun',
          runId: 'run-123',
          status: 'pending',
        },
      },
    ],
  });
});

async function loadDerivedRuntime() {
  const snapshot = await deriveWorkflowRecipeSnapshotFromFile(path.join(FIXTURES_DIR, 'eligible-hunyuan.json'), {
    relativePath: 'eligible-hunyuan.json',
  });

  return resolveRecipeRuntime(snapshot);
}

function advanceGenerateMeshStep(runtime, run) {
  const [generateStepDefinition] = runtime.steps;
  const [generateStep] = buildRecipeSteps(runtime);

  return updateRecipeStepFromRun(generateStep, generateStepDefinition, run, runtime);
}

test('derived workflow outputs keep sceneCandidate.path precedence over local output_url and preserve meshPath on resume', async () => {
  const runtime = await loadDerivedRuntime();
  const updatedStep = advanceGenerateMeshStep(runtime, {
    run_id: 'derived-run-precedence',
    status: 'done',
    scene_candidate: { path: 'workspace/from-scene.glb' },
    output_url: 'Default/generated.glb',
  });

  assert.deepEqual(updatedStep.outputs, {
    meshPath: 'workspace/from-scene.glb',
    exportUrl: 'Default/generated.glb',
    sceneCandidate: { path: 'workspace/from-scene.glb' },
  });

  const [resumedStep] = buildRecipeSteps(runtime, {
    steps: [updatedStep],
  });

  assert.equal(resumedStep.outputs.meshPath, 'workspace/from-scene.glb');
});

test('derived workflow outputs materialize meshPath from a local relative output_url when no sceneCandidate.path exists', async () => {
  const runtime = await loadDerivedRuntime();
  const updatedStep = advanceGenerateMeshStep(runtime, {
    run_id: 'derived-run-relative-output-url',
    status: 'done',
    output_url: 'Default/generated.glb',
  });

  assert.deepEqual(updatedStep.outputs, {
    meshPath: 'Default/generated.glb',
    exportUrl: 'Default/generated.glb',
  });
});

test('derived workflow outputs materialize meshPath from sceneCandidate.workspace_path before falling back to output_url', async () => {
  const runtime = await loadDerivedRuntime();
  const updatedStep = advanceGenerateMeshStep(runtime, {
    run_id: 'derived-run-scene-workspace-path',
    status: 'done',
    scene_candidate: {
      workspace_path: 'Default/generated.glb',
      output_url: '/workspace/Default/generated.glb',
    },
    output_url: '/workspace/Default/generated.glb',
  });

  assert.deepEqual(updatedStep.outputs, {
    meshPath: 'Default/generated.glb',
    exportUrl: '/workspace/Default/generated.glb',
    sceneCandidate: {
      workspace_path: 'Default/generated.glb',
      output_url: '/workspace/Default/generated.glb',
    },
  });
});

test('derived workflow outputs ignore remote output_url values and built-in recipes keep the previous contract', async () => {
  const derivedRuntime = await loadDerivedRuntime();
  const derivedStep = advanceGenerateMeshStep(derivedRuntime, {
    run_id: 'derived-run-remote-output-url',
    status: 'done',
    output_url: 'https://example.com/generated.glb',
  });

  assert.deepEqual(derivedStep.outputs, {
    exportUrl: 'https://example.com/generated.glb',
  });

  const builtInRuntime = resolveRecipeRuntime('image_to_mesh');
  const builtInStep = advanceGenerateMeshStep(builtInRuntime, {
    run_id: 'builtin-run-relative-output-url',
    status: 'done',
    output_url: 'Default/generated.glb',
  });

  assert.deepEqual(builtInStep.outputs, {
    exportUrl: 'Default/generated.glb',
  });
});

test('derived workflow outputs allow conservative local file URLs only with an empty host', async () => {
  const runtime = await loadDerivedRuntime();
  const acceptedStep = advanceGenerateMeshStep(runtime, {
    run_id: 'derived-run-file-url',
    status: 'done',
    output_url: 'file:///Default/generated.glb',
  });

  assert.deepEqual(acceptedStep.outputs, {
    meshPath: 'Default/generated.glb',
    exportUrl: 'file:///Default/generated.glb',
  });

  const rejectedStep = advanceGenerateMeshStep(runtime, {
    run_id: 'derived-run-file-url-localhost',
    status: 'done',
    output_url: 'file://localhost/Default/generated.glb',
  });

  assert.deepEqual(rejectedStep.outputs, {
    exportUrl: 'file://localhost/Default/generated.glb',
  });
});
