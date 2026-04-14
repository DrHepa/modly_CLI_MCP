import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createModlyApiClient } from '../../src/core/modly-api.mjs';
import { ModlyError } from '../../src/core/errors.mjs';
import { requestJsonRuntime } from '../../src/core/http.mjs';
import { toProcessRun, toWorkflowRun } from '../../src/core/modly-normalizers.mjs';
import { prepareProcessRunCreateInput } from '../../src/core/process-run-input.mjs';

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

function response(body, { status = 200, statusText, contentType = 'application/json' } = {}) {
  return new Response(body, {
    status,
    statusText,
    headers: { 'content-type': contentType },
  });
}

function responseWithEvidence(
  body,
  { status = 200, statusText, contentType = 'application/json', headers = {}, url, redirected = false } = {},
) {
  const result = new Response(body, {
    status,
    statusText,
    headers: {
      'content-type': contentType,
      ...headers,
    },
  });

  if (url !== undefined) {
    Object.defineProperty(result, 'url', {
      value: url,
      configurable: true,
    });
  }

  Object.defineProperty(result, 'redirected', {
    value: redirected,
    configurable: true,
  });

  return result;
}

test('getAutomationCapabilities routes only capabilities to bridge and preserves canonical payload', async () => {
  const requests = [];

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init.method });
      return jsonResponse({
        backend_ready: true,
        source: 'bridge',
        errors: [],
        excluded: { ui_only_nodes: ['Add to Scene'], reason: 'ui-only' },
        models: [{ id: 'model-a' }],
        processes: [{ id: 'process-a' }],
      });
    },
  });

  const result = await client.getAutomationCapabilities();

  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:8766/automation/capabilities', method: 'GET' }]);
  assert.deepEqual(result, {
    backend_ready: true,
    source: 'bridge',
    errors: [],
    excluded: { ui_only_nodes: ['Add to Scene'], reason: 'ui-only' },
    models: [{ id: 'model-a' }],
    processes: [{ id: 'process-a' }],
  });
});

test('process-runs route to bridge while workflow, health and models remain on FastAPI', async () => {
  const requests = [];

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init.method });

      switch (String(url)) {
        case 'http://127.0.0.1:8766/automation/capabilities':
          return jsonResponse({
            backend_ready: true,
            source: 'bridge',
            errors: [],
            excluded: { ui_only_nodes: [] },
            models: [{ id: 'model-a' }],
            processes: [{ id: 'process-a' }],
          });
        case 'http://127.0.0.1:8765/health':
          return jsonResponse({ status: 'ok' });
        case 'http://127.0.0.1:8765/workflow-runs/run-123':
          return jsonResponse({ run_id: 'run-123', status: 'running' });
        case 'http://127.0.0.1:8766/process-runs/process-run-1':
          return jsonResponse({ run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'running' });
        case 'http://127.0.0.1:8765/model/all':
          return jsonResponse({ models: [] });
        default:
          throw new Error(`Unexpected URL: ${String(url)}`);
      }
    },
  });

  const capabilities = await client.getAutomationCapabilities();
  const health = await client.health();
  const workflowRun = await client.getWorkflowRun('run-123');
  const processRun = await client.getProcessRun('process-run-1');
  const models = await client.listModels();

  assert.deepEqual(requests, [
    { url: 'http://127.0.0.1:8766/automation/capabilities', method: 'GET' },
    { url: 'http://127.0.0.1:8765/health', method: 'GET' },
    { url: 'http://127.0.0.1:8765/workflow-runs/run-123', method: 'GET' },
    { url: 'http://127.0.0.1:8766/process-runs/process-run-1', method: 'GET' },
    { url: 'http://127.0.0.1:8765/model/all', method: 'GET' },
  ]);
  assert.equal(capabilities.source, 'bridge');
  assert.deepEqual(health, { status: 'ok' });
  assert.deepEqual(workflowRun, { run_id: 'run-123', status: 'running' });
  assert.deepEqual(processRun, { run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'running' });
  assert.deepEqual(models, { models: [] });
});

