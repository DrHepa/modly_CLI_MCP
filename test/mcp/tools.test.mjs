import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { ValidationError } from '../../src/core/errors.mjs';
import { OPEN_INPUT_PATH_ALLOWLIST, createToolRegistry, matchesOpenInputPath } from '../../src/mcp/tools/index.mjs';
import { deriveRecipeStatusFromSteps } from '../../src/mcp/tools/handlers.mjs';

function notFoundResponse(message) {
  return jsonResponse({ detail: message }, { status: 404, statusText: 'Not Found' });
}

const originalFetch = globalThis.fetch;

const WORKFLOW_CREATE_DESCRIPTION =
  'Creates a workflow run from an input image as a canonical run primitive and returns recovery metadata so clients can continue polling the same runId via modly.workflowRun.status.';
const WORKFLOW_STATUS_DESCRIPTION =
  'Gets the latest workflow run state for this canonical run primitive. This is the preferred polling-first recovery tool for long-running agents using the same runId.';
const WORKFLOW_WAIT_DESCRIPTION =
  'Bounded convenience wrapper around canonical workflow-run status polling; prefer modly.workflowRun.status for recovery and use short timeout windows when you cannot poll yourself.';
const PROCESS_CREATE_DESCRIPTION =
  'Creates a process run as a canonical run primitive and returns recovery metadata so clients can continue polling the same runId via modly.processRun.status. outputPath is optional sugar for params.output_path. For mesh-optimizer/optimize and mesh-exporter/export, workspace_path is normalized to the mesh file and parent-directory input is autocorrected only when params.mesh_path identifies the local file unambiguously.';
const PROCESS_STATUS_DESCRIPTION =
  'Gets the latest process run state for this canonical run primitive. This is the preferred polling-first recovery tool for long-running agents using the same runId.';
const PROCESS_WAIT_DESCRIPTION =
  'Bounded convenience wrapper around canonical process-run status polling; prefer modly.processRun.status for recovery and use short timeout windows when you cannot poll yourself.';
const DIAGNOSTIC_GUIDANCE_INPUT_SCHEMA = {
  type: 'object',
  required: ['surface', 'error'],
  properties: {
    surface: { type: 'string' },
    error: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        code: { type: 'string' },
        details: { type: 'object' },
      },
      additionalProperties: false,
    },
    planner: {
      type: 'object',
      properties: {
        capability: { type: 'string' },
        status: { type: 'string' },
        surface: { type: 'string' },
        target: { type: 'object' },
        reasons: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    run: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['workflowRun', 'processRun'] },
        id: { type: 'string' },
        status: { type: 'string' },
        error: { type: 'object' },
      },
      additionalProperties: false,
    },
    capability: {
      type: 'object',
      properties: {
        requested: { type: 'string' },
        key: { type: 'string' },
      },
      additionalProperties: false,
    },
    execution: {
      type: 'object',
      properties: {
        surface: { type: 'string' },
      },
      additionalProperties: false,
    },
    runtimeEvidence: {
      type: 'object',
      properties: {
        requestedUrl: { type: 'string' },
        response: { type: 'object' },
        body: { type: 'object' },
        rawBody: { type: 'string' },
        cause: { type: 'object' },
      },
      additionalProperties: false,
    },
    liveContext: {
      type: 'object',
      properties: {
        health: { type: 'object' },
        capabilities: { type: 'object' },
        extensionErrors: { type: 'array', items: { type: 'object' } },
        runtimePaths: { type: 'object' },
      },
      additionalProperties: false,
    },
    logsExcerpt: { type: 'array', items: { type: 'string' } },
  },
  anyOf: [
    { properties: { error: { required: ['code'] } } },
    { required: ['runtimeEvidence'] },
    { required: ['run'] },
    { required: ['planner'] },
    { required: ['capability'] },
    { required: ['liveContext'] },
    { required: ['logsExcerpt'] },
  ],
  additionalProperties: false,
};

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

function assertCapabilityPlannerCallsStayReadOnly(calls) {
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assert.equal(calls.some((call) => call.path.includes('/workflow-runs')), false);
  assert.equal(calls.some((call) => call.path.includes('/process-runs')), false);
}

function assertNoCapabilityExecutionPosts(calls) {
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.includes('/workflow-runs')), false);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.includes('/process-runs')), false);
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

function getRecipeResume(result) {
  return result.structuredContent.data.nextAction.input.options.resume;
}

function createRecipeRegistry(overrides = {}) {
  return createToolRegistry({
    apiUrl: 'http://127.0.0.1:8765',
    experimentalRecipeExecution: true,
    ...overrides,
  });
}

const WORKFLOW_RECIPE_FIXTURES_DIR = path.resolve('test/fixtures/workflow-recipes');

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

test('registry catalog exposes modly.capability.plan as strict read-only input', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.capability.plan');

  assert.deepEqual(tool, {
    name: 'modly.capability.plan',
    title: 'Plan Smart Capability',
    description: 'Plans a known capability against live discovery without executing workflows or process runs.',
    inputSchema: {
      type: 'object',
      required: ['capability'],
      properties: {
        capability: { type: 'string' },
        params: { type: 'object' },
      },
      additionalProperties: false,
    },
  });
});

test('registry catalog exposes modly.capability.guide as strict read-only input', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.capability.guide');

  assert.deepEqual(tool, {
    name: 'modly.capability.guide',
    title: 'Guide Capability Usage',
    description: 'Read-only guidance for a capability against live discovery; checks health and automation capabilities without executing workflows or process runs.',
    inputSchema: {
      type: 'object',
      required: ['capability'],
      properties: {
        capability: { type: 'string' },
        params: { type: 'object' },
      },
      additionalProperties: false,
    },
  });
});

test('registry catalog exposes modly.diagnostic.guidance with the exact diagnostic evidence schema', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.diagnostic.guidance');

  assert.deepEqual(tool, {
    name: 'modly.diagnostic.guidance',
    title: 'Diagnostic Guidance',
    description: 'Read-only post-mortem guidance from observed structured failure evidence; it may consult read-only readiness snapshots, but does not execute fixes or hidden writes.',
    inputSchema: DIAGNOSTIC_GUIDANCE_INPUT_SCHEMA,
  });
});

test('modly.diagnostic.guidance returns conservative hypotheses using read-only automation context only', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'electron_ipc',
    error: {
      message: 'Extension IPC handshake failed.',
      code: 'IPC_UNAVAILABLE',
    },
    planner: {
      capability: 'scene.add',
      reasons: ['Extension IPC is not ready for this request.'],
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Diagnostic guidance: hypothesis/extension_runtime/high.');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.status, 'hypothesis');
  assert.equal(result.structuredContent.data.category, 'extension_runtime');
  assert.equal(result.structuredContent.data.layer, 'electron_ipc');
  assert.equal(result.structuredContent.data.component, 'extension');
  assert.equal(result.structuredContent.data.confidence, 'high');
  assert.equal(result.structuredContent.data.next_check.target, 'extension_errors');
  assert.deepEqual(result.structuredContent.data.matched_rules, [
    'extension.error_code',
    'extension.surface',
    'extension.planner_reason',
  ]);
  assert.equal(result.structuredContent.data.evidence.some((entry) => entry.path === 'error.code'), true);
  assert.equal(result.structuredContent.data.evidence.some((entry) => entry.path === 'planner.reasons'), true);
  assertCapabilityPlannerCallsStayReadOnly(calls);
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.diagnostic.guidance rejects free-text-only payloads that miss every anyOf branch', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'backend_api',
    error: {
      message: 'Something failed.',
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.tool, 'modly.diagnostic.guidance');
  assert.equal(result.structuredContent.error.details.path, 'input');
  assert.equal(result.structuredContent.error.details.reason, 'anyOf_no_match');
  assert.equal(result.structuredContent.error.details.firstFailure.details.path, 'input.error');
  assert.equal(result.structuredContent.error.details.firstFailure.details.missing, 'code');
  assert.equal(calls.length, 0);
});

test('registry catalog exposes modly.capability.execute with honest first-cut MVP wording', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.capability.execute');

  assert.deepEqual(tool, {
    name: 'modly.capability.execute',
    title: 'Execute Smart Capability',
    description:
      'Orchestration wrapper that plans a known capability against live discovery and, in this first executable MVP cut, dispatches supported image input to modly.workflowRun.createFromImage plus ONLY mesh-optimizer/optimize and mesh-exporter/export (default_backend output only; explicit outputPath unsupported) to modly.processRun.create. The canonical recovery surface remains modly.workflowRun.status/modly.processRun.status.',
    inputSchema: {
      type: 'object',
      required: ['capability', 'input'],
      properties: {
        capability: { type: 'string' },
        input: { type: 'object' },
        params: { type: 'object' },
      },
      additionalProperties: false,
    },
  });
});

test('registry catalog hides modly.recipe.execute by default when experimental execution is disabled', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.recipe.execute');

  assert.equal(tool, undefined);
});

test('registry catalog hides modly.recipe.catalog by default when experimental execution is disabled', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const tool = registry.catalog.find((entry) => entry.name === 'modly.recipe.catalog');

  assert.equal(tool, undefined);
});

