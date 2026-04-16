import { MCP_TOOL_IDS } from '../../core/contracts.mjs';

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

export const MCP_TOOL_CATALOG = [
  {
    name: MCP_TOOL_IDS[0],
    title: 'Get Automation Capabilities',
    description: 'Returns canonical automation capabilities from GET /automation/capabilities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[1],
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
  },
  {
    name: MCP_TOOL_IDS[2],
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
  },
  {
    name: MCP_TOOL_IDS[30],
    title: 'Diagnostic Guidance',
    description: 'Read-only post-mortem guidance from observed structured failure evidence; it may consult read-only readiness snapshots, but does not execute fixes or hidden writes.',
    inputSchema: DIAGNOSTIC_GUIDANCE_INPUT_SCHEMA,
  },
  {
    name: MCP_TOOL_IDS[29],
    title: 'Execute Smart Capability',
    description: 'Plans a known capability against live discovery and, in this first executable MVP cut, dispatches supported image input to modly.workflowRun.createFromImage plus ONLY mesh-optimizer/optimize and mesh-exporter/export (default_backend output only; explicit outputPath unsupported) to modly.processRun.create.',
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
  },
  {
    name: MCP_TOOL_IDS[31],
    title: 'Execute Guided Recipe',
    description: 'Executes one allowlisted guided recipe over existing capability, workflow-run, and process-run surfaces; polling-first via options.resume, with no free-form goals, branching, retries, or hidden waits.',
    inputSchema: {
      type: 'object',
      required: ['recipe', 'input'],
      properties: {
        recipe: {
          type: 'string',
          enum: ['image_to_mesh', 'image_to_mesh_optimized', 'image_to_mesh_exported'],
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
  },
  {
    name: MCP_TOOL_IDS[3],
    title: 'Modly Health',
    description: 'Checks whether the Modly FastAPI backend is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[4],
    title: 'List Models',
    description: 'Lists models from GET /model/all.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[5],
    title: 'Current Model',
    description: 'Returns the active model from GET /model/status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[6],
    title: 'Model Params',
    description: 'Returns parameter schema for a model ID.',
    inputSchema: {
      type: 'object',
      required: ['modelId'],
      properties: { modelId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_IDS[25],
    title: 'Extension Errors',
    description: 'Returns backend-captured extension loading errors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[26],
    title: 'Get Runtime Paths',
    description: 'Reads current backend runtime paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[11],
    title: 'Job Status',
    description: 'Gets the current job state.',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: { jobId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_IDS[14],
    title: 'Create Workflow Run From Image',
    description: 'Creates a workflow run from an input image and returns recovery metadata so clients can continue polling the same runId via modly.workflowRun.status.',
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
    name: MCP_TOOL_IDS[15],
    title: 'Workflow Run Status',
    description: 'Gets the latest workflow run state. This is the preferred polling-first recovery tool for long-running agents using the same runId.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_IDS[16],
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
    name: MCP_TOOL_IDS[28],
    title: 'Wait For Workflow Run',
    description: 'Bounded convenience wrapper around workflow status polling; prefer modly.workflowRun.status for recovery and use short timeout windows when you cannot poll yourself.',
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
    name: MCP_TOOL_IDS[17],
    title: 'Create Process Run',
    description: 'Creates a process run and returns recovery metadata so clients can continue polling the same runId via modly.processRun.status. outputPath is optional sugar for params.output_path.',
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
    name: MCP_TOOL_IDS[18],
    title: 'Process Run Status',
    description: 'Gets the latest process run state. This is the preferred polling-first recovery tool for long-running agents using the same runId.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_IDS[19],
    title: 'Wait For Process Run',
    description: 'Bounded convenience wrapper around process status polling; prefer modly.processRun.status for recovery and use short timeout windows when you cannot poll yourself.',
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
    name: MCP_TOOL_IDS[20],
    title: 'Cancel Process Run',
    description: 'Requests process run cancellation.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
];