test('getAutomationCapabilities keeps backend_ready=false as successful discovery', async () => {
  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async () => jsonResponse({
      backend_ready: false,
      source: 'bridge',
      errors: [{ code: 'MODEL_NOT_READY' }],
      excluded: { ui_only_nodes: ['workflow-builder'] },
      models: [],
      processes: [{ id: 'process-a' }],
    }),
  });

  const result = await client.getAutomationCapabilities();

  assert.equal(result.backend_ready, false);
  assert.deepEqual(result.errors, [{ code: 'MODEL_NOT_READY' }]);
  assert.deepEqual(result.excluded, { ui_only_nodes: ['workflow-builder'] });
  assert.deepEqual(result.processes, [{ id: 'process-a' }]);
});

test('getAutomationCapabilities throws INVALID_CAPABILITIES_PAYLOAD for invalid payloads', async () => {
  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async () => jsonResponse({ ok: true }),
  });

  await assert.rejects(
    () => client.getAutomationCapabilities(),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'INVALID_CAPABILITIES_PAYLOAD');
      assert.equal(error.details.classificationBranch, 'invalid_capabilities_payload');
      assert.equal(error.details.requestedUrl, 'http://127.0.0.1:8766/automation/capabilities');
      assert.equal(error.details.reason, 'Capabilities payload is missing canonical fields.');
      assert.deepEqual(error.details.response, {
        url: 'http://127.0.0.1:8766/automation/capabilities',
        redirected: false,
        status: 200,
        statusText: '',
        headers: {
          'content-type': 'application/json',
        },
      });
      assert.deepEqual(error.details.payload, { ok: true });
      return true;
    },
  );
});

test('getAutomationCapabilities classifies live non-JSON responses as invalid_content_type', async () => {
  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async () => response('bridge alive but returned text', { contentType: 'text/plain' }),
  });

  await assert.rejects(
    () => client.getAutomationCapabilities(),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'INVALID_CAPABILITIES_PAYLOAD');
      assert.equal(error.details.classificationBranch, 'invalid_content_type');
      assert.equal(error.details.requestedUrl, 'http://127.0.0.1:8766/automation/capabilities');
      assert.equal(error.details.reason, 'INVALID_CONTENT_TYPE');
      assert.deepEqual(error.details.response, {
        url: 'http://127.0.0.1:8766/automation/capabilities',
        redirected: false,
        status: 200,
        statusText: '',
        headers: {
          'content-type': 'text/plain',
        },
      });
      assert.equal(error.details.rawBody, 'bridge alive but returned text');
      return true;
    },
  );
});

test('getAutomationCapabilities classifies invalid JSON responses as invalid_json', async () => {
  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async () => response('{"backend_ready":', { contentType: 'application/json' }),
  });

  await assert.rejects(
    () => client.getAutomationCapabilities(),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'INVALID_CAPABILITIES_PAYLOAD');
      assert.equal(error.details.classificationBranch, 'invalid_json');
      assert.equal(error.details.requestedUrl, 'http://127.0.0.1:8766/automation/capabilities');
      assert.equal(error.details.reason, 'INVALID_JSON_RESPONSE');
      assert.deepEqual(error.details.response, {
        url: 'http://127.0.0.1:8766/automation/capabilities',
        redirected: false,
        status: 200,
        statusText: '',
        headers: {
          'content-type': 'application/json',
        },
      });
      assert.equal(error.details.rawBody, '{"backend_ready":');
      return true;
    },
  );
});

test('getAutomationCapabilities fails explicitly on bridge outages without FastAPI fallback', async () => {
  const requests = [];

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url) => {
      requests.push(String(url));
      throw new Error('connect ECONNREFUSED');
    },
  });

  await assert.rejects(
    () => client.getAutomationCapabilities(),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.message, 'GET /automation/capabilities failed');
      assert.equal(error.details.classificationBranch, 'transport_error');
      assert.equal(error.details.requestedUrl, 'http://127.0.0.1:8766/automation/capabilities');
      assert.deepEqual(error.details.cause, {
        name: 'Error',
        message: 'connect ECONNREFUSED',
      });
      assert.equal(error.details.response, undefined);
      return true;
    },
  );

  assert.deepEqual(requests, ['http://127.0.0.1:8766/automation/capabilities']);
});

