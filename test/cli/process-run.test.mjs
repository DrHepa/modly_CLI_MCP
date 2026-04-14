import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { renderHelp, renderProcessRunHelp } from '../../src/cli/help.mjs';
import { runProcessRunCommand } from '../../src/cli/commands/process-run.mjs';
import { createModlyApiClient } from '../../src/core/modly-api.mjs';
import { ModlyError, NotFoundError } from '../../src/core/errors.mjs';

async function captureStderr(fn) {
  const writes = [];
  const originalWrite = process.stderr.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    writes.push(String(chunk));

    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }

    return true;
  });

  try {
    const result = await fn();
    return { result, stderr: writes.join('') };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function startJsonServer(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const request = {
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };

    requests.push(request);

    const response = (await handler(request, requests)) ?? {};
    const status = response.status ?? 200;
    const headers = { 'content-type': 'application/json', ...(response.headers ?? {}) };

    res.writeHead(status, headers);
    res.end(JSON.stringify(response.body ?? {}));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  );

  const address = server.address();

  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test('global and process-run help advertise process-run MVP commands', () => {
  const globalHelp = renderHelp();
  const groupHelp = renderProcessRunHelp();

  assert.match(globalHelp, /process-run <subcomando>\s+create \| status \| wait \| cancel/u);
  assert.match(groupHelp, /modly process-run/u);
  assert.match(groupHelp, /create/u);
  assert.match(groupHelp, /status <run-id>/u);
  assert.match(groupHelp, /wait <run-id>/u);
  assert.match(groupHelp, /cancel <run-id>/u);
  assert.match(groupHelp, /mesh-only/u);
});

test('process-run create validates --params-json as an object', async () => {
  await assert.rejects(
    runProcessRunCommand({
      args: ['create', '--process-id', 'mesh-simplify', '--params-json', '[]'],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '--params-json must parse to a JSON object.',
    },
  );
});

test('process-run create checks health then capabilities and maps outputPath sugar before create', async () => {
  const calls = [];

  const result = await runProcessRunCommand({
    args: [
      'create',
      '--process-id',
      'mesh-simplify',
      '--workspace-path',
      './workspace',
      '--output-path',
      './meshes/out.glb',
      '--params-json',
      '{"mesh_path":"meshes/in.glb"}',
    ],
    client: {
      async health() {
        calls.push('health');
        return { status: 'ok' };
      },
      async getAutomationCapabilities() {
        calls.push('getAutomationCapabilities');
        return { processes: [{ id: 'mesh-simplify' }] };
      },
      async createProcessRun(payload) {
        calls.push(['createProcessRun', payload]);
        return {
          run_id: 'process-run-123',
          process_id: 'mesh-simplify',
          status: 'accepted',
          params: payload.params,
          workspace_path: payload.workspace_path,
        };
      },
    },
  });

  assert.deepEqual(calls, [
    'health',
    'getAutomationCapabilities',
    [
      'createProcessRun',
      {
        process_id: 'mesh-simplify',
        params: {
          mesh_path: 'meshes/in.glb',
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'workspace',
      },
    ],
  ]);
  assert.equal(result.data.run.run_id, 'process-run-123');
  assert.equal(result.data.run.process_id, 'mesh-simplify');
  assert.equal(result.data.run.status, 'accepted');
  assert.deepEqual(result.data.run.params, {
    mesh_path: 'meshes/in.glb',
    output_path: 'meshes/out.glb',
  });
  assert.equal(result.data.run.workspacePath, 'workspace');
});

test('process-run create omits params.output_path when --output-path is missing or blank', async () => {
  const omittedCalls = [];

  const omittedResult = await runProcessRunCommand({
    args: ['create', '--process-id', 'mesh-simplify', '--params-json', '{"mesh_path":"meshes/in.glb"}'],
    client: {
      async health() {
        omittedCalls.push('health');
        return { status: 'ok' };
      },
      async getAutomationCapabilities() {
        omittedCalls.push('getAutomationCapabilities');
        return { processes: [{ id: 'mesh-simplify' }] };
      },
      async createProcessRun(payload) {
        omittedCalls.push(['createProcessRun', payload]);
        return {
          run_id: 'process-run-omitted',
          process_id: payload.process_id,
          status: 'accepted',
          params: payload.params,
          workspace_path: payload.workspace_path,
        };
      },
    },
  });

  assert.equal(omittedCalls[0], 'health');
  assert.equal(omittedCalls[1], 'getAutomationCapabilities');
  assert.equal(omittedCalls[2][0], 'createProcessRun');
  assert.equal(omittedCalls[2][1].process_id, 'mesh-simplify');
  assert.deepEqual(omittedCalls[2][1].params, {
    mesh_path: 'meshes/in.glb',
  });
  assert.equal(Object.hasOwn(omittedCalls[2][1].params, 'output_path'), false);
  assert.deepEqual(omittedResult.data.run.params, {
    mesh_path: 'meshes/in.glb',
  });

  const blankCalls = [];

  const blankResult = await runProcessRunCommand({
    args: [
      'create',
      '--process-id',
      'mesh-simplify',
      '--output-path',
      '   ',
      '--params-json',
      '{"mesh_path":"meshes/in.glb"}',
    ],
    client: {
      async health() {
        blankCalls.push('health');
        return { status: 'ok' };
      },
      async getAutomationCapabilities() {
        blankCalls.push('getAutomationCapabilities');
        return { processes: [{ id: 'mesh-simplify' }] };
      },
      async createProcessRun(payload) {
        blankCalls.push(['createProcessRun', payload]);
        return {
          run_id: 'process-run-blank',
          process_id: payload.process_id,
          status: 'accepted',
          params: payload.params,
          workspace_path: payload.workspace_path,
        };
      },
    },
  });

  assert.equal(blankCalls[0], 'health');
  assert.equal(blankCalls[1], 'getAutomationCapabilities');
  assert.equal(blankCalls[2][0], 'createProcessRun');
  assert.equal(blankCalls[2][1].process_id, 'mesh-simplify');
  assert.deepEqual(blankCalls[2][1].params, {
    mesh_path: 'meshes/in.glb',
  });
  assert.equal(Object.hasOwn(blankCalls[2][1].params, 'output_path'), false);
  assert.deepEqual(blankResult.data.run.params, {
    mesh_path: 'meshes/in.glb',
  });
});

test('process-run create without --output-path reaches default export flow over HTTP harness', async (t) => {
  const fastApi = await startJsonServer(t, ({ method, path: requestPath }) => {
    assert.equal(method, 'GET');
    assert.equal(requestPath, '/health');
    return { body: { status: 'ok' } };
  });

  let pollCount = 0;
  const bridge = await startJsonServer(t, ({ method, path: requestPath, body }) => {
    if (method === 'GET' && requestPath === '/automation/capabilities') {
      return { body: { processes: [{ id: 'mesh-simplify' }] } };
    }

    if (method === 'POST' && requestPath === '/process-runs') {
      const payload = JSON.parse(body);

      assert.deepEqual(payload, {
        process_id: 'mesh-simplify',
        params: { mesh_path: 'meshes/in.glb' },
      });
      assert.equal(Object.hasOwn(payload.params, 'output_path'), false);

      return {
        body: {
          run_id: 'process-run-default-output',
          process_id: payload.process_id,
          status: 'accepted',
          params: payload.params,
        },
      };
    }

    if (method === 'GET' && requestPath === '/process-runs/process-run-default-output') {
      pollCount += 1;

      if (pollCount === 1) {
        return {
          body: {
            run_id: 'process-run-default-output',
            process_id: 'mesh-simplify',
            status: 'running',
            params: { mesh_path: 'meshes/in.glb' },
          },
        };
      }

      return {
        body: {
          run_id: 'process-run-default-output',
          process_id: 'mesh-simplify',
          status: 'succeeded',
          params: { mesh_path: 'meshes/in.glb' },
          output_url: 'file:///workspace/Exports/process-run-default-output.glb',
        },
      };
    }

    throw new Error(`Unexpected ${method} ${requestPath}`);
  });

  const client = createModlyApiClient({
    apiUrl: fastApi.url,
    automationUrl: bridge.url,
    processUrl: bridge.url,
  });

  const createResult = await runProcessRunCommand({
    args: ['create', '--process-id', 'mesh-simplify', '--params-json', '{"mesh_path":"meshes/in.glb"}'],
    client,
  });

  const waitCaptured = await captureStderr(() =>
    runProcessRunCommand({
      args: ['wait', 'process-run-default-output', '--interval-ms', '1', '--timeout-ms', '1000'],
      client,
    }),
  );

  assert.equal(createResult.data.run.run_id, 'process-run-default-output');
  assert.equal(createResult.data.run.outputUrl, undefined);
  assert.equal(waitCaptured.result.data.run.run_id, 'process-run-default-output');
  assert.equal(waitCaptured.result.data.run.status, 'succeeded');
  assert.equal(
    waitCaptured.result.data.run.outputUrl,
    'file:///workspace/Exports/process-run-default-output.glb',
  );
  assert.match(waitCaptured.stderr, /Process run process-run-default-output: running/u);
  assert.match(waitCaptured.stderr, /Process run process-run-default-output: succeeded/u);
  assert.deepEqual(
    fastApi.requests.map((request) => `${request.method} ${request.path}${request.search}`),
    ['GET /health', 'GET /health'],
  );
  assert.deepEqual(
    bridge.requests.map((request) => `${request.method} ${request.path}${request.search}`),
    [
      'GET /automation/capabilities',
      'POST /process-runs',
      'GET /process-runs/process-run-default-output',
      'GET /process-runs/process-run-default-output',
    ],
  );
  assert.equal(bridge.requests.some((request) => request.path.includes('/workflow-runs')), false);
  assert.equal(bridge.requests.some((request) => request.path === '/model/all'), false);
});

test('process-run create rejects non-canonical process_id before HTTP create', async () => {
  let createCalled = false;

  await assert.rejects(
    runProcessRunCommand({
      args: ['create', '--process-id', 'pretty-name', '--params-json', '{"mesh_path":"meshes/in.glb"}'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          return { processes: [{ id: 'mesh-simplify', label: 'Pretty name' }] };
        },
        async createProcessRun() {
          createCalled = true;
          return { run_id: 'process-run-123', status: 'accepted' };
        },
      },
    }),
    {
      code: 'VALIDATION_ERROR',
      message: 'Unknown canonical process_id: pretty-name.',
    },
  );

  assert.equal(createCalled, false);
});

test('process-run create rejects invalid workspace-relative paths locally', async () => {
  let createCalled = false;

  await assert.rejects(
    runProcessRunCommand({
      args: [
        'create',
        '--process-id',
        'mesh-simplify',
        '--workspace-path',
        '../escape',
        '--params-json',
        '{"mesh_path":"meshes/in.glb"}',
      ],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          return { processes: [{ id: 'mesh-simplify' }] };
        },
        async createProcessRun() {
          createCalled = true;
          return { run_id: 'process-run-123', status: 'accepted' };
        },
      },
    }),
    {
      code: 'VALIDATION_ERROR',
      message: 'workspace_path must be workspace-relative and must not contain traversal.',
    },
  );

  assert.equal(createCalled, false);
});

