export const DEFAULT_API_URL = 'http://127.0.0.1:8765';

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  BACKEND_UNAVAILABLE: 3,
  NOT_FOUND: 4,
  UNSUPPORTED: 5,
  TIMEOUT: 6,
  VALIDATION: 7,
});

export const COMMAND_GROUPS = Object.freeze([
  'capabilities',
  'health',
  'model',
  'generate',
  'job',
  'process-run',
  'workflow-run',
  'mesh',
  'ext',
  'ext-dev',
  'config',
]);

export const PRIVATE_EXTENSION_CLI_SEAMS = Object.freeze(['setup']);

export const EXECUTION_SURFACE_TAXONOMY = Object.freeze({
  canonical: Object.freeze({
    label: 'canonical run primitive',
    cliGroups: Object.freeze(['process-run', 'workflow-run']),
    mcpToolIds: Object.freeze([
      'modly.workflowRun.createFromImage',
      'modly.workflowRun.status',
      'modly.workflowRun.cancel',
      'modly.workflowRun.wait',
      'modly.processRun.create',
      'modly.processRun.status',
      'modly.processRun.wait',
      'modly.processRun.cancel',
    ]),
  }),
  wrapper: Object.freeze({
    label: 'orchestration wrapper',
    cliGroups: Object.freeze([]),
    mcpToolIds: Object.freeze(['modly.capability.execute', 'modly.recipe.execute']),
  }),
  legacy: Object.freeze({
    label: 'legacy compatibility',
    cliGroups: Object.freeze(['generate', 'job']),
    mcpToolIds: Object.freeze(['modly.job.status']),
  }),
});

export const MODLY_API_CONTRACT = Object.freeze({
  health: { method: 'GET', path: '/health' },
  getAutomationCapabilities: { method: 'GET', path: '/automation/capabilities' },
  listModels: { method: 'GET', path: '/model/all' },
  getCurrentModel: { method: 'GET', path: '/model/status' },
  getModelParams: { method: 'GET', path: '/model/params' },
  switchModel: { method: 'POST', path: '/model/switch' },
  unloadAllModels: { method: 'POST', path: '/model/unload-all' },
  downloadModel: { method: 'GET', path: '/model/hf-download' },
  generateFromImage: { method: 'POST', path: '/generate/from-image' },
  getJobStatus: { method: 'GET', path: '/generate/status/:jobId' },
  cancelJob: { method: 'POST', path: '/generate/cancel/:jobId' },
  createWorkflowRunFromImage: { method: 'POST', path: '/workflow-runs/from-image' },
  getWorkflowRun: { method: 'GET', path: '/workflow-runs/:runId' },
  cancelWorkflowRun: { method: 'POST', path: '/workflow-runs/:runId/cancel' },
  createProcessRun: { method: 'POST', path: '/process-runs' },
  getProcessRun: { method: 'GET', path: '/process-runs/:runId' },
  cancelProcessRun: { method: 'POST', path: '/process-runs/:runId/cancel' },
  optimizeMesh: { method: 'POST', path: '/optimize/mesh' },
  smoothMesh: { method: 'POST', path: '/optimize/smooth' },
  exportMesh: { method: 'GET', path: '/export/:format' },
  reloadExtensions: { method: 'POST', path: '/extensions/reload' },
  getExtensionErrors: { method: 'GET', path: '/extensions/errors' },
  getRuntimePaths: { method: 'GET', path: '/settings/paths' },
  setRuntimePaths: { method: 'POST', path: '/settings/paths' },
});

const DEFAULT_PUBLIC_MCP_TOOL_IDS = Object.freeze([
  'modly.capabilities.get',
  'modly.capability.plan',
  'modly.capability.guide',
  'modly.diagnostic.guidance',
  'modly.capability.execute',
  'modly.health',
  'modly.model.list',
  'modly.model.current',
  'modly.model.params',
  'modly.ext.errors',
  'modly.config.paths.get',
  'modly.job.status',
  'modly.workflowRun.createFromImage',
  'modly.workflowRun.status',
  'modly.workflowRun.cancel',
  'modly.workflowRun.wait',
  'modly.processRun.create',
  'modly.processRun.status',
  'modly.processRun.wait',
  'modly.processRun.cancel',
]);

const LEGACY_MCP_TOOL_INDEX = Object.freeze({
  0: 'modly.capabilities.get',
  1: 'modly.capability.plan',
  2: 'modly.capability.guide',
  3: 'modly.health',
  4: 'modly.model.list',
  5: 'modly.model.current',
  6: 'modly.model.params',
  11: 'modly.job.status',
  14: 'modly.workflowRun.createFromImage',
  15: 'modly.workflowRun.status',
  16: 'modly.workflowRun.cancel',
  17: 'modly.processRun.create',
  18: 'modly.processRun.status',
  19: 'modly.processRun.wait',
  20: 'modly.processRun.cancel',
  25: 'modly.ext.errors',
  26: 'modly.config.paths.get',
  28: 'modly.workflowRun.wait',
  29: 'modly.capability.execute',
  30: 'modly.diagnostic.guidance',
  31: 'modly.recipe.execute',
});

export const MCP_TOOL_IDS = Object.freeze({
  ...LEGACY_MCP_TOOL_INDEX,
  length: DEFAULT_PUBLIC_MCP_TOOL_IDS.length,
  [Symbol.iterator]: function* iterateDefaultPublicMcpToolIds() {
    yield* DEFAULT_PUBLIC_MCP_TOOL_IDS;
  },
  filter(callback, thisArg) {
    return DEFAULT_PUBLIC_MCP_TOOL_IDS.filter(callback, thisArg);
  },
  includes(value) {
    return DEFAULT_PUBLIC_MCP_TOOL_IDS.includes(value);
  },
  map(callback, thisArg) {
    return DEFAULT_PUBLIC_MCP_TOOL_IDS.map(callback, thisArg);
  },
  toJSON() {
    return [...DEFAULT_PUBLIC_MCP_TOOL_IDS];
  },
});