test('getAutomationCapabilities reserves BACKEND_UNAVAILABLE for bridge 5xx responses', async () => {
  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async () => response(JSON.stringify({ detail: 'bridge unavailable' }), {
      status: 502,
      statusText: 'Bad Gateway',
    }),
  });

  await assert.rejects(
    () => client.getAutomationCapabilities(),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.message, 'GET /automation/capabilities failed');
      assert.equal(error.details.classificationBranch, 'http_5xx');
      assert.equal(error.details.requestedUrl, 'http://127.0.0.1:8766/automation/capabilities');
      assert.equal(error.details.response.status, 502);
      assert.equal(error.details.response.statusText, 'Bad Gateway');
      assert.equal(error.details.response.url, 'http://127.0.0.1:8766/automation/capabilities');
      assert.deepEqual(error.details.body, { detail: 'bridge unavailable' });
      assert.equal(error.details.rawBody, '{"detail":"bridge unavailable"}');
      return true;
    },
  );
});

test('getAutomationCapabilities classifies timeout failures as timeout', async () => {
  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      throw error;
    },
  });

  await assert.rejects(
    () => client.getAutomationCapabilities(),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.details.classificationBranch, 'timeout');
      assert.equal(error.details.requestedUrl, 'http://127.0.0.1:8766/automation/capabilities');
      assert.deepEqual(error.details.cause, {
        name: 'AbortError',
        message: 'The operation was aborted.',
        code: 'ABORT_ERR',
      });
      assert.equal(error.details.response, undefined);
      return true;
    },
  );
});

test('requestJsonRuntime remaps bridge 502 into availability failure with live-response metadata', async () => {
  const requests = [];

  await assert.rejects(
    () => requestJsonRuntime({
      baseUrl: 'http://127.0.0.1:8766',
      path: '/automation/capabilities',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init.method });
        return responseWithEvidence(JSON.stringify({ detail: 'bridge unavailable' }), {
          status: 502,
          statusText: 'Bad Gateway',
          url: 'http://127.0.0.1:8766/bridge/error',
          redirected: true,
          headers: {
            'content-length': '31',
            location: 'http://127.0.0.1:8766/bridge/error',
          },
        });
      },
    }),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.message, 'GET /automation/capabilities failed');
      assert.equal(error.details.responseReceived, true);
      assert.equal(error.details.status, 502);
      assert.equal(error.details.url, 'http://127.0.0.1:8766/automation/capabilities');
       assert.equal(error.details.rawBody, '{"detail":"bridge unavailable"}');
      assert.deepEqual(error.details.body, { detail: 'bridge unavailable' });
      assert.deepEqual(error.details.runtimeEvidence, {
        requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
        response: {
          url: 'http://127.0.0.1:8766/bridge/error',
          redirected: true,
          status: 502,
          statusText: 'Bad Gateway',
          headers: {
            'content-type': 'application/json',
            'content-length': '31',
            location: 'http://127.0.0.1:8766/bridge/error',
          },
        },
        body: { detail: 'bridge unavailable' },
        rawBody: '{"detail":"bridge unavailable"}',
      });
      return true;
    },
  );

  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:8766/automation/capabilities', method: 'GET' }]);
});

test('requestJsonRuntime remaps timeout for capabilities into BACKEND_UNAVAILABLE', async () => {
  const requests = [];

  await assert.rejects(
    () => requestJsonRuntime({
      baseUrl: 'http://127.0.0.1:8766',
      path: '/automation/capabilities',
      fetchImpl: async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method ?? 'GET' });
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        throw error;
      },
    }),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.message, 'GET /automation/capabilities failed');
      assert.equal(error.details.responseReceived, false);
      assert.equal(error.details.reason, 'TIMEOUT');
      assert.deepEqual(error.details.runtimeEvidence, {
        requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
        cause: {
          name: 'AbortError',
          message: 'The operation was aborted.',
          code: 'ABORT_ERR',
        },
      });
      return true;
    },
  );

  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:8766/automation/capabilities', method: 'GET' }]);
});