test('registry catalog exposes modly.recipe.catalog as a read-only derived seam when experimental execution is enabled', () => {
  const registry = createRecipeRegistry();
  const tool = registry.catalog.find((entry) => entry.name === 'modly.recipe.catalog');

  assert.deepEqual(tool, {
    name: 'modly.recipe.catalog',
    title: 'List Derived Recipe Catalog',
    description:
      'Experimental read-only catalog of validated workflow-backed recipe snapshots from MODLY_RECIPE_WORKFLOW_CATALOG_DIR; returns derived workflow/* entries only, with source metadata, and does not advertise built-ins or arbitrary DAG execution.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
});

test('registry catalog exposes modly.recipe.execute with closed recipe v1 polling-first wording when experimental execution is enabled', () => {
  const registry = createRecipeRegistry();
  const tool = registry.catalog.find((entry) => entry.name === 'modly.recipe.execute');

  assert.deepEqual(tool, {
    name: 'modly.recipe.execute',
    title: 'Execute Guided Recipe',
    description:
      'Experimental orchestration wrapper that executes one built-in guided recipe or one validated workflow/* derived snapshot over existing workflow-run/process-run surfaces; fail-closed on raw DAG execution, drift, branching, retries, and hidden waits.',
    inputSchema: {
      type: 'object',
      required: ['recipe', 'input'],
      properties: {
        recipe: {
          type: 'string',
          pattern: '^(image_to_mesh|image_to_mesh_optimized|image_to_mesh_exported|workflow/[^\\s]+)$',
        },
        input: { type: 'object' },
        options: {
          type: 'object',
          properties: {
            resume: { type: 'object' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  });
});

test('modly.recipe.execute resolves workflow/* ids from the derived catalog and launches only canonical workflow runs', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-recipe-execute-derived-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(
    path.join(directory, 'eligible-hunyuan.json'),
    readFileSync(path.join(WORKFLOW_RECIPE_FIXTURES_DIR, 'eligible-hunyuan.json'), 'utf8'),
  );

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'hunyuan3d-mini',
            name: 'Hunyuan3D Mini',
            params_schema: [{ id: 'seed', type: 'integer' }],
          },
        ],
        processes: [
          { id: 'mesh-optimizer/optimize', name: 'Optimize Mesh', params_schema: [] },
          { id: 'mesh-exporter/export', name: 'Mesh Exporter', params_schema: [] },
        ],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'hunyuan3d-mini', name: 'Hunyuan3D Mini' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(method, 'POST');
      const body = init.body;
      assert.equal(body instanceof FormData, true);
      assert.equal(body.get('model_id'), 'hunyuan3d-mini');
      return jsonResponse({
        run_id: 'derived-workflow-run-1',
        status: 'queued',
        progress: 0,
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry({ recipeWorkflowCatalogDir: directory });
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'workflow/recipe-hunyuan3d-template',
    input: {
      imagePath,
      modelId: 'hunyuan3d-mini',
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe workflow/recipe-hunyuan3d-template: running.');
  assert.equal(result.structuredContent.data.recipe, 'workflow/recipe-hunyuan3d-template');
  assert.equal(result.structuredContent.data.limits.branching, false);
  assert.equal(result.structuredContent.data.steps[0].run.runId, 'derived-workflow-run-1');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/workflow-runs/from-image').length, 1);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/process-runs'), false);
});

test('modly.recipe.execute fails closed for derived workflow drift before any workflowRun/processRun POST', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({ backend_ready: true, models: [], processes: [], errors: [] });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry({
    recipeWorkflowCatalogDir: WORKFLOW_RECIPE_FIXTURES_DIR,
    resolveDerivedRecipeSnapshotForExecution: async () => {
      throw new ValidationError('Workflow-backed recipe workflow/recipe-hunyuan3d-template changed after catalog resolution; refresh modly.recipe.catalog before execution.', {
        details: {
          field: 'recipe',
          reason: 'derived_recipe_drift',
          recipe: 'workflow/recipe-hunyuan3d-template',
        },
      });
    },
  });

  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'workflow/recipe-hunyuan3d-template',
    input: {
      imagePath,
      modelId: 'hunyuan3d-mini',
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.reason, 'derived_recipe_drift');
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/workflow-runs/from-image'), false);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/process-runs'), false);
});

test('modly.recipe.catalog returns only valid derived entries from the configured directory without backend preflight', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path }) => {
    throw new Error(`Unexpected path: ${path}`);
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'modly-recipe-catalog-handler-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  for (const fileName of ['eligible-hunyuan.json', 'eligible-triposg.json', 'invalid-text-node.json', 'invalid-branch.json']) {
    await writeFile(
      path.join(directory, fileName),
      readFileSync(path.join(WORKFLOW_RECIPE_FIXTURES_DIR, fileName), 'utf8'),
    );
  }

  await writeFile(
    path.join(directory, 'hidden.json'),
    JSON.stringify({
      name: 'Test_Uni',
      nodes: [
        { id: 'image-input', type: 'imageNode', data: {} },
        { id: 'generate', type: 'triposg/generate', data: {} },
      ],
      edges: [{ from: 'image-input', to: 'generate' }],
    }, null, 2),
  );

  const registry = createToolRegistry({
    apiUrl: 'http://127.0.0.1:8765',
    experimentalRecipeExecution: true,
    recipeWorkflowCatalogDir: directory,
  });
  const result = await registry.invoke('modly.recipe.catalog', {});

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Derived recipe catalog entries: 2.');
  assert.deepEqual(
    result.structuredContent.data.recipes.map((entry) => ({
      id: entry.id,
      relativePath: entry.sourceWorkflow.relativePath,
      kind: entry.kind,
    })),
    [
      { id: 'workflow/recipe-hunyuan3d-template', relativePath: 'eligible-hunyuan.json', kind: 'derived' },
      { id: 'workflow/recipe-triposg-template', relativePath: 'eligible-triposg.json', kind: 'derived' },
    ],
  );
  assert.equal(calls.length, 0);
});

test('modly.recipe.catalog fails closed to an empty list when the configured directory is missing', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path }) => {
    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({
    apiUrl: 'http://127.0.0.1:8765',
    experimentalRecipeExecution: true,
    recipeWorkflowCatalogDir: path.join(os.tmpdir(), 'missing-modly-recipe-catalog-dir'),
  });
  const result = await registry.invoke('modly.recipe.catalog', {});

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Derived recipe catalog is empty.');
  assert.deepEqual(result.structuredContent.data.recipes, []);
  assert.equal(calls.length, 0);
});

test('modly.recipe.execute fails closed before validation, preflight, or handler work when experimental execution is disabled', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path }) => {
    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'not_in_allowlist',
    input: {
      imagePath: '',
    }
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'EXPERIMENTAL_FEATURE_DISABLED');
  assert.equal(result.structuredContent.error.message, 'modly.recipe.execute requires explicit opt-in.');
  assert.deepEqual(result.structuredContent.error.details, {
    tool: 'modly.recipe.execute',
    flag: 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE',
    reason: 'experimental_feature_disabled',
  });
  assert.equal(result.content[0].text, 'modly.recipe.execute requires explicit opt-in.');
  assert.deepEqual(calls, []);
});

test('modly.capability.execute dispatches optimizer input to processRun.create with transparent envelope', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-optimizer/optimize',
        params: {
          mesh_path: 'meshes/in.glb',
          target_faces: 12000,
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'meshes/in.glb',
      });
      return jsonResponse({
        run_id: 'optimizer-run-123',
        process_id: 'mesh-optimizer/optimize',
        status: 'accepted',
        params: {
          mesh_path: 'meshes/in.glb',
          target_faces: 12000,
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'meshes/in.glb',
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh optimizer',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
      workspacePath: 'workspace',
      outputPath: 'meshes/out.glb',
    },
    params: {
      targetFaces: 12000,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: supported via modly.processRun.create.');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      plan: {
        status: 'supported',
        cap: {
          key: 'mesh-optimizer',
          requested: 'mesh optimizer',
          matchedId: 'mesh-optimizer/optimize',
          matchedName: 'Optimize Mesh',
        },
        surface: 'processRun.create',
        target: {
          kind: 'process',
          id: 'mesh-optimizer/optimize',
          name: 'Optimize Mesh',
        },
        score: 105,
        params: {
          target_faces: 12000,
        },
        warnings: [],
        reasons: [
          'Requested capability matched registry entry "mesh-optimizer".',
          'Matched discovered id "mesh-optimizer/optimize" exactly. Discovery confirms 1 requested canonical param(s).',
          'Mapped alias "targetFaces" to canonical param "target_faces".',
        ],
      },
      execution: {
        executed: true,
        surface: 'modly.processRun.create',
        arguments: {
          process_id: 'mesh-optimizer/optimize',
          params: {
            mesh_path: 'meshes/in.glb',
            target_faces: 12000,
            output_path: 'meshes/out.glb',
          },
          workspace_path: 'meshes/in.glb',
        },
      },
      run: {
        run_id: 'optimizer-run-123',
        runId: 'optimizer-run-123',
        process_id: 'mesh-optimizer/optimize',
        processId: 'mesh-optimizer/optimize',
        status: 'accepted',
        params: {
          mesh_path: 'meshes/in.glb',
          target_faces: 12000,
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'meshes/in.glb',
        workspacePath: 'meshes/in.glb',
        outputUrl: undefined,
        error: undefined,
      },
      meta: {
        polling: {
          terminal: false,
          operation: {
            kind: 'processRun',
            runId: 'optimizer-run-123',
          },
          operationState: 'pending',
          nextAction: {
            kind: 'poll_status',
            tool: 'modly.processRun.status',
            input: { runId: 'optimizer-run-123' },
          },
          suggestedPollIntervalMs: 1000,
        },
        source: {
          tool: 'modly.capability.execute',
          planner: 'planSmartCapability',
        },
        limits: {
          singleStep: true,
          chaining: false,
          plannerGated: true,
          unsupportedExec: false,
        },
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'POST /process-runs'],
  );
});

test('modly.capability.execute derives workspace_path from meshPath for optimizer process runs', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-optimizer/optimize',
        params: {
          mesh_path: 'Default/assets/in.glb',
          target_faces: 12000,
        },
        workspace_path: 'Default/assets/in.glb',
      });
      return jsonResponse({
        run_id: 'optimizer-run-derived-workspace',
        process_id: 'mesh-optimizer/optimize',
        status: 'accepted',
        params: {
          mesh_path: 'Default/assets/in.glb',
          target_faces: 12000,
        },
        workspace_path: 'Default/assets/in.glb',
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh optimizer',
    input: {
      kind: 'mesh',
      meshPath: 'Default/assets/in.glb',
    },
    params: {
      targetFaces: 12000,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.execution.arguments.workspace_path, 'Default/assets/in.glb');
  assert.equal(result.structuredContent.data.run.workspace_path, 'Default/assets/in.glb');
  assert.equal(result.structuredContent.data.run.workspacePath, 'Default/assets/in.glb');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'POST /process-runs'],
  );
});

