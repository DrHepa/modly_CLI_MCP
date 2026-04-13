import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createModlyApiClient } from '../../src/core/modly-api.mjs';
import { toWorkflowRun } from '../../src/core/modly-normalizers.mjs';

async function withTempImage(t, fileName) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'modly-api-image-'));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const imagePath = path.join(tempDir, fileName);
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return imagePath;
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('createWorkflowRunFromImage maps multipart body to /workflow-runs/from-image', async (t) => {
  const imagePath = await withTempImage(t, 'workflow.webp');
  let requestUrl;
  let requestMethod;
  let requestBody;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestMethod = init.method;
      requestBody = init.body;
      return jsonResponse({ ok: true });
    },
  });

  await client.createWorkflowRunFromImage({
    imagePath,
    modelId: 'canonical-model',
    paramsJson: { steps: 8 },
  });

  assert.equal(requestUrl, 'http://127.0.0.1:8765/workflow-runs/from-image');
  assert.equal(requestMethod, 'POST');
  assert.ok(requestBody instanceof FormData);
  assert.equal(requestBody.get('model_id'), 'canonical-model');
  assert.equal(requestBody.get('params'), JSON.stringify({ steps: 8 }));

  const image = requestBody.get('image');
  assert.ok(image instanceof File);
  assert.equal(image.name, 'workflow.webp');
  assert.equal(image.type, 'image/webp');
});

test('generateFromImage serializes png uploads with image/png MIME type', async (t) => {
  const imagePath = await withTempImage(t, 'input.png');
  let requestBody;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (_url, init) => {
      requestBody = init.body;
      return jsonResponse({ ok: true });
    },
  });

  await client.generateFromImage({ imagePath, modelId: 'model-1' });

  assert.ok(requestBody instanceof FormData);
  const image = requestBody.get('image');
  assert.ok(image instanceof File);
  assert.equal(image.name, 'input.png');
  assert.equal(image.type, 'image/png');
  assert.equal(requestBody.get('model_id'), 'model-1');
});

test('generateFromImage keeps unknown extensions without fabricating an image MIME type', async (t) => {
  const imagePath = await withTempImage(t, 'input.unknown');
  let requestBody;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (_url, init) => {
      requestBody = init.body;
      return jsonResponse({ ok: true });
    },
  });

  await client.generateFromImage({ imagePath, modelId: 'model-1' });

  const image = requestBody.get('image');
  assert.ok(image instanceof File);
  assert.equal(image.type, '');
});

test('getWorkflowRun maps GET /workflow-runs/{run_id}', async () => {
  let requestUrl;
  let requestMethod;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestMethod = init.method;
      return jsonResponse({ run_id: 'run-123', status: 'running' });
    },
  });

  const result = await client.getWorkflowRun('run-123');

  assert.equal(requestUrl, 'http://127.0.0.1:8765/workflow-runs/run-123');
  assert.equal(requestMethod, 'GET');
  assert.deepEqual(result, { run_id: 'run-123', status: 'running' });
});

test('cancelWorkflowRun maps POST /workflow-runs/{run_id}/cancel', async () => {
  let requestUrl;
  let requestMethod;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestMethod = init.method;
      return jsonResponse({ run_id: 'run-123', status: 'cancelled' });
    },
  });

  const result = await client.cancelWorkflowRun('run-123');

  assert.equal(requestUrl, 'http://127.0.0.1:8765/workflow-runs/run-123/cancel');
  assert.equal(requestMethod, 'POST');
  assert.deepEqual(result, { run_id: 'run-123', status: 'cancelled' });
});

test('toWorkflowRun normalizes accepted and status payloads with stable run identity', () => {
  assert.deepEqual(
    toWorkflowRun('run-accepted', {
      run_id: 'run-accepted',
      status: 'accepted',
      progress: 0,
      step: 'queued',
      scene_candidate: { mesh_path: 'meshes/out.glb' },
    }),
    {
      run_id: 'run-accepted',
      runId: 'run-accepted',
      status: 'accepted',
      progress: 0,
      step: 'queued',
      outputUrl: undefined,
      error: undefined,
      sceneCandidate: { mesh_path: 'meshes/out.glb' },
      scene_candidate: { mesh_path: 'meshes/out.glb' },
    },
  );

  assert.deepEqual(
    toWorkflowRun('run-status', {
      run: {
        run_id: 'run-status',
        status: 'running',
        progress: 55,
        step: 'meshing',
        output_url: 'https://example.com/out.glb',
        error: null,
        scene_candidate: null,
      },
    }),
    {
      run_id: 'run-status',
      runId: 'run-status',
      status: 'running',
      progress: 55,
      step: 'meshing',
      output_url: 'https://example.com/out.glb',
      outputUrl: 'https://example.com/out.glb',
      error: null,
      sceneCandidate: null,
      scene_candidate: null,
    },
  );

  assert.deepEqual(
    toWorkflowRun('run-fallback', {
      status: 'running',
      progress: 42,
    }),
    {
      run_id: 'run-fallback',
      runId: 'run-fallback',
      status: 'running',
      progress: 42,
      step: undefined,
      outputUrl: undefined,
      error: undefined,
      sceneCandidate: undefined,
    },
  );
});