test('requestJsonRuntime preserves live non-JSON capabilities responses for later classification', async () => {
  const result = await requestJsonRuntime({
    baseUrl: 'http://127.0.0.1:8766',
    path: '/automation/capabilities',
    fetchImpl: async () => responseWithEvidence('bridge alive but returned text', {
      contentType: 'text/plain',
      url: 'http://127.0.0.1:8766/automation/capabilities?probe=1',
      headers: { 'content-length': '29' },
    }),
  });

  assert.equal(result.responseReceived, true);
  assert.equal(result.status, 200);
  assert.equal(result.url, 'http://127.0.0.1:8766/automation/capabilities');
  assert.equal(result.payload, undefined);
  assert.equal(result.rawBody, 'bridge alive but returned text');
  assert.deepEqual(result.runtimeEvidence, {
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities?probe=1',
      redirected: false,
      status: 200,
      statusText: '',
      headers: {
        'content-type': 'text/plain',
        'content-length': '29',
      },
    },
    body: 'bridge alive but returned text',
    rawBody: 'bridge alive but returned text',
  });
  assert.ok(result.parseError instanceof ModlyError);
  assert.equal(result.parseError.code, 'INVALID_CONTENT_TYPE');
});

test('requestJsonRuntime preserves invalid JSON evidence for later classification', async () => {
  const result = await requestJsonRuntime({
    baseUrl: 'http://127.0.0.1:8766',
    path: '/automation/capabilities',
    fetchImpl: async () => responseWithEvidence('{"backend_ready":', {
      contentType: 'application/json',
      url: 'http://127.0.0.1:8766/automation/capabilities',
      headers: { 'content-length': '17' },
    }),
  });

  assert.equal(result.responseReceived, true);
  assert.equal(result.status, 200);
  assert.equal(result.payload, undefined);
  assert.equal(result.rawBody, '{"backend_ready":');
  assert.deepEqual(result.runtimeEvidence, {
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities',
      redirected: false,
      status: 200,
      statusText: '',
      headers: {
        'content-type': 'application/json',
        'content-length': '17',
      },
    },
    rawBody: '{"backend_ready":',
  });
  assert.ok(result.parseError instanceof ModlyError);
  assert.equal(result.parseError.code, 'INVALID_JSON_RESPONSE');
});

test('requestJsonRuntime returns malformed canonical JSON payloads unchanged for adapter validation', async () => {
  const payload = { ok: true };

  const result = await requestJsonRuntime({
    baseUrl: 'http://127.0.0.1:8766',
    path: '/automation/capabilities',
    fetchImpl: async () => jsonResponse(payload),
  });

  assert.equal(result.responseReceived, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, payload);
  assert.equal(result.parseError, undefined);
});

test('requestJsonRuntime returns partial valid capabilities payloads unchanged', async () => {
  const payload = {
    backend_ready: false,
    source: 'bridge',
    errors: [{ code: 'MODEL_NOT_READY' }],
  };

  const result = await requestJsonRuntime({
    baseUrl: 'http://127.0.0.1:8766',
    path: '/automation/capabilities',
    fetchImpl: async () => responseWithEvidence(JSON.stringify(payload), {
      contentType: 'application/json',
      url: 'http://127.0.0.1:8766/automation/capabilities',
      headers: { 'content-length': String(JSON.stringify(payload).length) },
    }),
  });

  assert.equal(result.responseReceived, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, payload);
  assert.equal(result.rawBody, JSON.stringify(payload));
  assert.deepEqual(result.runtimeEvidence, {
    requestedUrl: 'http://127.0.0.1:8766/automation/capabilities',
    response: {
      url: 'http://127.0.0.1:8766/automation/capabilities',
      redirected: false,
      status: 200,
      statusText: '',
      headers: {
        'content-type': 'application/json',
        'content-length': String(JSON.stringify(payload).length),
      },
    },
    body: payload,
    rawBody: JSON.stringify(payload),
  });
  assert.equal(result.parseError, undefined);
});

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