test('modly.capability.execute preserves transparent envelope when optimizer backend rejects execution', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-optimizer/optimize',
        params: {
          mesh_path: 'meshes/in.glb',
          target_faces: 12000,
          output_path: 'meshes/out.glb',
        },
        workspace_path: 'meshes/in.glb',
      });
      return jsonResponse(
        {
          error: {
            code: 'OPTIMIZER_REJECTED',
            message: 'Optimizer rejected the mesh.',
          },
        },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh optimizer',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
      workspacePath: 'workspace',
      outputPath: 'meshes/out.glb',
    },
    params: {
      targetFaces: 12000,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: supported via modly.processRun.create; backend rejected execution.');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      plan: {
        status: 'supported',
        cap: {
          key: 'mesh-optimizer',
          requested: 'mesh optimizer',
          matchedId: 'mesh-optimizer/optimize',
          matchedName: 'Optimize Mesh',
        },
        surface: 'processRun.create',
        target: {
          kind: 'process',
          id: 'mesh-optimizer/optimize',
          name: 'Optimize Mesh',
        },
        score: 105,
        params: {
          target_faces: 12000,
        },
        warnings: [],
        reasons: [
          'Requested capability matched registry entry "mesh-optimizer".',
          'Matched discovered id "mesh-optimizer/optimize" exactly. Discovery confirms 1 requested canonical param(s).',
          'Mapped alias "targetFaces" to canonical param "target_faces".',
        ],
      },
      execution: {
        executed: true,
        surface: 'modly.processRun.create',
        arguments: {
          process_id: 'mesh-optimizer/optimize',
          params: {
            mesh_path: 'meshes/in.glb',
            target_faces: 12000,
            output_path: 'meshes/out.glb',
          },
          workspace_path: 'meshes/in.glb',
        },
      },
      run: null,
      meta: {
        polling: null,
        source: {
          tool: 'modly.capability.execute',
          planner: 'planSmartCapability',
        },
        limits: {
          singleStep: true,
          chaining: false,
          plannerGated: true,
          unsupportedExec: false,
        },
      },
      error: {
        code: 'OPTIMIZER_REJECTED',
        message: '422 Error for /process-runs',
        details: {
          error: {
            code: 'OPTIMIZER_REJECTED',
            message: 'Optimizer rejected the mesh.',
          },
        },
        diagnostic: {
          surface: 'backend_api',
          error: {
            code: 'OPTIMIZER_REJECTED',
            message: '422 Error for /process-runs',
            details: {
              error: {
                code: 'OPTIMIZER_REJECTED',
                message: 'Optimizer rejected the mesh.',
              },
            },
          },
          planner: {
            capability: 'mesh-optimizer',
            status: 'supported',
            surface: 'processRun.create',
            target: {
              kind: 'process',
              id: 'mesh-optimizer/optimize',
              name: 'Optimize Mesh',
            },
            reasons: [
              'Requested capability matched registry entry "mesh-optimizer".',
              'Matched discovered id "mesh-optimizer/optimize" exactly. Discovery confirms 1 requested canonical param(s).',
              'Mapped alias "targetFaces" to canonical param "target_faces".',
            ],
          },
          capability: {
            requested: 'mesh optimizer',
            key: 'mesh-optimizer',
          },
          execution: {
            surface: 'modly.processRun.create',
          },
        },
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'POST /process-runs'],
  );
});

test('modly.diagnostic.guidance consumes a real modly.capability.execute diagnostic envelope without hallucinating', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-optimizer/optimize',
        params: {
          mesh_path: 'meshes/in.glb',
          target_faces: 12000,
        },
        workspace_path: 'meshes/in.glb',
      });

      const error = new Error('fetch failed');
      error.code = 'ECONNREFUSED';
      throw error;
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const executeResult = await registry.invoke('modly.capability.execute', {
    capability: 'mesh optimizer',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
      workspacePath: 'workspace',
    },
    params: {
      targetFaces: 12000,
    },
  });

  const diagnosticInput = executeResult.structuredContent.data.error.diagnostic;
  assert.equal(diagnosticInput.error.code, 'BACKEND_UNAVAILABLE');

  const guidanceResult = await registry.invoke('modly.diagnostic.guidance', diagnosticInput);

  assert.equal(guidanceResult.isError, undefined);
  assert.equal(['hypothesis', 'insufficient_evidence'].includes(guidanceResult.structuredContent.data.status), true);

  if (guidanceResult.structuredContent.data.status === 'hypothesis') {
    assert.equal(guidanceResult.structuredContent.data.category, 'backend_unavailable');
    assert.equal(['low', 'medium', 'high'].includes(guidanceResult.structuredContent.data.confidence), true);
  } else {
    assert.equal(guidanceResult.structuredContent.data.category, 'unknown');
    assert.equal(guidanceResult.structuredContent.data.confidence, 'none');
  }

  assert.equal(guidanceResult.structuredContent.data.category === 'routing_bridge', false);
  assert.equal(guidanceResult.structuredContent.data.evidence.some((entry) => entry.path === 'error.code'), true);
  assert.ok(
    guidanceResult.structuredContent.data.limits.some((entry) => entry.includes('Only structured evidence available to this analysis was used'))
    || guidanceResult.structuredContent.data.status === 'insufficient_evidence',
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      'GET /automation/capabilities',
      'POST /process-runs',
      'GET /health',
      'GET /automation/capabilities',
    ],
  );
});

test('modly.capability.plan does health preflight and returns planner output without execution', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [
              { id: 'num_inference_steps', type: 'integer' },
              { id: 'guidance_scale', type: 'number' },
            ],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.plan', {
    capability: 'TripoSG',
    params: {
      steps: 30,
      ignored: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      status: 'supported',
      cap: {
        key: 'triposg',
        requested: 'TripoSG',
        matchedId: 'triposg',
        matchedName: 'TripoSG',
      },
      surface: 'workflowRun.createFromImage',
      target: {
        kind: 'model',
        id: 'triposg',
        name: 'TripoSG',
      },
      score: 105,
      params: {
        num_inference_steps: 30,
      },
      warnings: [
        'Discarded param "ignored": it is not an allowed canonical id or alias for "triposg".',
      ],
      reasons: [
        'Requested capability matched registry entry "triposg".',
        'Matched discovered id "triposg" exactly. Discovery confirms 1 requested canonical param(s).',
        'Mapped alias "steps" to canonical param "num_inference_steps".',
      ],
    },
  });
  assertCapabilityPlannerCallsStayReadOnly(calls);
});

test('modly.capability.plan returns known_but_unavailable with factual reasons and warnings', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.plan', {
    capability: 'Hunyuan3D',
    params: { quality: 40 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.status, 'known_but_unavailable');
  assert.deepEqual(result.structuredContent.data.cap, {
    key: 'hunyuan3d',
    requested: 'Hunyuan3D',
    matchedId: null,
    matchedName: null,
  });
  assert.deepEqual(result.structuredContent.data.params, {});
  assert.deepEqual(result.structuredContent.data.warnings, [
    'Discarded param "quality": canonical param "num_inference_steps" is not available in discovery params_schema.',
  ]);
  assert.ok(result.structuredContent.data.reasons.some((reason) => reason.includes('matched registry entry "hunyuan3d"')));
  assert.ok(result.structuredContent.data.reasons.some((reason) => reason.includes('Discovery did not expose an executable candidate')));
  assert.equal(result.content[0].text, 'Capability plan: known_but_unavailable (hunyuan3d).');
  assertCapabilityPlannerCallsStayReadOnly(calls);
});

test('modly.capability.plan returns unknown for closed-registry misses without executing anything', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.plan', {
    capability: 'mesh decimator pro',
    params: { seed: 7 },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      status: 'unknown',
      cap: {
        key: null,
        requested: 'mesh decimator pro',
        matchedId: null,
        matchedName: null,
      },
      surface: null,
      target: null,
      score: null,
      params: {},
      warnings: ['Ignored params because the requested capability is outside the closed MVP registry.'],
      reasons: ['Requested capability did not match the closed smart-capability registry.'],
    },
  });
  assert.equal(result.content[0].text, 'Capability plan: unknown.');
  assertCapabilityPlannerCallsStayReadOnly(calls);
});

test('modly.capability.guide does health preflight and returns supported_now without execution', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [
              { id: 'num_inference_steps', type: 'integer' },
              { id: 'guidance_scale', type: 'number' },
            ],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.guide', {
    capability: 'TripoSG',
    params: {
      steps: 30,
      guidance: 7.5,
      decoder: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability guidance: supported_now (triposg).');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      requested: {
        capability: 'TripoSG',
        params: {
          steps: 30,
          guidance: 7.5,
          decoder: true,
        },
      },
      status: 'supported_now',
      capability_key: 'triposg',
      surface: 'workflowRun',
      target: {
        kind: 'model',
        id: 'triposg',
        name: 'TripoSG',
      },
      available_safe_params: {
        allowed: {
          canonical_ids: ['num_inference_steps', 'guidance_scale', 'foreground_ratio', 'faces', 'seed', 'use_flash_decoder'],
          aliases: {
            cfg: 'guidance_scale',
            decoder: 'use_flash_decoder',
            fg_ratio: 'foreground_ratio',
            foreground_ratio: 'foreground_ratio',
            guidance: 'guidance_scale',
            inference_steps: 'num_inference_steps',
            max_faces: 'faces',
            seed: 'seed',
            steps: 'num_inference_steps',
          },
        },
        available_now: {
          canonical_ids: ['num_inference_steps', 'guidance_scale'],
          aliases: {
            cfg: 'guidance_scale',
            guidance: 'guidance_scale',
            inference_steps: 'num_inference_steps',
            steps: 'num_inference_steps',
          },
        },
      },
      reasons: [
        'Requested capability matched registry entry "triposg".',
        'Matched discovered id "triposg" exactly. Discovery confirms 2 requested canonical param(s).',
        'Mapped alias "steps" to canonical param "num_inference_steps".',
        'Mapped alias "guidance" to canonical param "guidance_scale".',
      ],
      warnings: [
        'Discarded param "decoder": canonical param "use_flash_decoder" is not available in discovery params_schema.',
      ],
      discovered_extras: [],
    },
  });
  assertCapabilityPlannerCallsStayReadOnly(calls);
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.guide returns processRun guidance for known process capability without POSTs', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.guide', {
    capability: 'mesh optimizer',
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability guidance: supported_now (mesh-optimizer).');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      requested: {
        capability: 'mesh optimizer',
        params: {},
      },
      status: 'supported_now',
      capability_key: 'mesh-optimizer',
      surface: 'processRun',
      target: {
        kind: 'process',
        id: 'mesh-optimizer/optimize',
        name: 'Optimize Mesh',
      },
      available_safe_params: {
        allowed: {
          canonical_ids: ['target_faces'],
          aliases: {
            targetFaces: 'target_faces',
          },
        },
        available_now: {
          canonical_ids: ['target_faces'],
          aliases: {
            targetFaces: 'target_faces',
          },
        },
      },
      reasons: [
        'Requested capability matched registry entry "mesh-optimizer".',
        'Matched discovered id "mesh-optimizer/optimize" exactly.',
      ],
      warnings: [],
      discovered_extras: [],
    },
  });
  assertCapabilityPlannerCallsStayReadOnly(calls);
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.guide returns BACKEND_UNAVAILABLE when health preflight fails', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    assert.equal(path, '/health');
    throw new Error('connect ECONNREFUSED');
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.guide', {
    capability: 'TripoSG',
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(result.structuredContent.error.message, 'Modly backend is unavailable.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/health');
});

