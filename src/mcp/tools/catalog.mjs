import { MCP_TOOL_IDS } from '../../core/contracts.mjs';

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
    name: MCP_TOOL_IDS[28],
    title: 'Execute Smart Capability',
    description: 'Plans a known capability against live discovery and, in this first executable MVP cut, dispatches only supported image input to modly.workflowRun.createFromImage while process targets remain known but unavailable.',
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
    name: MCP_TOOL_IDS[2],
    title: 'Modly Health',
    description: 'Checks whether the Modly FastAPI backend is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[3],
    title: 'List Models',
    description: 'Lists models from GET /model/all.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[4],
    title: 'Current Model',
    description: 'Returns the active model from GET /model/status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[5],
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
    name: MCP_TOOL_IDS[24],
    title: 'Extension Errors',
    description: 'Returns backend-captured extension loading errors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[25],
    title: 'Get Runtime Paths',
    description: 'Reads current backend runtime paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[10],
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
    name: MCP_TOOL_IDS[13],
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
    name: MCP_TOOL_IDS[14],
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
    name: MCP_TOOL_IDS[15],
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
    name: MCP_TOOL_IDS[27],
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
    name: MCP_TOOL_IDS[16],
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
    name: MCP_TOOL_IDS[17],
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
    name: MCP_TOOL_IDS[18],
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
    name: MCP_TOOL_IDS[19],
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