test('createProcessRun maps POST /process-runs with JSON body', async () => {
  let requestUrl;
  let requestMethod;
  let requestHeaders;
  let requestBody;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestMethod = init.method;
      requestHeaders = init.headers;
      requestBody = init.body;
      return jsonResponse({ run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'accepted' });
    },
  });

  const payload = {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb', output_path: 'meshes/out.glb' },
    workspace_path: 'workspace',
  };

  const result = await client.createProcessRun(payload);

  assert.equal(requestUrl, 'http://127.0.0.1:8766/process-runs');
  assert.equal(requestMethod, 'POST');
  assert.equal(requestHeaders['content-type'], 'application/json');
  assert.equal(requestHeaders.accept, 'application/json');
  assert.deepEqual(JSON.parse(requestBody), payload);
  assert.deepEqual(result, { run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'accepted' });
});

test('getProcessRun maps GET /process-runs/{run_id}', async () => {
  let requestUrl;
  let requestMethod;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestMethod = init.method;
      return jsonResponse({ run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'running' });
    },
  });

  const result = await client.getProcessRun('process-run-1');

  assert.equal(requestUrl, 'http://127.0.0.1:8766/process-runs/process-run-1');
  assert.equal(requestMethod, 'GET');
  assert.deepEqual(result, { run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'running' });
});

test('cancelProcessRun maps POST /process-runs/{run_id}/cancel', async () => {
  let requestUrl;
  let requestMethod;

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestMethod = init.method;
      return jsonResponse({ run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'cancelled' });
    },
  });

  const result = await client.cancelProcessRun('process-run-1');

  assert.equal(requestUrl, 'http://127.0.0.1:8766/process-runs/process-run-1/cancel');
  assert.equal(requestMethod, 'POST');
  assert.deepEqual(result, { run_id: 'process-run-1', process_id: 'mesh-simplify', status: 'cancelled' });
});

test('process-runs fail explicitly on bridge outages without FastAPI fallback', async () => {
  const requests = [];

  const client = createModlyApiClient({
    apiUrl: 'http://127.0.0.1:8765',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method ?? 'GET' });
      throw new Error('connect ECONNREFUSED 127.0.0.1:8766');
    },
  });

  await assert.rejects(
    () => client.getProcessRun('process-run-1'),
    (error) => {
      assert.ok(error instanceof ModlyError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.message, 'GET /process-runs/process-run-1 failed');
      assert.equal(error.details, undefined);
      assert.equal(error.cause?.message, 'connect ECONNREFUSED 127.0.0.1:8766');
      return true;
    },
  );

  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:8766/process-runs/process-run-1', method: 'GET' }]);
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

test('toProcessRun normalizes accepted and status payloads with stable run identity', () => {
  assert.deepEqual(
    toProcessRun('process-run-1', {
      run_id: 'process-run-1',
      process_id: 'mesh-simplify',
      status: 'accepted',
      params: { mesh_path: 'meshes/in.glb' },
      workspace_path: 'workspace',
    }),
    {
      run_id: 'process-run-1',
      runId: 'process-run-1',
      process_id: 'mesh-simplify',
      processId: 'mesh-simplify',
      status: 'accepted',
      params: { mesh_path: 'meshes/in.glb' },
      workspace_path: 'workspace',
      workspacePath: 'workspace',
      outputUrl: undefined,
      error: undefined,
    },
  );

  assert.deepEqual(
    toProcessRun('process-run-2', {
      run: {
        run_id: 'process-run-2',
        process_id: 'mesh-simplify',
        status: 'done',
        output_url: 'https://example.com/out.glb',
        error: null,
      },
    }),
    {
      run_id: 'process-run-2',
      runId: 'process-run-2',
      process_id: 'mesh-simplify',
      processId: 'mesh-simplify',
      status: 'done',
      output_url: 'https://example.com/out.glb',
      params: undefined,
      workspacePath: undefined,
      outputUrl: 'https://example.com/out.glb',
      error: null,
    },
  );
});