test('modly.capability.guide reports exporter as supported_now in the safe default-output slice', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-exporter/export',
            name: 'Mesh Exporter',
            params_schema: [{ id: 'output_format', type: 'string' }],
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.guide', {
    capability: 'mesh-exporter/export',
    params: { output_format: 'glb' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability guidance: supported_now (mesh-exporter).');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      requested: {
        capability: 'mesh-exporter/export',
        params: { output_format: 'glb' },
      },
      status: 'supported_now',
      capability_key: 'mesh-exporter',
      surface: 'processRun',
      target: {
        kind: 'process',
        id: 'mesh-exporter/export',
        name: 'Mesh Exporter',
      },
      available_safe_params: {
        allowed: {
          canonical_ids: ['output_format'],
          aliases: {},
        },
        available_now: {
          canonical_ids: ['output_format'],
          aliases: {},
        },
      },
      reasons: [
        'Requested capability matched registry entry "mesh-exporter".',
        'Matched discovered id "mesh-exporter/export" exactly. Discovery confirms 1 requested canonical param(s).',
      ],
      warnings: [],
      discovered_extras: [],
    },
  });
  assertCapabilityPlannerCallsStayReadOnly(calls);
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.guide keeps ambiguous ties non-executable and read-only', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'community-hunyuan3d-mini-a',
            name: 'Community Hunyuan3D Mini A',
            params_schema: [{ id: 'seed', type: 'integer' }],
          },
          {
            id: 'community-hunyuan3d-mini-b',
            name: 'Community Hunyuan3D Mini B',
            params_schema: [{ id: 'seed', type: 'integer' }],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.guide', {
    capability: 'Hunyuan3D',
    params: { seed: 99 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability guidance: known_but_unavailable (hunyuan3d).');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.status, 'known_but_unavailable');
  assert.equal(result.structuredContent.data.capability_key, 'hunyuan3d');
  assert.equal(result.structuredContent.data.surface, 'none');
  assert.equal(result.structuredContent.data.target, null);
  assert.deepEqual(result.structuredContent.data.available_safe_params.available_now, {
    canonical_ids: ['seed'],
    aliases: {
      seed: 'seed',
    },
  });
  assert.ok(result.structuredContent.data.warnings.some((warning) => warning.includes('multiple equivalent candidates')));
  assert.ok(result.structuredContent.data.reasons.some((reason) => reason.includes('remain tied')));
  assertCapabilityPlannerCallsStayReadOnly(calls);
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute dispatches image input to workflowRun.createFromImage with stable envelope', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [
              { id: 'num_inference_steps', type: 'integer' },
              { id: 'guidance_scale', type: 'number' },
            ],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(method, 'POST');
      const body = init.body;
      assert.equal(body instanceof FormData, true);
      assert.equal(body.get('model_id'), 'triposg');
      assert.equal(body.get('params'), JSON.stringify({ num_inference_steps: 30 }));
      return jsonResponse({
        run_id: 'cap-run-123',
        status: 'queued',
        progress: 0,
        scene_candidate: { path: 'outputs/mesh.glb' },
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'TripoSG',
    input: {
      kind: 'image',
      imagePath,
    },
    params: {
      steps: 30,
      ignored: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: supported via modly.workflowRun.createFromImage.');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      plan: {
        status: 'supported',
        cap: {
          key: 'triposg',
          requested: 'TripoSG',
          matchedId: 'triposg',
          matchedName: 'TripoSG',
        },
        surface: 'workflowRun.createFromImage',
        target: {
          kind: 'model',
          id: 'triposg',
          name: 'TripoSG',
        },
        score: 105,
        params: {
          num_inference_steps: 30,
        },
        warnings: [
          'Discarded param "ignored": it is not an allowed canonical id or alias for "triposg".',
        ],
        reasons: [
          'Requested capability matched registry entry "triposg".',
          'Matched discovered id "triposg" exactly. Discovery confirms 1 requested canonical param(s).',
          'Mapped alias "steps" to canonical param "num_inference_steps".',
        ],
      },
      execution: {
        executed: true,
        surface: 'modly.workflowRun.createFromImage',
        arguments: {
          imagePath,
          modelId: 'triposg',
          params: {
            num_inference_steps: 30,
          },
        },
      },
      run: {
        run_id: 'cap-run-123',
        runId: 'cap-run-123',
        status: 'queued',
        progress: 0,
        step: undefined,
        outputUrl: undefined,
        error: undefined,
        sceneCandidate: { path: 'outputs/mesh.glb' },
        scene_candidate: { path: 'outputs/mesh.glb' },
      },
      meta: {
        polling: {
          terminal: false,
          operation: {
            kind: 'workflowRun',
            runId: 'cap-run-123',
          },
          operationState: 'pending',
          nextAction: {
            kind: 'poll_status',
            tool: 'modly.workflowRun.status',
            input: { runId: 'cap-run-123' },
          },
          suggestedPollIntervalMs: 1000,
        },
        source: {
          tool: 'modly.capability.execute',
          planner: 'planSmartCapability',
        },
        limits: {
          singleStep: true,
          chaining: false,
          plannerGated: true,
          unsupportedExec: false,
        },
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'GET /model/all', 'POST /workflow-runs/from-image'],
  );
});

test('modly.capability.execute stays image-first and never chains into process execution', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [
          {
            extension_id: 'unirig-process-extension',
            node_id: 'rig-mesh',
            name: 'Rig Mesh',
            params_schema: { seed: { type: 'int' } },
          },
        ],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(method, 'POST');
      const body = init.body;
      assert.equal(body instanceof FormData, true);
      assert.equal(body.get('model_id'), 'triposg');
      return jsonResponse({
        run_id: 'cap-run-124',
        status: 'queued',
        progress: 0,
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'TripoSG',
    input: {
      kind: 'image',
      imagePath,
    },
    params: { steps: 24 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.execution.surface, 'modly.workflowRun.createFromImage');
  assert.equal(result.structuredContent.data.meta.limits.chaining, false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'GET /model/all', 'POST /workflow-runs/from-image'],
  );
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.includes('/process-runs')), false);
});

test('modly.capability.execute keeps UniRig blocked even when discovery exposes it', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            extension_id: 'unirig-process-extension',
            node_id: 'rig-mesh',
            name: 'Rig Mesh',
            params_schema: { seed: { type: 'int' } },
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'UniRig',
    input: {
      kind: 'workspace',
      meshPath: 'meshes/in.glb',
      workspacePath: 'workspace',
      outputPath: 'meshes/out.glb',
    },
    params: { seed: 12345 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: known_but_unavailable; not executed.');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      plan: {
        status: 'known_but_unavailable',
        cap: {
          key: 'unirig',
          requested: 'UniRig',
          matchedId: 'unirig-process-extension/rig-mesh',
          matchedName: 'Rig Mesh',
        },
        surface: 'processRun.create',
        target: null,
        score: 105,
        params: { seed: 12345 },
        warnings: [],
        reasons: [
          'Requested capability matched registry entry "unirig".',
          'Matched discovered id "unirig-process-extension/rig-mesh" exactly. Discovery confirms 1 requested canonical param(s).',
          'This capability is known but intentionally unavailable for the current MVP surface.',
          'Discovery matched a candidate, but the closed capability-execute allowlist does not permit supported execution for this capability.',
        ],
      },
      execution: {
        executed: false,
        surface: null,
        arguments: null,
      },
      run: null,
      meta: {
        polling: null,
        source: {
          tool: 'modly.capability.execute',
          planner: 'planSmartCapability',
        },
        limits: {
          singleStep: true,
          chaining: false,
          plannerGated: true,
          unsupportedExec: false,
        },
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.recipe.execute first call creates exactly one workflow run and returns polling resume state', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(method, 'POST');
      const body = init.body;
      assert.equal(body instanceof FormData, true);
      assert.equal(body.get('model_id'), 'triposg');
      assert.equal(body.get('params'), JSON.stringify({ steps: 28 }));
      return jsonResponse({
        run_id: 'recipe-workflow-1',
        status: 'queued',
        progress: 0,
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh',
    input: {
      imagePath,
      modelId: 'triposg',
      modelParams: { steps: 28 },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh: running.');
  assert.equal(result.structuredContent.data.status, 'running');
  assert.deepEqual(result.structuredContent.data.runIds, { generate_mesh: 'recipe-workflow-1' });
  assert.equal(result.structuredContent.data.steps.length, 1);
  assert.equal(result.structuredContent.data.steps[0].id, 'generate_mesh');
  assert.equal(result.structuredContent.data.steps[0].status, 'running');
  assert.deepEqual(result.structuredContent.data.steps[0].run, {
    kind: 'workflowRun',
    runId: 'recipe-workflow-1',
    status: 'queued',
  });
  assert.equal(result.structuredContent.data.nextAction.kind, 'poll');
  assert.deepEqual(getRecipeResume(result), {
    steps: [
      {
        id: 'generate_mesh',
        status: 'running',
        run: {
          kind: 'workflowRun',
          runId: 'recipe-workflow-1',
          status: 'queued',
        },
        poll: {
          tool: 'modly.workflowRun.status',
          input: { runId: 'recipe-workflow-1' },
          intervalMs: 1000,
        },
      },
    ],
  });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities', 'GET /model/all', 'POST /workflow-runs/from-image'],
  );
});

test('deriveRecipeStatusFromSteps returns partial_failed for failed plus pending after prior success', () => {
  assert.equal(deriveRecipeStatusFromSteps([
    { id: 'generate_mesh', status: 'succeeded' },
    { id: 'optimize_mesh', status: 'failed' },
    { id: 'publish_mesh', status: 'pending' },
  ]), 'partial_failed');
});

test('modly.recipe.execute bypasses planner model discovery when /model/all exposes the canonical model id', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'canon-bypass-1', name: 'Canonical Bypass 1' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(method, 'POST');
      const body = init.body;
      assert.equal(body instanceof FormData, true);
      assert.equal(body.get('model_id'), 'canon-bypass-1');
      assert.equal(body.get('params'), JSON.stringify({ seed: 7 }));
      return jsonResponse({
        run_id: 'recipe-workflow-bypass',
        status: 'queued',
        progress: 0,
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh',
    input: {
      imagePath,
      modelId: 'canon-bypass-1',
      modelParams: { seed: 7 },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh: running.');
  assert.equal(result.structuredContent.data.status, 'running');
  assert.equal(result.structuredContent.data.steps[0].status, 'running');
  assert.equal(result.structuredContent.data.steps[0].run.runId, 'recipe-workflow-bypass');
  assert.equal(result.structuredContent.data.nextAction.kind, 'poll');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/workflow-runs/from-image').length, 1);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities', 'GET /model/all', 'POST /workflow-runs/from-image'],
  );
});

test('modly.recipe.execute fails before workflow launch when input.modelId is absent from /model/all', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh',
    input: {
      imagePath,
      modelId: 'missing-model',
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh: failed.');
  assert.equal(result.structuredContent.data.status, 'failed');
  assert.equal(result.structuredContent.data.nextAction.kind, 'none');
  assert.equal(result.structuredContent.data.steps[0].status, 'failed');
  assert.deepEqual(result.structuredContent.data.steps[0].error, {
    code: 'VALIDATION_ERROR',
    message: 'Unknown canonical modelId: missing-model.',
    details: {
      field: 'modelId',
      reason: 'non_canonical_model_id',
      modelId: 'missing-model',
    },
  });
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/workflow-runs/from-image'), false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities', 'GET /model/all'],
  );
});

test('modly.recipe.execute rejects recipes outside the closed v1 allowlist before any runs', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => {
    throw new Error('Unexpected fetch for closed recipe validation.');
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'custom_goal',
    input: {},
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.path, 'input.recipe');
  assert.equal(result.structuredContent.error.details.reason, 'pattern_no_match');
  assert.equal(result.structuredContent.error.details.received, 'custom_goal');
  assert.equal(calls.length, 0);
});

