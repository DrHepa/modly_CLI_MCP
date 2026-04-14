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

function response(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': init.contentType ?? 'application/json', ...(init.headers ?? {}) },
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

function assertCapabilitiesCallsStayInBridge(calls) {
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /automation/capabilities'],
  );
  assert.equal(calls[0].url, 'http://127.0.0.1:8766/automation/capabilities');
  assert.equal(calls.some((call) => call.path === '/health'), false);
  assert.equal(calls.some((call) => call.path.includes('/workflow-runs')), false);
  assert.equal(calls.some((call) => call.path.includes('/process-runs')), false);
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

test('registry catalog exposes modly.capabilities.get with empty input schema', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.capabilities.get');

  assert.deepEqual(tool, {
    name: 'modly.capabilities.get',
    title: 'Get Automation Capabilities',
    description: 'Returns canonical automation capabilities from GET /automation/capabilities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
});

test('registry catalog exposes strict process-run MCP schemas', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });

  assert.deepEqual(
    registry.catalog.filter((entry) => entry.name.startsWith('modly.processRun.')),
    [
      {
        name: 'modly.processRun.create',
        title: 'Create Process Run',
        description: 'Creates a process run. outputPath is optional sugar for params.output_path.',
        inputSchema: {
          type: 'object',
          required: ['process_id', 'params'],
          properties: {
            process_id: { type: 'string' },
            params: { type: 'object' },
            workspace_path: { type: 'string' },
            outputPath: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'modly.processRun.status',
        title: 'Process Run Status',
        description: 'Gets the latest process run state.',
        inputSchema: {
          type: 'object',
          required: ['runId'],
          properties: { runId: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: 'modly.processRun.wait',
        title: 'Wait For Process Run',
        description: 'Waits until a process run reaches a terminal state.',
        inputSchema: {
          type: 'object',
          required: ['runId'],
          properties: {
            runId: { type: 'string' },
            intervalMs: { type: 'integer', minimum: 1 },
            timeoutMs: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'modly.processRun.cancel',
        title: 'Cancel Process Run',
        description: 'Requests process run cancellation.',
        inputSchema: {
          type: 'object',
          required: ['runId'],
          properties: { runId: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ],
  );
});

test('modly.capabilities.get bypasses /health and routes capabilities to bridge :8766', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const payload = {
    backend_ready: false,
    source: { endpoint: '/automation/capabilities' },
    errors: [{ code: 'BACKEND_NOT_READY', message: 'Warming up' }],
    excluded: { ui_only_nodes: ['Preview3D'] },
    models: [{ id: 'canon-1' }],
    processes: [{ id: 'workflow-run' }],
  };

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      return jsonResponse(payload);
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: payload,
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

test('modly.capabilities.get keeps backend_ready=false as functional success', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: false,
        source: 'fastapi',
        errors: [{ code: 'BACKEND_NOT_READY' }],
        excluded: { ui_only_nodes: ['ui-preview'] },
        models: [],
        processes: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.backend_ready, false);
  assert.deepEqual(result.structuredContent.data.errors, [{ code: 'BACKEND_NOT_READY' }]);
  assert.deepEqual(result.structuredContent.data.excluded.ui_only_nodes, ['ui-preview']);
});

test('modly.capabilities.get reserves BACKEND_UNAVAILABLE for transport failures only', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      throw new Error('connect ECONNREFUSED');
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(result.structuredContent.error.message, 'GET /automation/capabilities failed');
  assert.deepEqual(result.structuredContent.error.details, {
    classificationBranch: 'transport_error',
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    cause: {
      name: 'Error',
      message: 'connect ECONNREFUSED',
    },
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

test('modly.capabilities.get propagates invalid_content_type details for live non-JSON responses', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      return response('bridge alive but returned text', { contentType: 'text/plain' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'INVALID_CAPABILITIES_PAYLOAD');
  assert.equal(result.structuredContent.error.message, 'Invalid automation capabilities payload.');
  assert.deepEqual(result.structuredContent.error.details, {
    classificationBranch: 'invalid_content_type',
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities',
      redirected: false,
      status: 200,
      statusText: '',
      headers: {
        'content-type': 'text/plain',
      },
    },
    body: 'bridge alive but returned text',
    rawBody: 'bridge alive but returned text',
    reason: 'INVALID_CONTENT_TYPE',
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

test('modly.capabilities.get reserves BACKEND_UNAVAILABLE for bridge 5xx responses only', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      return response(JSON.stringify({ detail: 'bridge unavailable' }), {
        status: 502,
        statusText: 'Bad Gateway',
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(result.structuredContent.error.message, 'GET /automation/capabilities failed');
  assert.deepEqual(result.structuredContent.error.details, {
    classificationBranch: 'http_5xx',
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities',
      redirected: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: {
        'content-type': 'application/json',
      },
    },
    body: { detail: 'bridge unavailable' },
    rawBody: '{"detail":"bridge unavailable"}',
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

test('modly.capabilities.get maps timeout to BACKEND_UNAVAILABLE without /health or workflow probes', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(result.structuredContent.error.message, 'GET /automation/capabilities failed');
  assert.deepEqual(result.structuredContent.error.details, {
    classificationBranch: 'timeout',
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    cause: {
      name: 'AbortError',
      message: 'The operation was aborted.',
    },
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

test('modly.capabilities.get propagates invalid_json details without reinterpretation', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      return response('{"backend_ready":', { contentType: 'application/json' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'INVALID_CAPABILITIES_PAYLOAD');
  assert.equal(result.structuredContent.error.message, 'Invalid automation capabilities payload.');
  assert.deepEqual(result.structuredContent.error.details, {
    classificationBranch: 'invalid_json',
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities',
      redirected: false,
      status: 200,
      statusText: '',
      headers: {
        'content-type': 'application/json',
      },
    },
    rawBody: '{"backend_ready":',
    reason: 'INVALID_JSON_RESPONSE',
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

test('modly.capabilities.get propagates invalid_capabilities_payload details for parseable partial success', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const payload = { ok: true };

  const calls = installFetchStub(({ path }) => {
    if (path === '/automation/capabilities') {
      return jsonResponse(payload);
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capabilities.get', {});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'INVALID_CAPABILITIES_PAYLOAD');
  assert.equal(result.structuredContent.error.message, 'Invalid automation capabilities payload.');
  assert.deepEqual(result.structuredContent.error.details, {
    classificationBranch: 'invalid_capabilities_payload',
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities',
      redirected: false,
      status: 200,
      statusText: '',
      headers: {
        'content-type': 'application/json',
      },
    },
    body: payload,
    rawBody: '{"ok":true}',
    reason: 'Capabilities payload is missing canonical fields.',
    payload,
  });
  assertCapabilitiesCallsStayInBridge(calls);
});

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

test('modly.model.list keeps FastAPI preflight /health on :8765 before listing models', { concurrency: false }, async (t) => {
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
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://127.0.0.1:8765/health', 'http://127.0.0.1:8765/model/all'],
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

test('modly.workflowRun.wait fails fast when backend health is unavailable', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    assert.equal(path, '/health');
    throw new Error('connect ECONNREFUSED');
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.wait', { runId: 'run-123' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/health');
});

test('modly.workflowRun.wait validates intervalMs and timeoutMs as positive integers', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });

  const invalidInterval = await registry.invoke('modly.workflowRun.wait', {
    runId: 'run-123',
    intervalMs: 1.5,
  });
  const invalidTimeout = await registry.invoke('modly.workflowRun.wait', {
    runId: 'run-123',
    timeoutMs: 0,
  });

  assert.equal(invalidInterval.isError, true);
  assert.equal(invalidInterval.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidInterval.structuredContent.error.details.path, 'input.intervalMs');
  assert.equal(invalidInterval.structuredContent.error.details.expected, 'integer');

  assert.equal(invalidTimeout.isError, true);
  assert.equal(invalidTimeout.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidTimeout.structuredContent.error.details.path, 'input.timeoutMs');
  assert.equal(invalidTimeout.structuredContent.error.details.minimum, 1);

  assert.equal(calls.length, 0);
});

test('modly.workflowRun.wait returns the terminal done payload', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-123') {
      const attempts = calls.filter((call) => call.path === '/workflow-runs/run-123').length;

      if (attempts === 1) {
        return jsonResponse({ run_id: 'run-123', status: 'running', progress: 55 });
      }

      return jsonResponse({
        run_id: 'run-123',
        status: 'done',
        progress: 100,
        output_url: 'https://example.com/final.glb',
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.wait', {
    runId: 'run-123',
    intervalMs: 1,
    timeoutMs: 50,
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      run: {
        run_id: 'run-123',
        runId: 'run-123',
        status: 'done',
        progress: 100,
        step: undefined,
        outputUrl: 'https://example.com/final.glb',
        error: undefined,
        sceneCandidate: undefined,
        output_url: 'https://example.com/final.glb',
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/run-123', 'GET /workflow-runs/run-123'],
  );
});

test('modly.workflowRun.wait returns terminal error payload', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-error') {
      return jsonResponse({ run_id: 'run-error', status: 'error', error: 'mesh failed' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.wait', { runId: 'run-error' });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.run.status, 'error');
  assert.equal(result.structuredContent.data.run.error, 'mesh failed');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/run-error'],
  );
});

test('modly.workflowRun.wait returns terminal cancelled payload', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-cancelled') {
      return jsonResponse({ run_id: 'run-cancelled', status: 'cancelled', progress: 12 });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.wait', { runId: 'run-cancelled' });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.run.status, 'cancelled');
  assert.equal(result.structuredContent.data.run.progress, 12);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/run-cancelled'],
  );
});

test('modly.workflowRun.wait times out when the run never reaches a terminal state', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-timeout') {
      return jsonResponse({ run_id: 'run-timeout', status: 'running', progress: 90 });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.wait', {
    runId: 'run-timeout',
    intervalMs: 1,
    timeoutMs: 5,
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'TIMEOUT');
  assert.equal(result.structuredContent.error.message, 'Polling timed out before reaching a terminal state.');
  assert.equal(calls[0].path, '/health');
  assert.ok(calls.filter((call) => call.path === '/workflow-runs/run-timeout').length >= 1);
});

test('modly.workflowRun.wait surfaces NOT_FOUND for unknown run id', { concurrency: false }, async (t) => {
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
  const result = await registry.invoke('modly.workflowRun.wait', { runId: 'missing-run' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'NOT_FOUND');
  assert.equal(result.structuredContent.error.message, '404 Not Found for /workflow-runs/missing-run');
  assert.deepEqual(result.structuredContent.error.details, { detail: 'Workflow run missing-run was not found.' });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/missing-run'],
  );
});

test('modly.processRun.create validates canonical process_id and workspace_path before backend create', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({ processes: [{ id: 'mesh-simplify', label: 'Pretty Name' }] });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-simplify',
        params: {
          mesh_path: 'meshes/in.glb',
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'workspace',
      });
      return jsonResponse({
        run_id: 'process-run-123',
        process_id: 'mesh-simplify',
        status: 'accepted',
        params: {
          mesh_path: 'meshes/in.glb',
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'workspace',
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.processRun.create', {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb' },
    workspace_path: './workspace',
    outputPath: './meshes/out.glb',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      run: {
        run_id: 'process-run-123',
        runId: 'process-run-123',
        process_id: 'mesh-simplify',
        processId: 'mesh-simplify',
        status: 'accepted',
        params: {
          mesh_path: 'meshes/in.glb',
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'workspace',
        workspacePath: 'workspace',
        outputUrl: undefined,
        error: undefined,
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'POST /process-runs'],
  );

  const invalidProcess = await registry.invoke('modly.processRun.create', {
    process_id: 'pretty-name',
    params: { mesh_path: 'meshes/in.glb' },
  });

  assert.equal(invalidProcess.isError, true);
  assert.equal(invalidProcess.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidProcess.structuredContent.error.details.reason, 'non_canonical_process_id');

  const invalidWorkspace = await registry.invoke('modly.processRun.create', {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb' },
    workspace_path: '../escape',
  });

  assert.equal(invalidWorkspace.isError, true);
  assert.equal(invalidWorkspace.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidWorkspace.structuredContent.error.details.reason, 'path_traversal');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      'GET /automation/capabilities',
      'POST /process-runs',
      'GET /health',
      'GET /automation/capabilities',
      'GET /health',
      'GET /automation/capabilities',
    ],
  );
});

test('modly.processRun.create surfaces backend PROCESS_UNSUPPORTED unchanged', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, method }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({ processes: [{ id: 'mesh-simplify' }] });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      return jsonResponse(
        {
          detail: 'Backend rejected process.',
          error: { code: 'PROCESS_UNSUPPORTED', process_id: 'mesh-simplify' },
        },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.processRun.create', {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb' },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'PROCESS_UNSUPPORTED');
  assert.equal(result.structuredContent.error.message, '422 Error for /process-runs');
  assert.deepEqual(result.structuredContent.error.details, {
    detail: 'Backend rejected process.',
    error: { code: 'PROCESS_UNSUPPORTED', process_id: 'mesh-simplify' },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'POST /process-runs'],
  );
});

test('modly.processRun.status and cancel return stable process-run payloads', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, method }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/process-runs/run-123') {
      return jsonResponse({
        process_id: 'mesh-simplify',
        status: 'running',
        params: { mesh_path: 'meshes/in.glb' },
      });
    }

    if (path === '/process-runs/run-123/cancel') {
      assert.equal(method, 'POST');
      return jsonResponse({ run_id: 'run-123', process_id: 'mesh-simplify', status: 'canceled' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const statusResult = await registry.invoke('modly.processRun.status', { runId: 'run-123' });
  const cancelResult = await registry.invoke('modly.processRun.cancel', { runId: 'run-123' });

  assert.equal(statusResult.isError, undefined);
  assert.equal(statusResult.structuredContent.data.run.run_id, 'run-123');
  assert.equal(statusResult.structuredContent.data.run.processId, 'mesh-simplify');
  assert.equal(statusResult.structuredContent.data.run.status, 'running');

  assert.equal(cancelResult.isError, undefined);
  assert.equal(cancelResult.structuredContent.data.run.runId, 'run-123');
  assert.equal(cancelResult.structuredContent.data.run.process_id, 'mesh-simplify');
  assert.equal(cancelResult.structuredContent.data.run.status, 'canceled');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /process-runs/run-123', 'GET /health', 'POST /process-runs/run-123/cancel'],
  );
});

test('modly.processRun.wait returns terminal state and supports timeout passthrough', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  let timeoutFetches = 0;
  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/process-runs/run-123') {
      const attempts = calls.filter((call) => call.path === '/process-runs/run-123').length;

      if (attempts === 1) {
        return jsonResponse({ run_id: 'run-123', process_id: 'mesh-simplify', status: 'running' });
      }

      return jsonResponse({
        run_id: 'run-123',
        process_id: 'mesh-simplify',
        status: 'succeeded',
        output_url: 'https://example.com/out.glb',
      });
    }

    if (path === '/process-runs/run-timeout') {
      timeoutFetches += 1;
      return jsonResponse({ run_id: 'run-timeout', process_id: 'mesh-simplify', status: 'running' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const successResult = await registry.invoke('modly.processRun.wait', {
    runId: 'run-123',
    intervalMs: 1,
    timeoutMs: 50,
  });

  assert.equal(successResult.isError, undefined);
  assert.deepEqual(successResult.structuredContent, {
    ok: true,
    data: {
      run: {
        run_id: 'run-123',
        runId: 'run-123',
        process_id: 'mesh-simplify',
        processId: 'mesh-simplify',
        status: 'succeeded',
        params: undefined,
        workspacePath: undefined,
        outputUrl: 'https://example.com/out.glb',
        error: undefined,
        output_url: 'https://example.com/out.glb',
      },
    },
  });

  const timeoutResult = await registry.invoke('modly.processRun.wait', {
    runId: 'run-timeout',
    intervalMs: 1,
    timeoutMs: 5,
  });

  assert.equal(timeoutResult.isError, true);
  assert.equal(timeoutResult.structuredContent.error.code, 'TIMEOUT');
  assert.equal(timeoutResult.structuredContent.error.message, 'Polling timed out before reaching a terminal state.');
  assert.ok(timeoutFetches >= 1);
  assert.equal(calls[0].path, '/health');
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