test('prepareProcessRunCreateInput validates canonical process_id and maps outputPath sugar', () => {
  const payload = prepareProcessRunCreateInput(
    {
      process_id: 'mesh-simplify',
      params: { mesh_path: 'meshes/in.glb' },
      workspace_path: './workspace',
      outputPath: './meshes/out.glb',
    },
    {
      capabilities: {
        processes: [{ id: 'mesh-simplify' }, { process_id: 'mesh-decimate' }],
      },
    },
  );

  assert.deepEqual(payload, {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb', output_path: 'meshes/out.glb' },
    workspace_path: 'workspace',
  });
});

test('prepareProcessRunCreateInput omits params.output_path for omitted and blank output paths', () => {
  const capabilities = { processes: [{ id: 'mesh-simplify' }] };

  assert.deepEqual(
    prepareProcessRunCreateInput(
      {
        process_id: 'mesh-simplify',
        params: { mesh_path: 'meshes/in.glb' },
      },
      { capabilities },
    ),
    {
      process_id: 'mesh-simplify',
      params: { mesh_path: 'meshes/in.glb' },
    },
  );

  assert.deepEqual(
    prepareProcessRunCreateInput(
      {
        process_id: 'mesh-simplify',
        params: { mesh_path: 'meshes/in.glb', output_path: '   ' },
        outputPath: '',
      },
      { capabilities },
    ),
    {
      process_id: 'mesh-simplify',
      params: { mesh_path: 'meshes/in.glb' },
    },
  );
});

test('prepareProcessRunCreateInput preserves explicit normalized output paths and only rejects explicit conflicts', () => {
  const capabilities = { processes: [{ id: 'mesh-simplify' }] };

  assert.deepEqual(
    prepareProcessRunCreateInput(
      {
        process_id: 'mesh-simplify',
        params: { mesh_path: 'meshes/in.glb', output_path: '   ' },
        outputPath: ' exports/from-sugar.glb ',
      },
      { capabilities },
    ),
    {
      process_id: 'mesh-simplify',
      params: { mesh_path: 'meshes/in.glb', output_path: 'exports/from-sugar.glb' },
    },
  );

  assert.deepEqual(
    prepareProcessRunCreateInput(
      {
        process_id: 'mesh-simplify',
        params: { mesh_path: 'meshes/in.glb', output_path: ' exports/out.glb ' },
      },
      { capabilities },
    ),
    {
      process_id: 'mesh-simplify',
      params: { mesh_path: 'meshes/in.glb', output_path: 'exports/out.glb' },
    },
  );

  assert.throws(
    () =>
      prepareProcessRunCreateInput(
        {
          process_id: 'mesh-simplify',
          params: { output_path: 'meshes/one.glb' },
          outputPath: 'meshes/two.glb',
        },
        { capabilities },
      ),
    /outputPath conflicts with params.output_path/,
  );
});

test('prepareProcessRunCreateInput rejects invalid params, traversal paths and conflicting output paths', () => {
  assert.throws(
    () => prepareProcessRunCreateInput({ process_id: 'mesh-simplify', params: [] }),
    /params must be a JSON object/,
  );

  assert.throws(
    () => prepareProcessRunCreateInput({ process_id: 'mesh-simplify', params: {}, workspace_path: '../escape' }),
    /workspace-relative and must not contain traversal/,
  );

  assert.throws(
    () => prepareProcessRunCreateInput(
        {
          process_id: 'mesh-unknown',
          params: {},
        },
        { capabilities: { processes: [{ id: 'mesh-simplify' }] } },
      ),
    /Unknown canonical process_id: mesh-unknown/,
  );
});
