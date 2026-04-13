import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createToolRegistry } from '../../src/mcp/tools/index.mjs';

function notFoundResponse(message) {
  return jsonResponse({ detail: message }, { status: 404, statusText: 'Not Found' });
}

const originalFetch = globalThis.fetch;

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function installFetchStub(handler) {
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init.method ?? 'GET';
    const call = { method, url: url.toString(), path: url.pathname, search: url.search };
    calls.push(call);
    return handler({ method, url, path: url.pathname, search: url.search, init, calls, call });
  };

  return calls;
}

function resetFetch() {
  globalThis.fetch = originalFetch;
}

async function createTempImage(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-mcp-workflow-run-'));
  const imagePath = path.join(directory, 'input.png');
  await writeFile(imagePath, 'png');
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return imagePath;
}

test('modly.model.list fails fast when backend health is unavailable', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    assert.equal(path, '/health');
    throw new Error('connect ECONNREFUSED');
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.model.list', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/health');
});

test('wrapper rejects unknown properties before any backend call', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.config.paths.get', { unexpected: true });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(result.structuredContent.error.details.unknownKeys, ['unexpected']);
  assert.equal(calls.length, 0);
});

test('modly.model.current returns { model: null } when no model is active', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/model/status') {
      return jsonResponse({ model: null });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.model.current', {});

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: { model: null },
  });
});

test('modly.model.list returns the JSON models collection on success', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'foo' }, { model_id: 'bar' }] });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.model.list', {});

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      models: [{ id: 'foo' }, { model_id: 'bar' }],
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /model/all'],
  );
});

test('modly.model.params resolves canonical model params', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, url }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'foo' }, { model_id: 'bar' }] });
    }

    if (path === '/model/params') {
      assert.equal(url.searchParams.get('model_id'), 'bar');
      return jsonResponse({ steps: 28, guidance: 7.5 });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.model.params', { modelId: 'bar' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      modelId: 'bar',
      params: { steps: 28, guidance: 7.5 },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /model/all', 'GET /model/params?model_id=bar'],
  );
});

test('modly.model.params rejects non canonical model ids', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/model/all') {
      return jsonResponse([{ id: 'foo' }]);
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.model.params', { modelId: 'not-real' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.reason, 'non_canonical_model_id');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /model/all'],
  );
});

test('modly.job.status returns the latest job snapshot', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/generate/status/job-123') {
      return jsonResponse({ status: 'running', progress: 42 });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.job.status', { jobId: 'job-123' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      jobId: 'job-123',
      job: {
        job_id: 'job-123',
        status: 'running',
        progress: 42,
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /generate/status/job-123'],
  );
});

test('modly.workflowRun.createFromImage fails fast when backend health is unavailable', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(({ path }) => {
    assert.equal(path, '/health');
    throw new Error('connect ECONNREFUSED');
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.createFromImage', {
    imagePath,
    modelId: 'canon-1',
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/health');
});

test('modly.workflowRun.createFromImage rejects params that are not objects', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.createFromImage', {
    imagePath,
    modelId: 'canon-1',
    params: ['bad'],
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.path, 'input.params');
  assert.equal(calls.length, 0);
});

test('modly.workflowRun.createFromImage rejects non canonical model ids', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'canon-1' }] });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.createFromImage', {
    imagePath,
    modelId: 'label-only',
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.reason, 'non_canonical_model_id');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /model/all'],
  );
});

test('modly.workflowRun.createFromImage returns a stable run payload', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'canon-1' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(method, 'POST');
      const body = init.body;
      assert.equal(body instanceof FormData, true);
      assert.equal(body.get('model_id'), 'canon-1');
      assert.equal(body.get('params'), JSON.stringify({ steps: 12 }));
      return jsonResponse({
        run_id: 'run-123',
        status: 'queued',
        progress: 0,
        scene_candidate: { path: 'scene.glb' },
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.createFromImage', {
    imagePath,
    modelId: 'canon-1',
    params: { steps: 12 },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      run: {
        runId: 'run-123',
        status: 'queued',
        progress: 0,
        step: undefined,
        outputUrl: undefined,
        error: undefined,
        sceneCandidate: { path: 'scene.glb' },
        run_id: 'run-123',
        scene_candidate: { path: 'scene.glb' },
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /model/all', 'POST /workflow-runs/from-image'],
  );
});

test('modly.workflowRun.status returns the latest run snapshot', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-123') {
      return jsonResponse({ status: 'running', progress: 42, step: 'meshing' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.status', { runId: 'run-123' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      run: {
        run_id: 'run-123',
        runId: 'run-123',
        status: 'running',
        progress: 42,
        step: 'meshing',
        outputUrl: undefined,
        error: undefined,
        sceneCandidate: undefined,
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/run-123'],
  );
});

test('modly.workflowRun.cancel returns the cancelled run snapshot', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, method }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-123/cancel') {
      assert.equal(method, 'POST');
      return jsonResponse({ status: 'cancelled', error: null });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.cancel', { runId: 'run-123' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      run: {
        run_id: 'run-123',
        runId: 'run-123',
        status: 'cancelled',
        progress: undefined,
        step: undefined,
        outputUrl: undefined,
        error: null,
        sceneCandidate: undefined,
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'POST /workflow-runs/run-123/cancel'],
  );
});

test('modly.workflowRun.status surfaces NOT_FOUND for unknown run id', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/missing-run') {
      return notFoundResponse('Workflow run missing-run was not found.');
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.status', { runId: 'missing-run' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'NOT_FOUND');
  assert.equal(result.structuredContent.error.message, '404 Not Found for /workflow-runs/missing-run');
  assert.deepEqual(result.structuredContent.error.details, { detail: 'Workflow run missing-run was not found.' });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/missing-run'],
  );
});

test('modly.workflowRun.cancel surfaces NOT_FOUND for unknown run id', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, method }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/missing-run/cancel') {
      assert.equal(method, 'POST');
      return notFoundResponse('Workflow run missing-run was not found.');
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.cancel', { runId: 'missing-run' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'NOT_FOUND');
  assert.equal(result.structuredContent.error.message, '404 Not Found for /workflow-runs/missing-run/cancel');
  assert.deepEqual(result.structuredContent.error.details, { detail: 'Workflow run missing-run was not found.' });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'POST /workflow-runs/missing-run/cancel'],
  );
});

test('registry rejects non MVP operations with UNSUPPORTED_OPERATION', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.generate.fromImage', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(result.structuredContent.meta.tool, 'modly.generate.fromImage');
  assert.equal(calls.length, 0);
});