test('modly.recipe.execute resume polls active run, advances one next step, and finishes without extra POSTs', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);
  let phase = 'first';

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(phase, 'first');
      assert.equal(method, 'POST');
      return jsonResponse({
        run_id: 'recipe-workflow-2',
        status: 'queued',
        progress: 0,
      });
    }

    if (path === '/workflow-runs/recipe-workflow-2') {
      assert.equal(phase, 'second');
      assert.equal(method, 'GET');
      return jsonResponse({
        run_id: 'recipe-workflow-2',
        status: 'done',
        scene_candidate: { path: 'workspace/generated.glb' },
      });
    }

    if (path === '/process-runs') {
      assert.equal(phase, 'second');
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-optimizer/optimize',
        params: {
          mesh_path: 'workspace/generated.glb',
          target_faces: 12000,
          output_path: 'workspace/optimized.glb',
        },
        workspace_path: 'workspace/generated.glb',
      });
      return jsonResponse({
        run_id: 'recipe-process-2',
        process_id: 'mesh-optimizer/optimize',
        status: 'accepted',
        params: {
          mesh_path: 'workspace/generated.glb',
          target_faces: 12000,
          output_path: 'workspace/optimized.glb',
        },
        workspace_path: 'workspace/generated.glb',
      });
    }

    if (path === '/process-runs/recipe-process-2') {
      assert.equal(phase, 'third');
      assert.equal(method, 'GET');
      return jsonResponse({
        run_id: 'recipe-process-2',
        process_id: 'mesh-optimizer/optimize',
        status: 'succeeded',
        params: {
          mesh_path: 'workspace/generated.glb',
          target_faces: 12000,
          output_path: 'workspace/optimized.glb',
        },
        workspace_path: 'workspace/generated.glb',
      });
    }

    throw new Error(`Unexpected path in phase ${phase}: ${path}`);
  });

  const registry = createRecipeRegistry();

  const first = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
  });

  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.data.status, 'running');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);

  phase = 'second';
  const second = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
    options: {
      resume: getRecipeResume(first),
    },
  });

  assert.equal(second.isError, undefined);
  assert.equal(second.structuredContent.data.status, 'running');
  assert.deepEqual(second.structuredContent.data.runIds, {
    generate_mesh: 'recipe-workflow-2',
    optimize_mesh: 'recipe-process-2',
  });
  assert.equal(second.structuredContent.data.steps[0].status, 'succeeded');
  assert.deepEqual(second.structuredContent.data.steps[0].outputs, {
    meshPath: 'workspace/generated.glb',
    sceneCandidate: { path: 'workspace/generated.glb' },
  });
  assert.equal(second.structuredContent.data.steps[1].status, 'running');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);

  phase = 'third';
  const third = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
    options: {
      resume: getRecipeResume(second),
    },
  });

  assert.equal(third.isError, undefined);
  assert.equal(third.content[0].text, 'Guided recipe image_to_mesh_optimized: succeeded.');
  assert.equal(third.structuredContent.data.status, 'succeeded');
  assert.equal(third.structuredContent.data.nextAction.kind, 'none');
  assert.deepEqual(third.structuredContent.data.outputs, {
    meshPath: 'workspace/optimized.glb',
    sceneCandidate: { path: 'workspace/generated.glb' },
  });
  assert.equal(third.structuredContent.data.steps[0].status, 'succeeded');
  assert.equal(third.structuredContent.data.steps[1].status, 'succeeded');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      'GET /health',
      'GET /automation/capabilities',
      'GET /model/all',
      'POST /workflow-runs/from-image',
      'GET /health',
      'GET /health',
      'GET /automation/capabilities',
      'GET /workflow-runs/recipe-workflow-2',
      'POST /process-runs',
      'GET /health',
      'GET /health',
      'GET /automation/capabilities',
      'GET /process-runs/recipe-process-2',
    ],
  );
});

test('modly.recipe.execute returns partial_failed after downstream process failure while preserving observed outputs', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);
  let phase = 'first';

  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(phase, 'first');
      return jsonResponse({ run_id: 'recipe-workflow-fail', status: 'queued' });
    }

    if (path === '/workflow-runs/recipe-workflow-fail') {
      assert.equal(phase, 'second');
      return jsonResponse({
        run_id: 'recipe-workflow-fail',
        status: 'done',
        scene_candidate: { path: 'workspace/generated.glb' },
      });
    }

    if (path === '/process-runs') {
      assert.equal(phase, 'second');
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-optimizer/optimize',
        params: {
          mesh_path: 'workspace/generated.glb',
          target_faces: 12000,
          output_path: 'workspace/optimized.glb',
        },
        workspace_path: 'workspace/generated.glb',
      });
      return jsonResponse({
        run_id: 'recipe-process-fail',
        process_id: 'mesh-optimizer/optimize',
        status: 'accepted',
        params: {
          mesh_path: 'workspace/generated.glb',
          target_faces: 12000,
          output_path: 'workspace/optimized.glb',
        },
        workspace_path: 'workspace/generated.glb',
      });
    }

    if (path === '/process-runs/recipe-process-fail') {
      assert.equal(phase, 'third');
      return jsonResponse({
        run_id: 'recipe-process-fail',
        process_id: 'mesh-optimizer/optimize',
        status: 'failed',
        params: {
          mesh_path: 'workspace/generated.glb',
          target_faces: 12000,
          output_path: 'workspace/optimized.glb',
        },
        workspace_path: 'workspace/generated.glb',
        error: {
          code: 'OPTIMIZER_FAILED',
          message: 'Optimizer failed after launch.',
        },
      });
    }

    throw new Error(`Unexpected path in phase ${phase}: ${path}`);
  });

  const registry = createRecipeRegistry();

  const first = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
  });

  phase = 'second';
  const second = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
    options: { resume: getRecipeResume(first) },
  });

  phase = 'third';
  const third = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
    options: { resume: getRecipeResume(second) },
  });

  assert.equal(third.isError, undefined);
  assert.equal(third.content[0].text, 'Guided recipe image_to_mesh_optimized: partial_failed.');
  assert.equal(third.structuredContent.data.status, 'partial_failed');
  assert.equal(third.structuredContent.data.nextAction.kind, 'none');
  assert.deepEqual(third.structuredContent.data.outputs, {
    meshPath: 'workspace/generated.glb',
    sceneCandidate: { path: 'workspace/generated.glb' },
  });
  assert.equal(third.structuredContent.data.steps[0].status, 'succeeded');
  assert.equal(third.structuredContent.data.steps[1].status, 'failed');
  assert.deepEqual(third.structuredContent.data.steps[1].error, {
    code: 'OPTIMIZER_FAILED',
    message: 'Optimizer failed after launch.',
  });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});

test('modly.recipe.execute terminalizes failed plus pending resume states without suggesting more polling', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [{ id: 'triposg', name: 'TripoSG' }],
        processes: [{ id: 'mesh-optimizer/optimize', name: 'Optimize Mesh', params_schema: [] }],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
    options: {
      resume: {
        steps: [
          {
            id: 'generate_mesh',
            status: 'failed',
            error: {
              code: 'WORKFLOW_FAILED',
              message: 'Workflow failed before producing outputs.',
            },
          },
        ],
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh_optimized: failed.');
  assert.equal(result.structuredContent.data.status, 'failed');
  assert.equal(result.structuredContent.data.nextAction.kind, 'none');
  assert.equal(result.structuredContent.data.steps[0].status, 'failed');
  assert.equal(result.structuredContent.data.steps[1].status, 'pending');
  assert.equal(calls.some((call) => call.path === '/workflow-runs/from-image'), false);
  assert.equal(calls.some((call) => call.path === '/process-runs'), false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities'],
  );
});

test('modly.recipe.execute keeps recipe running when resume still has a running step plus pending work', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path, method }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [{ id: 'triposg', name: 'TripoSG' }],
        processes: [{ id: 'mesh-optimizer/optimize', name: 'Optimize Mesh', params_schema: [] }],
        errors: [],
      });
    }

    if (path === '/workflow-runs/running-recipe-workflow') {
      assert.equal(method, 'GET');
      return jsonResponse({
        run_id: 'running-recipe-workflow',
        status: 'running',
        progress: 42,
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_optimized',
    input: {
      imagePath,
      modelId: 'triposg',
      optimize: {
        outputPath: 'workspace/optimized.glb',
        params: { targetFaces: 12000 },
      },
    },
    options: {
      resume: {
        steps: [
          {
            id: 'generate_mesh',
            status: 'running',
            run: {
              kind: 'workflowRun',
              runId: 'running-recipe-workflow',
              status: 'queued',
            },
            poll: {
              tool: 'modly.workflowRun.status',
              input: { runId: 'running-recipe-workflow' },
              intervalMs: 1000,
            },
          },
        ],
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh_optimized: running.');
  assert.equal(result.structuredContent.data.status, 'running');
  assert.equal(result.structuredContent.data.nextAction.kind, 'poll');
  assert.equal(result.structuredContent.data.steps[0].status, 'running');
  assert.equal(result.structuredContent.data.steps[1].status, 'pending');
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/process-runs'), false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities', 'GET /workflow-runs/running-recipe-workflow'],
  );
});

test('modly.recipe.execute keeps export_mesh planner-gated on resume when exporter support is unavailable', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [{ id: 'triposg', name: 'TripoSG' }],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_exported',
    input: {
      imagePath,
      modelId: 'triposg',
      export: { outputFormat: 'glb' },
    },
    options: {
      resume: {
        steps: [
          {
            id: 'generate_mesh',
            status: 'succeeded',
            outputs: {
              meshPath: 'workspace/generated.glb',
              sceneCandidate: { path: 'workspace/generated.glb' },
            },
          },
        ],
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh_exported: partial_failed.');
  assert.equal(result.structuredContent.data.status, 'partial_failed');
  assert.equal(result.structuredContent.data.nextAction.kind, 'none');
  assert.equal(result.structuredContent.data.steps[0].status, 'succeeded');
  assert.equal(result.structuredContent.data.steps[1].status, 'failed');
  assert.deepEqual(result.structuredContent.data.steps[1].error, {
    code: 'VALIDATION_ERROR',
    message: 'Recipe step export_mesh is unavailable for image_to_mesh_exported.',
    details: {
      field: 'recipe',
      reason: 'recipe_step_unavailable',
      recipe: 'image_to_mesh_exported',
      stepId: 'export_mesh',
      planStatus: 'known_but_unavailable',
      planSurface: 'processRun.create',
      planTargetKind: null,
    },
  });
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/process-runs'), false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities'],
  );
});

