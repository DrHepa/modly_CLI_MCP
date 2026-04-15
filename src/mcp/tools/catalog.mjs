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
    title: 'Modly Health',
    description: 'Checks whether the Modly FastAPI backend is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[2],
    title: 'List Models',
    description: 'Lists models from GET /model/all.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[3],
    title: 'Current Model',
    description: 'Returns the active model from GET /model/status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[4],
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
    name: MCP_TOOL_IDS[23],
    title: 'Extension Errors',
    description: 'Returns backend-captured extension loading errors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[24],
    title: 'Get Runtime Paths',
    description: 'Reads current backend runtime paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[9],
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
    name: MCP_TOOL_IDS[12],
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
    name: MCP_TOOL_IDS[13],
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
    name: MCP_TOOL_IDS[14],
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
    name: MCP_TOOL_IDS[26],
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
    name: MCP_TOOL_IDS[15],
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
    name: MCP_TOOL_IDS[16],
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
    name: MCP_TOOL_IDS[17],
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
    name: MCP_TOOL_IDS[18],
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