test('process-run create surfaces backend PROCESS_UNSUPPORTED unchanged', async () => {
  await assert.rejects(
    runProcessRunCommand({
      args: ['create', '--process-id', 'mesh-simplify', '--params-json', '{"mesh_path":"meshes/in.glb"}'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          return { processes: [{ id: 'mesh-simplify' }] };
        },
        async createProcessRun() {
          throw new ModlyError('Backend rejected process.', { code: 'PROCESS_UNSUPPORTED' });
        },
      },
    }),
    {
      code: 'PROCESS_UNSUPPORTED',
      message: 'Backend rejected process.',
    },
  );
});

test('process-run status and cancel validate runId and normalize stable payloads', async () => {
  await assert.rejects(
    runProcessRunCommand({
      args: ['status', '   '],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '<run-id> must be a non-empty string.',
    },
  );

  const statusResult = await runProcessRunCommand({
    args: ['status', 'run-42'],
    client: {
      async health() {
        return { status: 'ok' };
      },
      async getProcessRun() {
        return { process_id: 'mesh-simplify', status: 'running', params: { mesh_path: 'meshes/in.glb' } };
      },
    },
  });
  assert.equal(statusResult.data.run.run_id, 'run-42');
  assert.equal(statusResult.data.run.runId, 'run-42');
  assert.equal(statusResult.data.run.process_id, 'mesh-simplify');
  assert.equal(statusResult.data.run.status, 'running');

  const cancelResult = await runProcessRunCommand({
    args: ['cancel', 'run-42'],
    client: {
      async health() {
        return { status: 'ok' };
      },
      async cancelProcessRun(runId) {
        return { run_id: runId, process_id: 'mesh-simplify', status: 'canceled' };
      },
    },
  });
  assert.equal(cancelResult.data.run.run_id, 'run-42');
  assert.equal(cancelResult.data.run.processId, 'mesh-simplify');
  assert.equal(cancelResult.data.run.status, 'canceled');
});

test('process-run wait validates runId and polling overrides before polling', async () => {
  await assert.rejects(
    runProcessRunCommand({
      args: ['wait', '   '],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '<run-id> must be a non-empty string.',
    },
  );

  await assert.rejects(
    runProcessRunCommand({
      args: ['wait', 'run-42', '--interval-ms', '0'],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '--interval-ms must be >= 1.',
    },
  );

  await assert.rejects(
    runProcessRunCommand({
      args: ['wait', 'run-42', '--timeout-ms', 'abc'],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '--timeout-ms must be an integer.',
    },
  );
});

test('process-run wait checks health, prints progress to stderr, and returns terminal succeeded payload', async () => {
  const calls = [];
  const responses = [
    { run_id: 'run-42', process_id: 'mesh-simplify', status: 'running' },
    { run_id: 'run-42', process_id: 'mesh-simplify', status: 'succeeded', output_url: 'https://example.com/out.glb' },
  ];

  const { result, stderr } = await captureStderr(() =>
    runProcessRunCommand({
      args: ['wait', 'run-42', '--interval-ms', '1', '--timeout-ms', '30'],
      client: {
        async health() {
          calls.push('health');
          return { status: 'ok' };
        },
        async getProcessRun(runId) {
          calls.push(['getProcessRun', runId]);
          return responses.shift();
        },
      },
    }),
  );

  assert.deepEqual(calls, ['health', ['getProcessRun', 'run-42'], ['getProcessRun', 'run-42']]);
  assert.match(stderr, /Process run run-42: running/u);
  assert.match(stderr, /Process run run-42: succeeded/u);
  assert.equal(result.data.runId, 'run-42');
  assert.equal(result.data.intervalMs, 1);
  assert.equal(result.data.timeoutMs, 30);
  assert.equal(result.data.run.status, 'succeeded');
  assert.equal(result.data.run.outputUrl, 'https://example.com/out.glb');
  assert.equal(result.humanMessage, 'Process run run-42: succeeded.');
});

test('process-run wait returns terminal failed and canceled payloads as success results', async () => {
  const failed = await captureStderr(() =>
    runProcessRunCommand({
      args: ['wait', 'run-failed', '--interval-ms', '1', '--timeout-ms', '20'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getProcessRun() {
          return { run_id: 'run-failed', process_id: 'mesh-simplify', status: 'failed', error: 'mesh failed' };
        },
      },
    }),
  );
  assert.match(failed.stderr, /Process run run-failed: failed \(error=mesh failed\)/u);
  assert.equal(failed.result.data.run.status, 'failed');
  assert.equal(failed.result.humanMessage, 'Process run run-failed: failed.');

  const canceled = await captureStderr(() =>
    runProcessRunCommand({
      args: ['wait', 'run-canceled', '--interval-ms', '1', '--timeout-ms', '20'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getProcessRun() {
          return { run_id: 'run-canceled', process_id: 'mesh-simplify', status: 'canceled' };
        },
      },
    }),
  );
  assert.match(canceled.stderr, /Process run run-canceled: canceled/u);
  assert.equal(canceled.result.data.run.status, 'canceled');
  assert.equal(canceled.result.humanMessage, 'Process run run-canceled: canceled.');
});

test('process-run status, wait and cancel surface NOT_FOUND unchanged', async () => {
  await assert.rejects(
    runProcessRunCommand({
      args: ['status', 'missing-run'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getProcessRun() {
          throw new NotFoundError('404 Not Found for /process-runs/missing-run');
        },
      },
    }),
    {
      code: 'NOT_FOUND',
      message: '404 Not Found for /process-runs/missing-run',
    },
  );

  await assert.rejects(
    runProcessRunCommand({
      args: ['wait', 'missing-run'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getProcessRun() {
          throw new NotFoundError('404 Not Found for /process-runs/missing-run');
        },
      },
    }),
    {
      code: 'NOT_FOUND',
      message: '404 Not Found for /process-runs/missing-run',
    },
  );

  await assert.rejects(
    runProcessRunCommand({
      args: ['cancel', 'missing-run'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async cancelProcessRun() {
          throw new NotFoundError('404 Not Found for /process-runs/missing-run/cancel');
        },
      },
    }),
    {
      code: 'NOT_FOUND',
      message: '404 Not Found for /process-runs/missing-run/cancel',
    },
  );
});

test('process-run command rejects unknown subcommands', async () => {
  await assert.rejects(
    runProcessRunCommand({
      args: ['watch', 'run-42'],
      client: {},
    }),
    {
      code: 'INVALID_USAGE',
      message: 'Unknown process-run subcommand: watch. Available: create, status, wait, cancel.',
    },
  );
});

test('cli routing renders process-run help through the real entrypoint', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const result = spawnSync(process.execPath, ['src/cli/index.mjs', 'process-run', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /modly process-run/u);
  assert.match(result.stdout, /wait <run-id>/u);
});