test('modly.recipe.execute fails explicitly when a required output is missing between steps', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);
  let phase = 'first';

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [
          {
            id: 'mesh-exporter/export',
            name: 'Mesh Exporter',
            params_schema: [{ id: 'output_format', type: 'string' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/model/all') {
      return jsonResponse({ models: [{ id: 'triposg', name: 'TripoSG' }] });
    }

    if (path === '/workflow-runs/from-image') {
      assert.equal(phase, 'first');
      return jsonResponse({ run_id: 'recipe-workflow-missing-output', status: 'queued' });
    }

    if (path === '/workflow-runs/recipe-workflow-missing-output') {
      assert.equal(phase, 'second');
      return jsonResponse({
        run_id: 'recipe-workflow-missing-output',
        status: 'done',
        scene_candidate: { id: 'scene-without-path' },
      });
    }

    throw new Error(`Unexpected path in phase ${phase}: ${path}`);
  });

  const registry = createRecipeRegistry();

  const first = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_exported',
    input: {
      imagePath,
      modelId: 'triposg',
      export: { outputFormat: 'glb' },
    },
  });

  phase = 'second';
  const second = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_exported',
    input: {
      imagePath,
      modelId: 'triposg',
      export: { outputFormat: 'glb' },
    },
    options: { resume: getRecipeResume(first) },
  });

  assert.equal(second.isError, undefined);
  assert.equal(second.content[0].text, 'Guided recipe image_to_mesh_exported: failed.');
  assert.equal(second.structuredContent.data.status, 'failed');
  assert.equal(second.structuredContent.data.nextAction.kind, 'none');
  assert.deepEqual(second.structuredContent.data.outputs, {
    sceneCandidate: { id: 'scene-without-path' },
  });
  assert.equal(second.structuredContent.data.steps[0].status, 'failed');
  assert.deepEqual(second.structuredContent.data.steps[0].error, {
    code: 'VALIDATION_ERROR',
    message: 'Recipe step export_mesh requires an observed meshPath from a previous step.',
    details: {
      field: 'steps.outputs.meshPath',
      reason: 'missing_required_output',
      recipe: 'image_to_mesh_exported',
      stepId: 'export_mesh',
      required: 'meshPath',
    },
  });
  assert.equal(calls.some((call) => call.path === '/process-runs'), false);
});

test('modly.recipe.execute rejects exporter outputPath outside the default_output_only slice before any runs', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);
  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_exported',
    input: {
      imagePath,
      modelId: 'triposg',
      export: {
        outputPath: 'workspace/export.glb',
      },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.reason, 'unsupported_output_path_mvp');
  assert.equal(result.structuredContent.error.details.field, 'input.export.outputPath');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}${call.search}`), ['GET /health']);
});

test('modly.recipe.execute rejects exporter params.output_path outside the default_output_only slice before any runs', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);
  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh_exported',
    input: {
      imagePath,
      modelId: 'triposg',
      export: {
        params: {
          output_path: 'workspace/export.glb',
        },
      },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.reason, 'unsupported_output_path_mvp');
  assert.equal(result.structuredContent.error.details.field, 'input.export.params.output_path');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}${call.search}`), ['GET /health']);
});

test('modly.recipe.execute short-circuits with an explicit backend-not-ready envelope and no business runs', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: false,
        models: [],
        processes: [],
        errors: [{ message: 'Model runtime not ready yet.' }],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createRecipeRegistry();
  const result = await registry.invoke('modly.recipe.execute', {
    recipe: 'image_to_mesh',
    input: {
      imagePath,
      modelId: 'triposg',
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Guided recipe image_to_mesh: failed.');
  assert.equal(result.structuredContent.data.status, 'failed');
  assert.equal(result.structuredContent.data.nextAction.kind, 'none');
  assert.equal(result.structuredContent.data.steps[0].status, 'failed');
  assert.deepEqual(result.structuredContent.data.steps[0].error, {
    code: 'BACKEND_NOT_READY',
    message: 'Modly backend is not ready for guided recipe image_to_mesh.',
    details: {
      field: 'recipe',
      reason: 'backend_not_ready',
      recipe: 'image_to_mesh',
      health_status: 'ok',
      backend_ready: false,
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /health', 'GET /automation/capabilities'],
  );
  assert.equal(calls.some((call) => call.method === 'POST'), false);
});

test('modly.capability.execute dispatches exporter through processRun.create with default backend output mode', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-exporter/export',
            name: 'Mesh Exporter',
            params_schema: [{ id: 'output_format', type: 'string' }],
          },
        ],
        errors: [],
      });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        process_id: 'mesh-exporter/export',
        params: {
          mesh_path: 'meshes/in.glb',
          output_format: 'glb',
        },
        workspace_path: 'meshes/in.glb',
      });
      return jsonResponse({
        run_id: 'exporter-run-123',
        process_id: 'mesh-exporter/export',
        status: 'accepted',
        params: {
          mesh_path: 'meshes/in.glb',
          output_format: 'glb',
        },
        workspace_path: 'meshes/in.glb',
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh-exporter/export',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
      workspacePath: 'workspace',
    },
    params: { output_format: 'glb' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: supported via modly.processRun.create.');
  assert.equal(result.structuredContent.data.plan.status, 'supported');
  assert.equal(result.structuredContent.data.execution.executed, true);
  assert.equal(result.structuredContent.data.execution.outputMode, 'default_backend');
  assert.deepEqual(result.structuredContent.data.execution.arguments, {
    process_id: 'mesh-exporter/export',
    params: {
      mesh_path: 'meshes/in.glb',
      output_format: 'glb',
    },
    workspace_path: 'meshes/in.glb',
  });
  assert.equal('outputPath' in result.structuredContent.data.execution.arguments, false);
  assert.equal('output_path' in result.structuredContent.data.execution.arguments.params, false);
  assert.equal(result.structuredContent.data.run.runId, 'exporter-run-123');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities', 'POST /process-runs'],
  );
});

