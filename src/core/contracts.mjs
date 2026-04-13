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
  'health',
  'model',
  'generate',
  'job',
  'mesh',
  'ext',
  'config',
]);

export const MODLY_API_CONTRACT = Object.freeze({
  health: { method: 'GET', path: '/health' },
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
  optimizeMesh: { method: 'POST', path: '/optimize/mesh' },
  smoothMesh: { method: 'POST', path: '/optimize/smooth' },
  exportMesh: { method: 'GET', path: '/export/:format' },
  reloadExtensions: { method: 'POST', path: '/extensions/reload' },
  getExtensionErrors: { method: 'GET', path: '/extensions/errors' },
  getRuntimePaths: { method: 'GET', path: '/settings/paths' },
  setRuntimePaths: { method: 'POST', path: '/settings/paths' },
});

export const MCP_TOOL_IDS = Object.freeze([
  'modly.health',
  'modly.model.list',
  'modly.model.current',
  'modly.model.params',
  'modly.model.switch',
  'modly.model.unloadAll',
  'modly.model.download',
  'modly.generate.fromImage',
  'modly.job.status',
  'modly.job.wait',
  'modly.job.cancel',
  'modly.workflowRun.createFromImage',
  'modly.workflowRun.status',
  'modly.workflowRun.cancel',
  'modly.mesh.optimize',
  'modly.mesh.smooth',
  'modly.mesh.export',
  'modly.ext.reload',
  'modly.ext.errors',
  'modly.config.paths.get',
  'modly.config.paths.set',
]);
