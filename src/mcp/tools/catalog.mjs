import { MCP_TOOL_IDS } from '../../core/contracts.mjs';

export const MCP_TOOL_CATALOG = [
  {
    name: MCP_TOOL_IDS[0],
    title: 'Modly Health',
    description: 'Checks whether the Modly FastAPI backend is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[1],
    title: 'List Models',
    description: 'Lists models from GET /model/all.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[2],
    title: 'Current Model',
    description: 'Returns the active model from GET /model/status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[3],
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
    name: MCP_TOOL_IDS[18],
    title: 'Extension Errors',
    description: 'Returns backend-captured extension loading errors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[19],
    title: 'Get Runtime Paths',
    description: 'Reads current backend runtime paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: MCP_TOOL_IDS[8],
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
    name: MCP_TOOL_IDS[11],
    title: 'Create Workflow Run From Image',
    description: 'Creates a workflow run from an input image.',
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
    name: MCP_TOOL_IDS[12],
    title: 'Workflow Run Status',
    description: 'Gets the latest workflow run state.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_IDS[13],
    title: 'Cancel Workflow Run',
    description: 'Requests workflow run cancellation.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
];