test('modly.capability.execute rejects explicit exporter outputPath before POST', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-exporter/export',
            name: 'Mesh Exporter',
            params_schema: [{ id: 'output_format', type: 'string' }, { id: 'output_path', type: 'string' }],
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh-exporter/export',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
      outputPath: 'exports/out.glb',
    },
    params: { output_format: 'glb' },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(result.structuredContent.error.details, {
    field: 'input.outputPath',
    reason: 'unsupported_output_path_mvp',
    capability: 'mesh-exporter/export',
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute rejects explicit exporter params.output_path before POST', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-exporter/export',
            name: 'Mesh Exporter',
            params_schema: [{ id: 'output_format', type: 'string' }, { id: 'output_path', type: 'string' }],
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh-exporter/export',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
    },
    params: {
      output_format: 'glb',
      output_path: 'exports/out.glb',
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(result.structuredContent.error.details, {
    field: 'params.output_path',
    reason: 'unsupported_output_path_mvp',
    capability: 'mesh-exporter/export',
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute rejects exporter absolute and traversal meshPath before POST', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-exporter/export',
            name: 'Mesh Exporter',
            params_schema: [{ id: 'output_format', type: 'string' }],
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });

  const absolutePathResult = await registry.invoke('modly.capability.execute', {
    capability: 'mesh-exporter/export',
    input: {
      kind: 'mesh',
      meshPath: '/tmp/in.glb',
    },
    params: { output_format: 'glb' },
  });

  assert.equal(absolutePathResult.isError, true);
  assert.equal(absolutePathResult.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(absolutePathResult.structuredContent.error.details, {
    field: 'input.meshPath',
    reason: 'absolute_path',
    value: '/tmp/in.glb',
  });

  const traversalPathResult = await registry.invoke('modly.capability.execute', {
    capability: 'mesh-exporter/export',
    input: {
      kind: 'mesh',
      meshPath: '../meshes/in.glb',
    },
    params: { output_format: 'glb' },
  });

  assert.equal(traversalPathResult.isError, true);
  assert.equal(traversalPathResult.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(traversalPathResult.structuredContent.error.details, {
    field: 'input.meshPath',
    reason: 'path_traversal',
    value: '../meshes/in.glb',
  });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      'GET /automation/capabilities',
      'GET /health',
      'GET /automation/capabilities',
    ],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute keeps Add to Scene out of scope and does not execute', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'Add to Scene',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
    },
    params: { scene: 'main' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: unknown; not executed.');
  assert.equal(result.structuredContent.data.plan.status, 'unknown');
  assert.equal(result.structuredContent.data.execution.executed, false);
  assert.equal(result.structuredContent.data.run, null);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute returns unknown without POST and keeps stable envelope', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh decimator pro',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
    },
    params: { seed: 7 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Capability execution: unknown; not executed.');
  assert.deepEqual(result.structuredContent, {
    ok: true,
    data: {
      plan: {
        status: 'unknown',
        cap: {
          key: null,
          requested: 'mesh decimator pro',
          matchedId: null,
          matchedName: null,
        },
        surface: null,
        target: null,
        score: null,
        params: {},
        warnings: ['Ignored params because the requested capability is outside the closed MVP registry.'],
        reasons: ['Requested capability did not match the closed smart-capability registry.'],
      },
      execution: {
        executed: false,
        surface: null,
        arguments: null,
      },
      run: null,
      meta: {
        polling: null,
        source: {
          tool: 'modly.capability.execute',
          planner: 'planSmartCapability',
        },
        limits: {
          singleStep: true,
          chaining: false,
          plannerGated: true,
          unsupportedExec: false,
        },
      },
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute rejects invalid input shape before any execution POST', { concurrency: false }, async (t) => {
  t.after(resetFetch);
  const imagePath = await createTempImage(t);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [
          {
            id: 'triposg',
            name: 'TripoSG',
            params_schema: [{ id: 'num_inference_steps', type: 'integer' }],
          },
        ],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });

  const invalidImageKind = await registry.invoke('modly.capability.execute', {
    capability: 'TripoSG',
    input: {
      kind: 'mesh',
      meshPath: 'meshes/in.glb',
    },
    params: { steps: 30 },
  });

  assert.equal(invalidImageKind.isError, true);
  assert.equal(invalidImageKind.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(invalidImageKind.structuredContent.error.details, {
    field: 'input.kind',
    reason: 'invalid_workflow_input_kind',
    value: 'mesh',
  });

  const invalidImagePath = await registry.invoke('modly.capability.execute', {
    capability: 'TripoSG',
    input: {
      kind: 'image',
      imagePath: '   ',
    },
    params: { steps: 30 },
  });

  assert.equal(invalidImagePath.isError, true);
  assert.equal(invalidImagePath.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(invalidImagePath.structuredContent.error.details, {
    field: 'input.imagePath',
    reason: 'invalid_image_path',
  });

  const invalidInputShape = await registry.invoke('modly.capability.execute', {
    capability: 'TripoSG',
    input: imagePath,
    params: { steps: 30 },
  });

  assert.equal(invalidInputShape.isError, true);
  assert.equal(invalidInputShape.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidInputShape.structuredContent.error.details.tool, 'modly.capability.execute');
  assert.equal(invalidInputShape.structuredContent.error.details.path, 'input.input');
  assert.equal(invalidInputShape.structuredContent.error.details.expected, 'object');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      'GET /automation/capabilities',
      'GET /health',
      'GET /automation/capabilities',
    ],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('modly.capability.execute rejects optimizer input when meshPath is missing before POST', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [
          {
            id: 'mesh-optimizer/optimize',
            name: 'Optimize Mesh',
            params_schema: [{ id: 'target_faces', type: 'integer' }],
          },
        ],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.capability.execute', {
    capability: 'mesh optimizer',
    input: {
      kind: 'mesh',
      workspacePath: 'workspace',
    },
    params: {
      targetFaces: 12000,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(result.structuredContent.error.details, {
    field: 'input.meshPath',
    reason: 'required',
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /automation/capabilities'],
  );
  assertNoCapabilityExecutionPosts(calls);
});

test('registry catalog exposes strict long-running MCP schemas and recovery wording', () => {
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });

  assert.deepEqual(
    registry.catalog.filter(
      (entry) => entry.name.startsWith('modly.workflowRun.') || entry.name.startsWith('modly.processRun.'),
    ),
    [
      {
        name: 'modly.workflowRun.createFromImage',
        title: 'Create Workflow Run From Image',
        description: WORKFLOW_CREATE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          required: ['imagePath', 'modelId'],
          properties: {
            imagePath: { type: 'string' },
            modelId: { type: 'string' },
            params: { type: 'object' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'modly.workflowRun.status',
        title: 'Workflow Run Status',
        description: WORKFLOW_STATUS_DESCRIPTION,
        inputSchema: {
          type: 'object',
          required: ['runId'],
          properties: { runId: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: 'modly.workflowRun.cancel',
        title: 'Cancel Workflow Run',
        description: 'Requests workflow run cancellation.',
        inputSchema: {
          type: 'object',
          required: ['runId'],
          properties: { runId: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: 'modly.workflowRun.wait',
        title: 'Wait For Workflow Run',
        description: WORKFLOW_WAIT_DESCRIPTION,
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
        name: 'modly.processRun.create',
        title: 'Create Process Run',
        description: PROCESS_CREATE_DESCRIPTION,
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
        description: PROCESS_STATUS_DESCRIPTION,
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
        description: PROCESS_WAIT_DESCRIPTION,
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

test('open input path matcher supports exact paths and [*] array items only', () => {
  assert.equal(matchesOpenInputPath('input.params'), true);
  assert.equal(matchesOpenInputPath('input.liveContext.extensionErrors[0]'), true);
  assert.equal(matchesOpenInputPath('input.liveContext.extensionErrors[*]'), true);
  assert.equal(matchesOpenInputPath('input.error.details.foo'), false);
  assert.equal(matchesOpenInputPath('input.liveContext.extensionErrors'), false);
  assert.deepEqual(OPEN_INPUT_PATH_ALLOWLIST, [
    'input.params',
    'input.input',
    'input.error.details',
    'input.planner.target',
    'input.run.error',
    'input.runtimeEvidence.response',
    'input.runtimeEvidence.body',
    'input.runtimeEvidence.cause',
    'input.liveContext.health',
    'input.liveContext.capabilities',
    'input.liveContext.runtimePaths',
    'input.liveContext.extensionErrors[*]',
  ]);
});

test('modly.diagnostic.guidance rejects nested unknown keys under closed objects before handler execution', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'electron_ipc',
    error: {
      message: 'Extension IPC handshake failed.',
      extra: true,
    },
    planner: {
      reasons: ['x'],
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.tool, 'modly.diagnostic.guidance');
  assert.equal(result.structuredContent.error.details.path, 'input.error');
  assert.deepEqual(result.structuredContent.error.details.unknownKeys, ['extra']);
  assert.equal(result.structuredContent.meta.tool, 'modly.diagnostic.guidance');
  assert.equal(result.content[0].type, 'text');
  assert.equal(calls.length, 0);
});

test('modly.diagnostic.guidance rejects invalid recursive array items before handler execution', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'backend_api',
    error: {
      message: 'Something failed.',
      code: 'RUNTIME_ERROR',
    },
    logsExcerpt: ['ok', 2],
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.tool, 'modly.diagnostic.guidance');
  assert.equal(result.structuredContent.error.details.path, 'input.logsExcerpt[1]');
  assert.equal(result.structuredContent.error.details.expected, 'string');
  assert.equal(result.structuredContent.meta.tool, 'modly.diagnostic.guidance');
  assert.equal(result.content[0].type, 'text');
  assert.equal(calls.length, 0);
});

test('modly.diagnostic.guidance rejects enum mismatches inside supported nested objects', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'backend_api',
    error: {
      message: 'Something failed.',
      code: 'RUN_INVALID',
    },
    run: {
      kind: 'jobRun',
      id: 'run-123',
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.tool, 'modly.diagnostic.guidance');
  assert.equal(result.structuredContent.error.details.path, 'input.run.kind');
  assert.equal(result.structuredContent.error.details.reason, 'enum_no_match');
  assert.deepEqual(result.structuredContent.error.details.expected, ['workflowRun', 'processRun']);
  assert.equal(result.structuredContent.error.details.received, 'jobRun');
  assert.equal(result.structuredContent.meta.tool, 'modly.diagnostic.guidance');
  assert.equal(result.content[0].type, 'text');
  assert.equal(calls.length, 0);
});

test('modly.diagnostic.guidance returns compatible anyOf miss details with deterministic first failure', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(() => jsonResponse({ status: 'ok' }));
  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'backend_api',
    error: {
      message: 'Something failed.',
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(result.structuredContent.error.details.tool, 'modly.diagnostic.guidance');
  assert.equal(result.structuredContent.error.details.path, 'input');
  assert.equal(result.structuredContent.error.details.reason, 'anyOf_no_match');
  assert.equal(result.structuredContent.error.details.branchesTried, 7);
  assert.equal(result.structuredContent.error.details.firstFailure.details.path, 'input.error');
  assert.equal(result.structuredContent.error.details.firstFailure.details.missing, 'code');
  assert.equal(result.structuredContent.meta.tool, 'modly.diagnostic.guidance');
  assert.equal(result.content[0].type, 'text');
  assert.equal(calls.length, 0);
});

test('modly.diagnostic.guidance preserves allowlisted-open nested paths without publication changes', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(async ({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({
        backend_ready: true,
        models: [],
        processes: [],
        errors: [],
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.diagnostic.guidance', {
    surface: 'electron_ipc',
    error: {
      message: 'Extension IPC handshake failed.',
      code: 'IPC_UNAVAILABLE',
      details: {
        arbitrary: true,
        nested: {
          note: 'still open',
        },
      },
    },
    liveContext: {
      extensionErrors: [
        {
          extensionId: 'modly.github',
          arbitrary: {
            deep: ['still', 'open'],
          },
        },
      ],
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.category, 'extension_runtime');
  assert.equal(result.structuredContent.data.layer, 'electron_ipc');
  assertCapabilityPlannerCallsStayReadOnly(calls);
  assertNoCapabilityExecutionPosts(calls);
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
  assert.equal(result.structuredContent.data.run.runId, result.structuredContent.data.meta.operation.runId);
  assert.equal(result.structuredContent.data.meta.nextAction.tool, 'modly.workflowRun.status');
  assert.equal(result.structuredContent.data.meta.nextAction.input.runId, result.structuredContent.data.run.runId);
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
      meta: {
        terminal: false,
        operation: {
          kind: 'workflowRun',
          runId: 'run-123',
        },
        operationState: 'pending',
        nextAction: {
          kind: 'poll_status',
          tool: 'modly.workflowRun.status',
          input: { runId: 'run-123' },
        },
        suggestedPollIntervalMs: 1000,
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
  assert.equal(result.structuredContent.data.run.runId, result.structuredContent.data.meta.operation.runId);
  assert.equal(result.structuredContent.data.meta.nextAction.tool, 'modly.workflowRun.status');
  assert.equal(result.structuredContent.data.meta.nextAction.input.runId, result.structuredContent.data.run.runId);
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
      meta: {
        terminal: false,
        operation: {
          kind: 'workflowRun',
          runId: 'run-123',
        },
        operationState: 'in_progress',
        nextAction: {
          kind: 'poll_status',
          tool: 'modly.workflowRun.status',
          input: { runId: 'run-123' },
        },
        suggestedPollIntervalMs: 1000,
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
  assert.equal(result.structuredContent.data.run.runId, result.structuredContent.data.meta.operation.runId);
  assert.equal(result.structuredContent.data.meta.nextAction.tool, 'modly.workflowRun.status');
  assert.equal(result.structuredContent.data.meta.nextAction.input.runId, result.structuredContent.data.run.runId);
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
      meta: {
        terminal: true,
        operation: {
          kind: 'workflowRun',
          runId: 'run-123',
        },
        operationState: 'succeeded',
        nextAction: {
          kind: 'observe_terminal',
          tool: 'modly.workflowRun.status',
          input: { runId: 'run-123' },
        },
        polling: {
          intervalMs: 1,
          timeoutMs: 50,
          attempts: 2,
          elapsedMs: result.structuredContent.data.meta.polling.elapsedMs,
        },
      },
    },
  });
  assert.equal(typeof result.structuredContent.data.meta.polling.elapsedMs, 'number');
  assert.ok(result.structuredContent.data.meta.polling.elapsedMs >= 0);
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
  assert.deepEqual(result.structuredContent.data.meta.terminal, true);
  assert.deepEqual(result.structuredContent.data.meta.operation, {
    kind: 'workflowRun',
    runId: 'run-error',
  });
  assert.equal(result.structuredContent.data.meta.operationState, 'failed');
  assert.deepEqual(result.structuredContent.data.meta.nextAction, {
    kind: 'observe_terminal',
    tool: 'modly.workflowRun.status',
    input: { runId: 'run-error' },
  });
  assert.equal(result.structuredContent.data.meta.polling.intervalMs, 1000);
  assert.equal(result.structuredContent.data.meta.polling.timeoutMs, 600000);
  assert.equal(result.structuredContent.data.meta.polling.attempts, 1);
  assert.equal('suggestedPollIntervalMs' in result.structuredContent.data.meta, false);
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
  assert.deepEqual(result.structuredContent.data.meta.terminal, true);
  assert.deepEqual(result.structuredContent.data.meta.operation, {
    kind: 'workflowRun',
    runId: 'run-cancelled',
  });
  assert.equal(result.structuredContent.data.meta.operationState, 'cancelled');
  assert.deepEqual(result.structuredContent.data.meta.nextAction, {
    kind: 'observe_terminal',
    tool: 'modly.workflowRun.status',
    input: { runId: 'run-cancelled' },
  });
  assert.equal(result.structuredContent.data.meta.polling.intervalMs, 1000);
  assert.equal(result.structuredContent.data.meta.polling.timeoutMs, 600000);
  assert.equal(result.structuredContent.data.meta.polling.attempts, 1);
  assert.equal('suggestedPollIntervalMs' in result.structuredContent.data.meta, false);
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
  assert.equal(result.structuredContent.error.details.intervalMs, 1);
  assert.equal(result.structuredContent.error.details.timeoutMs, 5);
  assert.equal(typeof result.structuredContent.error.details.elapsedMs, 'number');
  assert.ok(result.structuredContent.error.details.elapsedMs >= 0);
  assert.ok(result.structuredContent.error.details.attempts >= 1);
  assert.deepEqual(result.structuredContent.error.details.lastObservedRun, {
    run_id: 'run-timeout',
    runId: 'run-timeout',
    status: 'running',
    progress: 90,
    step: undefined,
    outputUrl: undefined,
    error: undefined,
    sceneCandidate: undefined,
  });
  assert.equal(calls[0].path, '/health');
  assert.ok(calls.filter((call) => call.path === '/workflow-runs/run-timeout').length >= 1);
});

test('modly.workflowRun recovers after timeout via status using the same runId without recreating', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path, method }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-recover') {
      assert.equal(method, 'GET');
      return jsonResponse({ run_id: 'run-recover', status: 'running', progress: 90, step: 'meshing' });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const timeoutResult = await registry.invoke('modly.workflowRun.wait', {
    runId: 'run-recover',
    intervalMs: 1,
    timeoutMs: 5,
  });

  assert.equal(timeoutResult.isError, true);
  assert.equal(timeoutResult.structuredContent.error.code, 'TIMEOUT');
  assert.equal(timeoutResult.structuredContent.error.details.lastObservedRun.runId, 'run-recover');

  const statusResult = await registry.invoke('modly.workflowRun.status', { runId: 'run-recover' });

  assert.equal(statusResult.isError, undefined);
  assert.equal(statusResult.structuredContent.data.run.runId, 'run-recover');
  assert.deepEqual(statusResult.structuredContent.data.meta, {
    terminal: false,
    operation: {
      kind: 'workflowRun',
      runId: 'run-recover',
    },
    operationState: 'in_progress',
    nextAction: {
      kind: 'poll_status',
      tool: 'modly.workflowRun.status',
      input: { runId: 'run-recover' },
    },
    suggestedPollIntervalMs: 1000,
  });
  assert.equal(
    calls.some((call) => call.path === '/workflow-runs/from-image' || call.method === 'POST'),
    false,
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      ...Array.from(
        { length: calls.filter((call) => call.path === '/workflow-runs/run-recover').length - 1 },
        () => 'GET /workflow-runs/run-recover',
      ),
      'GET /health',
      'GET /workflow-runs/run-recover',
    ],
  );
});

test('modly.workflowRun.status falls back to in_progress for unknown non-terminal states', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const calls = installFetchStub(({ path }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/workflow-runs/run-unknown') {
      return jsonResponse({ run_id: 'run-unknown', status: 'stalled', progress: 42 });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });
  const result = await registry.invoke('modly.workflowRun.status', { runId: 'run-unknown' });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.run.status, 'stalled');
  assert.equal(result.structuredContent.data.meta.terminal, false);
  assert.equal(result.structuredContent.data.meta.operationState, 'in_progress');
  assert.deepEqual(result.structuredContent.data.meta.nextAction, {
    kind: 'poll_status',
    tool: 'modly.workflowRun.status',
    input: { runId: 'run-unknown' },
  });
  assert.equal(result.structuredContent.data.meta.suggestedPollIntervalMs, 1000);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /workflow-runs/run-unknown'],
  );
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
  assert.equal(result.structuredContent.data.run.runId, result.structuredContent.data.meta.operation.runId);
  assert.equal(result.structuredContent.data.meta.nextAction.tool, 'modly.processRun.status');
  assert.equal(result.structuredContent.data.meta.nextAction.input.runId, result.structuredContent.data.run.runId);
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
      meta: {
        terminal: false,
        operation: {
          kind: 'processRun',
          runId: 'process-run-123',
        },
        operationState: 'pending',
        nextAction: {
          kind: 'poll_status',
          tool: 'modly.processRun.status',
          input: { runId: 'process-run-123' },
        },
        suggestedPollIntervalMs: 1000,
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
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8766/automation/capabilities',
      'http://127.0.0.1:8766/process-runs',
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8766/automation/capabilities',
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8766/automation/capabilities',
    ],
  );
});

test('modly.processRun.create omits params.output_path when outputPath is missing or blank', { concurrency: false }, async (t) => {
  t.after(resetFetch);

  const bodies = [];
  const calls = installFetchStub(async ({ path, method, init }) => {
    if (path === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    if (path === '/automation/capabilities') {
      return jsonResponse({ processes: [{ id: 'mesh-simplify' }] });
    }

    if (path === '/process-runs') {
      assert.equal(method, 'POST');
      const body = JSON.parse(init.body);
      bodies.push(body);
      assert.equal('output_path' in body.params, false);
      return jsonResponse({
        run_id: `process-run-${bodies.length}`,
        process_id: body.process_id,
        status: 'accepted',
        params: body.params,
        workspace_path: body.workspace_path,
      });
    }

    throw new Error(`Unexpected path: ${path}`);
  });

  const registry = createToolRegistry({ apiUrl: 'http://127.0.0.1:8765' });

  const omittedResult = await registry.invoke('modly.processRun.create', {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb' },
  });

  const blankResult = await registry.invoke('modly.processRun.create', {
    process_id: 'mesh-simplify',
    params: { mesh_path: 'meshes/in.glb' },
    outputPath: '   ',
  });

  assert.equal(omittedResult.isError, undefined);
  assert.deepEqual(omittedResult.structuredContent.data.run.params, {
    mesh_path: 'meshes/in.glb',
  });
  assert.equal(blankResult.isError, undefined);
  assert.deepEqual(blankResult.structuredContent.data.run.params, {
    mesh_path: 'meshes/in.glb',
  });
  assert.deepEqual(bodies, [
    {
      process_id: 'mesh-simplify',
      params: {
        mesh_path: 'meshes/in.glb',
      },
    },
    {
      process_id: 'mesh-simplify',
      params: {
        mesh_path: 'meshes/in.glb',
      },
    },
  ]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    [
      'GET /health',
      'GET /automation/capabilities',
      'POST /process-runs',
      'GET /health',
      'GET /automation/capabilities',
      'POST /process-runs',
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
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8766/automation/capabilities',
      'http://127.0.0.1:8766/process-runs',
    ],
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
  assert.equal(statusResult.structuredContent.data.run.runId, statusResult.structuredContent.data.meta.operation.runId);
  assert.equal(statusResult.structuredContent.data.meta.nextAction.tool, 'modly.processRun.status');
  assert.equal(statusResult.structuredContent.data.meta.nextAction.input.runId, statusResult.structuredContent.data.run.runId);
  assert.equal(statusResult.structuredContent.data.run.run_id, 'run-123');
  assert.equal(statusResult.structuredContent.data.run.processId, 'mesh-simplify');
  assert.equal(statusResult.structuredContent.data.run.status, 'running');
  assert.deepEqual(statusResult.structuredContent.data.meta, {
    terminal: false,
    operation: {
      kind: 'processRun',
      runId: 'run-123',
    },
    operationState: 'in_progress',
    nextAction: {
      kind: 'poll_status',
      tool: 'modly.processRun.status',
      input: { runId: 'run-123' },
    },
    suggestedPollIntervalMs: 1000,
  });

  assert.equal(cancelResult.isError, undefined);
  assert.equal(cancelResult.structuredContent.data.run.runId, 'run-123');
  assert.equal(cancelResult.structuredContent.data.run.process_id, 'mesh-simplify');
  assert.equal(cancelResult.structuredContent.data.run.status, 'canceled');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}${call.search}`),
    ['GET /health', 'GET /process-runs/run-123', 'GET /health', 'POST /process-runs/run-123/cancel'],
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8766/process-runs/run-123',
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8766/process-runs/run-123/cancel',
    ],
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
  assert.equal(successResult.structuredContent.data.run.runId, successResult.structuredContent.data.meta.operation.runId);
  assert.equal(successResult.structuredContent.data.meta.nextAction.tool, 'modly.processRun.status');
  assert.equal(successResult.structuredContent.data.meta.nextAction.input.runId, successResult.structuredContent.data.run.runId);
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
      meta: {
        terminal: true,
        operation: {
          kind: 'processRun',
          runId: 'run-123',
        },
        operationState: 'succeeded',
        nextAction: {
          kind: 'observe_terminal',
          tool: 'modly.processRun.status',
          input: { runId: 'run-123' },
        },
        polling: {
          intervalMs: 1,
          timeoutMs: 50,
          attempts: 2,
          elapsedMs: successResult.structuredContent.data.meta.polling.elapsedMs,
        },
      },
    },
  });
  assert.equal(typeof successResult.structuredContent.data.meta.polling.elapsedMs, 'number');
  assert.ok(successResult.structuredContent.data.meta.polling.elapsedMs >= 0);

  const timeoutResult = await registry.invoke('modly.processRun.wait', {
    runId: 'run-timeout',
    intervalMs: 1,
    timeoutMs: 5,
  });

  assert.equal(timeoutResult.isError, true);
  assert.equal(timeoutResult.structuredContent.error.code, 'TIMEOUT');
  assert.equal(timeoutResult.structuredContent.error.message, 'Polling timed out before reaching a terminal state.');
  assert.equal(timeoutResult.structuredContent.error.details.intervalMs, 1);
  assert.equal(timeoutResult.structuredContent.error.details.timeoutMs, 5);
  assert.equal(typeof timeoutResult.structuredContent.error.details.elapsedMs, 'number');
  assert.ok(timeoutResult.structuredContent.error.details.elapsedMs >= 0);
  assert.ok(timeoutResult.structuredContent.error.details.attempts >= 1);
  assert.deepEqual(timeoutResult.structuredContent.error.details.lastObservedRun, {
    run_id: 'run-timeout',
    runId: 'run-timeout',
    process_id: 'mesh-simplify',
    processId: 'mesh-simplify',
    status: 'running',
    params: undefined,
    workspacePath: undefined,
    outputUrl: undefined,
    error: undefined,
  });
  assert.ok(timeoutFetches >= 1);
  assert.equal(calls[0].path, '/health');
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/health');
  assert.deepEqual(
    calls
      .filter((call) => call.path.startsWith('/process-runs/'))
      .map((call) => call.url),
    [
      'http://127.0.0.1:8766/process-runs/run-123',
      'http://127.0.0.1:8766/process-runs/run-123',
      ...Array.from({ length: timeoutFetches }, () => 'http://127.0.0.1:8766/process-runs/run-timeout'),
    ],
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
