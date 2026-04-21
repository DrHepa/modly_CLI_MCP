import { ValidationError, extractErrorEnvelope } from '../../../core/errors.mjs';
import {
  toObservedExportUrl,
  toObservedMeshPath,
  toObservedSceneCandidate,
} from '../../../core/modly-normalizers.mjs';
import { normalizeWorkspaceRelativePath } from '../../../core/process-run-input.mjs';
import {
  isProcessRunTerminal,
  isWorkflowRunTerminal,
  toOperationState,
} from './run-meta.mjs';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const RECIPE_STEP_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'partial_failed', 'cancelled']);
const RECIPE_STATUSES = new Set(['running', 'succeeded', 'failed', 'partial_failed', 'cancelled']);
const RECIPE_RUN_KINDS = new Set(['workflowRun', 'processRun']);
const DERIVED_RECIPE_STEP_ORDER = Object.freeze(['generate_mesh', 'optimize_mesh', 'export_mesh']);
const DERIVED_RECIPE_STEP_DEFINITIONS = Object.freeze({
  generate_mesh: Object.freeze({
    id: 'generate_mesh',
    title: 'Generate mesh from image',
    capability: 'image_to_mesh',
    surface: 'modly.workflowRun.createFromImage',
    runKind: 'workflowRun',
    statusTool: 'modly.workflowRun.status',
  }),
  optimize_mesh: Object.freeze({
    id: 'optimize_mesh',
    title: 'Optimize generated mesh',
    capability: 'mesh-optimizer',
    surface: 'modly.processRun.create',
    runKind: 'processRun',
    statusTool: 'modly.processRun.status',
  }),
  export_mesh: Object.freeze({
    id: 'export_mesh',
    title: 'Export generated mesh',
    capability: 'mesh-exporter',
    surface: 'modly.processRun.create',
    runKind: 'processRun',
    statusTool: 'modly.processRun.status',
  }),
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return value;
}

const RECIPE_V1_RUNTIME = deepFreeze({
  image_to_mesh: {
    id: 'image_to_mesh',
    steps: [
      {
        id: 'generate_mesh',
        title: 'Generate mesh from image',
        capability: 'image_to_mesh',
        surface: 'modly.workflowRun.createFromImage',
        runKind: 'workflowRun',
        statusTool: 'modly.workflowRun.status',
      },
    ],
    limits: {
      allowlisted: true,
      pollingFirst: true,
      branching: false,
      automaticRetries: false,
      maxNewRunsPerCall: 1,
    },
  },
  image_to_mesh_optimized: {
    id: 'image_to_mesh_optimized',
    steps: [
      {
        id: 'generate_mesh',
        title: 'Generate mesh from image',
        capability: 'image_to_mesh',
        surface: 'modly.workflowRun.createFromImage',
        runKind: 'workflowRun',
        statusTool: 'modly.workflowRun.status',
      },
      {
        id: 'optimize_mesh',
        title: 'Optimize generated mesh',
        capability: 'mesh-optimizer',
        surface: 'modly.processRun.create',
        runKind: 'processRun',
        statusTool: 'modly.processRun.status',
      },
    ],
    limits: {
      allowlisted: true,
      pollingFirst: true,
      branching: false,
      automaticRetries: false,
      maxNewRunsPerCall: 1,
    },
  },
  image_to_mesh_exported: {
    id: 'image_to_mesh_exported',
    steps: [
      {
        id: 'generate_mesh',
        title: 'Generate mesh from image',
        capability: 'image_to_mesh',
        surface: 'modly.workflowRun.createFromImage',
        runKind: 'workflowRun',
        statusTool: 'modly.workflowRun.status',
      },
      {
        id: 'export_mesh',
        title: 'Export generated mesh',
        capability: 'mesh-exporter',
        surface: 'modly.processRun.create',
        runKind: 'processRun',
        statusTool: 'modly.processRun.status',
      },
    ],
    limits: {
      allowlisted: true,
      pollingFirst: true,
      branching: false,
      automaticRetries: false,
      maxNewRunsPerCall: 1,
      exporterMode: 'default_output_only',
    },
  },
});

export const RECIPE_V1_ALLOWLIST = Object.freeze(Object.keys(RECIPE_V1_RUNTIME));

function getRunId(run) {
  return run?.run_id ?? run?.runId;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function cloneIfObject(value) {
  return isObject(value) ? { ...value } : undefined;
}

export function isDerivedRecipeSnapshot(recipe) {
  return isObject(recipe) && recipe.kind === 'derived' && normalizeNonEmptyString(recipe.id)?.startsWith('workflow/');
}

export function normalizeDerivedRecipeSnapshotSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ValidationError('Derived recipe snapshot steps must be a non-empty array.', {
      details: { field: 'recipe.steps', reason: 'invalid_derived_recipe_steps' },
    });
  }

  const normalized = steps.map((step, index) => normalizeNonEmptyString(step));

  if (normalized.some((stepId) => !stepId || !Object.hasOwn(DERIVED_RECIPE_STEP_DEFINITIONS, stepId))) {
    throw new ValidationError('Derived recipe snapshot contains unsupported step ids.', {
      details: { field: 'recipe.steps', reason: 'unsupported_derived_recipe_step', steps },
    });
  }

  const deduped = new Set(normalized);

  if (deduped.size !== normalized.length) {
    throw new ValidationError('Derived recipe snapshot must not repeat step ids.', {
      details: { field: 'recipe.steps', reason: 'duplicate_derived_recipe_step', steps: normalized },
    });
  }

  const expected = DERIVED_RECIPE_STEP_ORDER.slice(0, normalized.length);

  if (normalized.length > DERIVED_RECIPE_STEP_ORDER.length || normalized.some((stepId, index) => stepId !== expected[index])) {
    throw new ValidationError('Derived recipe snapshot steps must follow the supported linear subset.', {
      details: { field: 'recipe.steps', reason: 'invalid_derived_recipe_step_order', steps: normalized },
    });
  }

  return normalized;
}

export function resolveDerivedRecipeRuntime(recipe) {
  const recipeId = normalizeNonEmptyString(recipe.id);

  if (!recipeId) {
    throw new ValidationError('Derived recipe snapshot id must be a non-empty string.', {
      details: { field: 'recipe.id', reason: 'invalid_derived_recipe_id' },
    });
  }

  const steps = normalizeDerivedRecipeSnapshotSteps(recipe.steps);
  const limits = {
    ...(isObject(recipe.limits) ? recipe.limits : {}),
    allowlisted: false,
    pollingFirst: true,
    branching: false,
    automaticRetries: false,
    maxNewRunsPerCall: 1,
  };

  if (steps.includes('export_mesh')) {
    limits.exporterMode = 'default_output_only';
  }

  return deepFreeze({
    id: recipeId,
    kind: 'derived',
    displayName: normalizeNonEmptyString(recipe.displayName) ?? recipeId,
    modelId: normalizeNonEmptyString(recipe.modelId),
    sourceWorkflow: cloneIfObject(recipe.sourceWorkflow),
    steps: steps.map((stepId) => ({ ...DERIVED_RECIPE_STEP_DEFINITIONS[stepId] })),
    limits,
  });
}

function validateRecipeStepStatus(status, field) {
  if (!RECIPE_STEP_STATUSES.has(status)) {
    throw new ValidationError(`${field} must be one of: ${Array.from(RECIPE_STEP_STATUSES).join(', ')}.`, {
      details: { field, reason: 'invalid_recipe_step_status', value: status },
    });
  }

  return status;
}

function normalizeRecipeStepRun(run, field) {
  if (run === undefined) {
    return undefined;
  }

  if (!isObject(run)) {
    throw new ValidationError(`${field} must be an object.`, {
      details: { field, reason: 'invalid_recipe_step_run' },
    });
  }

  const kind = normalizeNonEmptyString(run.kind);

  if (!kind || !RECIPE_RUN_KINDS.has(kind)) {
    throw new ValidationError(`${field}.kind must be one of: ${Array.from(RECIPE_RUN_KINDS).join(', ')}.`, {
      details: { field: `${field}.kind`, reason: 'invalid_recipe_run_kind', value: run.kind ?? null },
    });
  }

  const runId = normalizeNonEmptyString(run.runId ?? run.run_id ?? run.id);

  if (!runId) {
    throw new ValidationError(`${field}.runId must be a non-empty string.`, {
      details: { field: `${field}.runId`, reason: 'invalid_recipe_run_id' },
    });
  }

  const normalized = { kind, runId };
  const status = normalizeNonEmptyString(run.status);

  if (status !== undefined) {
    normalized.status = status;
  }

  return normalized;
}

function normalizeRecipeStepOutputs(outputs, field) {
  if (outputs === undefined) {
    return {};
  }

  if (!isObject(outputs)) {
    throw new ValidationError(`${field} must be an object.`, {
      details: { field, reason: 'invalid_recipe_step_outputs' },
    });
  }

  const normalized = {};
  const meshPath = normalizeNonEmptyString(outputs.meshPath);
  const exportUrl = normalizeNonEmptyString(outputs.exportUrl);

  if (meshPath !== undefined) {
    normalized.meshPath = meshPath;
  }

  if (exportUrl !== undefined) {
    normalized.exportUrl = exportUrl;
  }

  if (outputs.sceneCandidate === null) {
    normalized.sceneCandidate = null;
  } else if (isObject(outputs.sceneCandidate)) {
    normalized.sceneCandidate = { ...outputs.sceneCandidate };
  }

  return normalized;
}

function normalizeRecipeStepError(error, field) {
  if (error === undefined || error === null) {
    return undefined;
  }

  if (typeof error === 'string') {
    return error.trim() === '' ? undefined : error.trim();
  }

  if (isObject(error)) {
    return { ...error };
  }

  throw new ValidationError(`${field} must be a string or object.`, {
    details: { field, reason: 'invalid_recipe_step_error' },
  });
}

function toRecipeStepError(error) {
  const envelope = extractErrorEnvelope(error);
  const normalized = {
    code: envelope.code,
    message: envelope.message,
  };

  if (isObject(envelope.details) && Object.keys(envelope.details).length > 0) {
    normalized.details = envelope.details;
  }

  return normalized;
}

function normalizeRecipeStepPoll(poll, field) {
  if (poll === undefined) {
    return undefined;
  }

  if (!isObject(poll)) {
    throw new ValidationError(`${field} must be an object.`, {
      details: { field, reason: 'invalid_recipe_step_poll' },
    });
  }

  const tool = normalizeNonEmptyString(poll.tool);

  if (!tool) {
    throw new ValidationError(`${field}.tool must be a non-empty string.`, {
      details: { field: `${field}.tool`, reason: 'invalid_recipe_step_poll_tool' },
    });
  }

  const normalized = { tool };

  if (isObject(poll.input)) {
    normalized.input = { ...poll.input };
  }

  const intervalMs = poll.intervalMs;

  if (intervalMs !== undefined) {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new ValidationError(`${field}.intervalMs must be a positive integer.`, {
        details: { field: `${field}.intervalMs`, reason: 'invalid_recipe_step_poll_interval', value: intervalMs },
      });
    }

    normalized.intervalMs = intervalMs;
  }

  return normalized;
}

export function resolveRecipeRuntime(recipe) {
  if (isDerivedRecipeSnapshot(recipe)) {
    return resolveDerivedRecipeRuntime(recipe);
  }

  const recipeId = normalizeNonEmptyString(recipe);

  if (!recipeId || !Object.hasOwn(RECIPE_V1_RUNTIME, recipeId)) {
    throw new ValidationError(`Unsupported guided recipe: ${recipe}.`, {
      details: {
        field: 'recipe',
        reason: 'unsupported_recipe',
        recipe: recipe ?? null,
        allowed: RECIPE_V1_ALLOWLIST,
      },
    });
  }

  return RECIPE_V1_RUNTIME[recipeId];
}

export function parseRecipeResume(resume) {
  if (resume === undefined) {
    return { steps: [] };
  }

  if (!isObject(resume)) {
    throw new ValidationError('options.resume must be an object.', {
      details: { field: 'options.resume', reason: 'invalid_recipe_resume_shape' },
    });
  }

  const keys = Object.keys(resume);

  if (keys.some((key) => key !== 'steps')) {
    throw new ValidationError('options.resume only supports the steps field in this MVP.', {
      details: { field: 'options.resume', reason: 'unsupported_recipe_resume_field', keys },
    });
  }

  if (resume.steps === undefined) {
    return { steps: [] };
  }

  if (!Array.isArray(resume.steps)) {
    throw new ValidationError('options.resume.steps must be an array.', {
      details: { field: 'options.resume.steps', reason: 'invalid_recipe_resume_steps' },
    });
  }

  const steps = resume.steps.map((step, index) => {
    const field = `options.resume.steps[${index}]`;

    if (!isObject(step)) {
      throw new ValidationError(`${field} must be an object.`, {
        details: { field, reason: 'invalid_recipe_resume_step' },
      });
    }

    const id = normalizeNonEmptyString(step.id);

    if (!id) {
      throw new ValidationError(`${field}.id must be a non-empty string.`, {
        details: { field: `${field}.id`, reason: 'invalid_recipe_step_id' },
      });
    }

    const status = validateRecipeStepStatus(
      normalizeNonEmptyString(step.status) ?? 'pending',
      `${field}.status`,
    );
    const normalized = { id, status };
    const run = normalizeRecipeStepRun(step.run, `${field}.run`);
    const outputs = normalizeRecipeStepOutputs(step.outputs, `${field}.outputs`);
    const error = normalizeRecipeStepError(step.error, `${field}.error`);
    const poll = normalizeRecipeStepPoll(step.poll, `${field}.poll`);

    if (run !== undefined) {
      normalized.run = run;
    }

    if (Object.keys(outputs).length > 0 || outputs.sceneCandidate === null) {
      normalized.outputs = outputs;
    }

    if (error !== undefined) {
      normalized.error = error;
    }

    if (poll !== undefined) {
      normalized.poll = poll;
    }

    return normalized;
  });

  return { steps };
}

function isDerivedWorkflowRecipeRunContext(recipeRuntime, stepDefinition) {
  return recipeRuntime?.kind === 'derived'
    && normalizeNonEmptyString(recipeRuntime.id)?.startsWith('workflow/')
    && stepDefinition?.runKind === 'workflowRun';
}

function normalizeLocalMeshPathCandidate(candidate) {
  const normalized = normalizeNonEmptyString(candidate);

  if (!normalized) {
    return undefined;
  }

  try {
    return normalizeWorkspaceRelativePath(normalized, 'steps.outputs.meshPath');
  } catch {
    return undefined;
  }
}

function normalizeLocalFileUrlMeshPathCandidate(outputUrl) {
  if (/^file:\/\/localhost(?=\/)/i.test(outputUrl)) {
    return undefined;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(outputUrl);
  } catch {
    return undefined;
  }

  if (parsedUrl.protocol !== 'file:' || parsedUrl.host !== '') {
    return undefined;
  }

  return normalizeLocalMeshPathCandidate(parsedUrl.pathname.replace(/^\/+/, ''));
}

function resolveDerivedWorkflowOutputUrlMeshPathFallback(run, { recipeRuntime, stepDefinition } = {}) {
  if (!isDerivedWorkflowRecipeRunContext(recipeRuntime, stepDefinition) || toObservedMeshPath(run) !== undefined) {
    return undefined;
  }

  const sceneCandidate = toObservedSceneCandidate(run);
  const workspaceCandidate = normalizeLocalMeshPathCandidate(
    normalizeNonEmptyString(sceneCandidate?.workspace_path) ?? normalizeNonEmptyString(sceneCandidate?.workspacePath),
  );

  if (workspaceCandidate !== undefined) {
    return workspaceCandidate;
  }

  const outputUrl = toObservedExportUrl(run);
  const normalizedOutputUrl = normalizeNonEmptyString(outputUrl);

  if (!normalizedOutputUrl) {
    return undefined;
  }

  const schemeMatch = /^[a-zA-Z][a-zA-Z\d+.-]*:/.exec(normalizedOutputUrl);

  if (!schemeMatch) {
    return normalizeLocalMeshPathCandidate(normalizedOutputUrl);
  }

  const scheme = schemeMatch[0].slice(0, -1).toLowerCase();

  if (scheme === 'file') {
    return normalizeLocalFileUrlMeshPathCandidate(normalizedOutputUrl);
  }

  return undefined;
}

function buildRecipeStepOutputsFromRun(run, context) {
  const outputs = {};
  const meshPath = toObservedMeshPath(run) ?? resolveDerivedWorkflowOutputUrlMeshPathFallback(run, context);
  const exportUrl = toObservedExportUrl(run);
  const sceneCandidate = toObservedSceneCandidate(run);

  if (meshPath !== undefined) {
    outputs.meshPath = meshPath;
  }

  if (exportUrl !== undefined) {
    outputs.exportUrl = exportUrl;
  }

  if (sceneCandidate !== undefined) {
    outputs.sceneCandidate = sceneCandidate;
  }

  return outputs;
}

function normalizeRecipeParams(value, field) {
  if (value === undefined) {
    return {};
  }

  if (!isObject(value)) {
    throw new ValidationError(`${field} must be an object.`, {
      details: { field, reason: 'invalid_recipe_params' },
    });
  }

  return { ...value };
}

export function normalizeGuidedRecipeInput(recipeRuntime, input) {
  if (!isObject(input)) {
    throw new ValidationError('input must be a JSON object.', {
      details: { field: 'input', reason: 'invalid_input_shape' },
    });
  }

  const imagePath = normalizeNonEmptyString(input.imagePath);
  const modelId = normalizeNonEmptyString(input.modelId);

  if (!imagePath) {
    throw new ValidationError('input.imagePath must be a non-empty string.', {
      details: { field: 'input.imagePath', reason: 'required' },
    });
  }

  if (!modelId) {
    throw new ValidationError('input.modelId must be a non-empty canonical model ID.', {
      details: { field: 'input.modelId', reason: 'required' },
    });
  }

  const normalized = {
    imagePath,
    modelId,
    modelParams: normalizeRecipeParams(input.modelParams, 'input.modelParams'),
  };

  const stepIds = new Set(Array.isArray(recipeRuntime?.steps) ? recipeRuntime.steps.map((step) => step.id) : []);

  if (stepIds.has('optimize_mesh')) {
    const optimize = input.optimize === undefined ? {} : normalizeRecipeParams(input.optimize, 'input.optimize');
    normalized.optimize = {
      ...(optimize.outputPath !== undefined ? { outputPath: optimize.outputPath } : {}),
      params: normalizeRecipeParams(optimize.params, 'input.optimize.params'),
    };
  }

  if (stepIds.has('export_mesh')) {
    const exportInput = input.export === undefined ? {} : normalizeRecipeParams(input.export, 'input.export');
    const exportParams = normalizeRecipeParams(exportInput.params, 'input.export.params');

    if (Object.hasOwn(exportInput, 'outputPath')) {
      throw new ValidationError(`input.export.outputPath is unsupported for ${recipeRuntime.id} in this MVP.`, {
        details: {
          field: 'input.export.outputPath',
          reason: 'unsupported_output_path_mvp',
          recipe: recipeRuntime.id,
        },
      });
    }

    if (Object.hasOwn(exportParams, 'output_path') || Object.hasOwn(exportParams, 'outputPath')) {
      throw new ValidationError(`input.export.params.output_path is unsupported for ${recipeRuntime.id} in this MVP.`, {
        details: {
          field: Object.hasOwn(exportParams, 'output_path') ? 'input.export.params.output_path' : 'input.export.params.outputPath',
          reason: 'unsupported_output_path_mvp',
          recipe: recipeRuntime.id,
        },
      });
    }

    normalized.export = {
      ...(normalizeNonEmptyString(exportInput.outputFormat) ? { outputFormat: normalizeNonEmptyString(exportInput.outputFormat) } : {}),
    };
  }

  return normalized;
}

function normalizeRecipeModelParamValue(value) {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return normalizeNonEmptyString(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeRecipeModelParamValue(entry))
      .filter((entry) => entry !== undefined);
  }

  if (!isObject(value)) {
    return undefined;
  }

  const normalized = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeNonEmptyString(rawKey);
    const safeValue = normalizeRecipeModelParamValue(rawValue);

    if (!key || safeValue === undefined) {
      continue;
    }

    normalized[key] = safeValue;
  }

  return normalized;
}

export function normalizeRecipeModelParams(params) {
  return normalizeRecipeModelParamValue(normalizeRecipeParams(params, 'input.modelParams')) ?? {};
}

function toRecipeStepStatusFromRun(stepDefinition, run) {
  const terminal = stepDefinition.runKind === 'workflowRun' ? isWorkflowRunTerminal(run) : isProcessRunTerminal(run);
  const operationState = toOperationState(stepDefinition.runKind, run, terminal);

  if (!terminal) {
    return 'running';
  }

  if (operationState === 'succeeded') {
    return 'succeeded';
  }

  if (operationState === 'cancelled') {
    return 'cancelled';
  }

  return 'failed';
}

function buildRecipeStepPoll(stepDefinition, runId) {
  return {
    tool: stepDefinition.statusTool,
    input: { runId },
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

export function updateRecipeStepFromRun(step, stepDefinition, run, recipeRuntime) {
  const runId = getRunId(run) ?? step.run?.runId;
  const outputs = {
    ...(step.outputs ?? {}),
    ...buildRecipeStepOutputsFromRun(run, { recipeRuntime, stepDefinition }),
  };
  const nextStep = {
    ...step,
    status: toRecipeStepStatusFromRun(stepDefinition, run),
    run: {
      kind: stepDefinition.runKind,
      runId,
      ...(normalizeNonEmptyString(run?.status) ? { status: normalizeNonEmptyString(run.status) } : {}),
    },
  };

  if (stepDefinition.runKind === 'processRun' && nextStep.status !== 'succeeded') {
    delete outputs.meshPath;
    delete outputs.exportUrl;
  }

  if (Object.keys(outputs).length > 0 || outputs.sceneCandidate === null) {
    nextStep.outputs = outputs;
  }

  if (nextStep.status === 'running') {
    nextStep.poll = buildRecipeStepPoll(stepDefinition, runId);
  } else {
    delete nextStep.poll;
  }

  if (run?.error !== undefined) {
    nextStep.error = normalizeRecipeStepError(run.error, `steps.${step.id}.error`);
  }

  return nextStep;
}

function failRecipeStep(step, error, { status = 'failed' } = {}) {
  return {
    ...step,
    status,
    ...(step.run ? { run: { ...step.run } } : {}),
    ...(step.outputs ? { outputs: { ...step.outputs } } : {}),
    error: toRecipeStepError(error),
  };
}

export function markRecipeStepBoundaryFailure(steps, failedStepIndex, error) {
  const reason = error?.details?.reason ?? error?.details?.error?.reason ?? null;
  const targetIndex = reason === 'missing_required_output' && failedStepIndex > 0
    ? failedStepIndex - 1
    : failedStepIndex;

  steps[targetIndex] = failRecipeStep(steps[targetIndex], error);

  if (targetIndex !== failedStepIndex) {
    steps[failedStepIndex] = failRecipeStep(steps[failedStepIndex], error);
  }
}

export function markRecipeStepRunning(step, stepDefinition, run, recipeRuntime) {
  const runId = getRunId(run);
  const outputs = {
    ...(step.outputs ?? {}),
    ...buildRecipeStepOutputsFromRun(run, { recipeRuntime, stepDefinition }),
  };

  if (stepDefinition.runKind === 'processRun') {
    delete outputs.meshPath;
    delete outputs.exportUrl;
  }

  return {
    ...step,
    status: 'running',
    run: {
      kind: stepDefinition.runKind,
      runId,
      ...(normalizeNonEmptyString(run?.status) ? { status: normalizeNonEmptyString(run.status) } : {}),
    },
    ...(Object.keys(outputs).length > 0 || outputs.sceneCandidate === null ? { outputs } : {}),
    poll: buildRecipeStepPoll(stepDefinition, runId),
  };
}

export function getRecipeStepDefinition(recipeRuntime, stepId) {
  const definition = recipeRuntime.steps.find((step) => step.id === stepId);

  if (!definition) {
    throw new ValidationError(`Unknown recipe step: ${stepId}.`, {
      details: { field: 'step.id', reason: 'unknown_recipe_step', stepId, recipe: recipeRuntime.id },
    });
  }

  return definition;
}

export function deriveRecipeStatusFromSteps(steps) {
  const resolvedSteps = Array.isArray(steps) ? steps : [];

  if (resolvedSteps.some((step) => step.status === 'running')) {
    return 'running';
  }

  const succeededCount = resolvedSteps.filter((step) => step.status === 'succeeded').length;

  if (resolvedSteps.some((step) => step.status === 'partial_failed')) {
    return 'partial_failed';
  }

  if (resolvedSteps.some((step) => step.status === 'failed')) {
    return succeededCount > 0 ? 'partial_failed' : 'failed';
  }

  if (resolvedSteps.some((step) => step.status === 'cancelled')) {
    return succeededCount > 0 ? 'partial_failed' : 'cancelled';
  }

  return 'succeeded';
}

function summarizeRecipeExecution(recipe, status) {
  return `Guided recipe ${recipe}: ${status}.`;
}

function createRecipeBackendNotReadyError({ health, capabilities, recipe }) {
  const healthStatus = normalizeNonEmptyString(health?.status ?? health?.state) ?? 'unknown';

  return new ValidationError(`Modly backend is not ready for guided recipe ${recipe}.`, {
    code: 'BACKEND_NOT_READY',
    details: {
      field: 'recipe',
      reason: 'backend_not_ready',
      recipe,
      health_status: healthStatus,
      backend_ready: capabilities?.backend_ready ?? null,
    },
  });
}

export function assertRecipeBackendReady({ health, capabilities, recipe }) {
  const healthStatus = normalizeNonEmptyString(health?.status ?? health?.state)?.toLowerCase() ?? 'unknown';

  if (healthStatus === 'ok' && capabilities?.backend_ready === true) {
    return;
  }

  throw createRecipeBackendNotReadyError({ health, capabilities, recipe });
}

export function buildRecipeResult({ recipe, recipeRuntime, input, steps }) {
  const status = deriveRecipeStatusFromSteps(steps);
  return {
    data: buildRecipeEnvelope({ recipe, recipeRuntime, input, status, steps }),
    text: summarizeRecipeExecution(recipe, status),
  };
}

export function assertSupportedRecipePlan(plan, { recipe, stepId, expectedSurface, expectedTargetKind }) {
  if (plan.status !== 'supported' || plan.surface !== expectedSurface || plan.target?.kind !== expectedTargetKind) {
    throw new ValidationError(`Recipe step ${stepId} is unavailable for ${recipe}.`, {
      details: {
        field: 'recipe',
        reason: 'recipe_step_unavailable',
        recipe,
        stepId,
        planStatus: plan.status,
        planSurface: plan.surface ?? null,
        planTargetKind: plan.target?.kind ?? null,
      },
    });
  }
}

export function getRequiredRecipeMeshPath(steps, recipe, stepId) {
  const meshPath = normalizeNonEmptyString(buildRecipeOutputs(steps).meshPath);

  if (!meshPath) {
    throw new ValidationError(`Recipe step ${stepId} requires an observed meshPath from a previous step.`, {
      details: {
        field: 'steps.outputs.meshPath',
        reason: 'missing_required_output',
        recipe,
        stepId,
        required: 'meshPath',
      },
    });
  }

  return meshPath;
}

export function buildRecipeSteps(recipeRuntime, resume = { steps: [] }) {
  const runtime = recipeRuntime?.id ? recipeRuntime : resolveRecipeRuntime(recipeRuntime);
  const normalizedResume = parseRecipeResume(resume);
  const resumeById = new Map();

  for (const step of normalizedResume.steps) {
    if (resumeById.has(step.id)) {
      throw new ValidationError(`Duplicate resume step id: ${step.id}.`, {
        details: { field: 'options.resume.steps', reason: 'duplicate_recipe_step_id', id: step.id },
      });
    }

    resumeById.set(step.id, step);
  }

  const allowedStepIds = new Set(runtime.steps.map((step) => step.id));

  for (const stepId of resumeById.keys()) {
    if (!allowedStepIds.has(stepId)) {
      throw new ValidationError(`options.resume.steps contains unknown step id: ${stepId}.`, {
        details: { field: 'options.resume.steps', reason: 'unknown_recipe_step_id', id: stepId, recipe: runtime.id },
      });
    }
  }

  return runtime.steps.map((stepDefinition) => {
    const resumeStep = resumeById.get(stepDefinition.id);
    const outputs = {
      ...(resumeStep?.outputs ?? {}),
      ...(resumeStep?.run ? buildRecipeStepOutputsFromRun(resumeStep.run, { recipeRuntime: runtime, stepDefinition }) : {}),
    };
    const step = {
      id: stepDefinition.id,
      title: stepDefinition.title,
      capability: stepDefinition.capability,
      surface: stepDefinition.surface,
      status: resumeStep?.status ?? 'pending',
    };

    if (resumeStep?.run) {
      step.run = { ...resumeStep.run };
    }

    if (Object.keys(outputs).length > 0 || outputs.sceneCandidate === null) {
      step.outputs = outputs;
    }

    if (resumeStep?.error !== undefined) {
      step.error = typeof resumeStep.error === 'string' ? resumeStep.error : { ...resumeStep.error };
    }

    if (resumeStep?.poll !== undefined) {
      step.poll = { ...resumeStep.poll };
    } else if (step.run?.runId) {
      step.poll = {
        tool: stepDefinition.statusTool,
        input: { runId: step.run.runId },
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
      };
    }

    return step;
  });
}

export function buildRecipeOutputs(steps) {
  const outputs = {};

  for (const step of Array.isArray(steps) ? steps : []) {
    if (!isObject(step?.outputs)) {
      continue;
    }

    if (step.outputs.meshPath !== undefined) {
      outputs.meshPath = step.outputs.meshPath;
    }

    if (step.outputs.exportUrl !== undefined) {
      outputs.exportUrl = step.outputs.exportUrl;
    }

    if (step.outputs.sceneCandidate !== undefined) {
      outputs.sceneCandidate = cloneIfObject(step.outputs.sceneCandidate) ?? step.outputs.sceneCandidate;
    }
  }

  return outputs;
}

export function buildRecipeLimits(recipeRuntime) {
  const runtime = recipeRuntime?.id ? recipeRuntime : resolveRecipeRuntime(recipeRuntime);
  return { ...runtime.limits };
}

export function buildRecipeNextAction({ recipe, input, steps, status }) {
  if (!RECIPE_STATUSES.has(status)) {
    throw new ValidationError(`Invalid recipe status: ${status}.`, {
      details: { field: 'status', reason: 'invalid_recipe_status', value: status },
    });
  }

  if (status !== 'running') {
    return { kind: 'none' };
  }

  return {
    kind: 'poll',
    tool: 'modly.recipe.execute',
    input: {
      recipe,
      input,
      options: {
        resume: {
          steps: Array.isArray(steps)
            ? steps.map((step) => ({
              id: step.id,
              status: step.status,
              ...(step.run ? { run: { ...step.run } } : {}),
              ...(step.outputs ? { outputs: { ...step.outputs } } : {}),
              ...(step.error !== undefined ? { error: typeof step.error === 'string' ? step.error : { ...step.error } } : {}),
              ...(step.poll ? { poll: { ...step.poll } } : {}),
            }))
            : [],
        },
      },
    },
  };
}

function buildRecipeRunIds(steps) {
  const runIds = {};

  for (const step of Array.isArray(steps) ? steps : []) {
    if (step?.run?.runId) {
      runIds[step.id] = step.run.runId;
    }
  }

  return runIds;
}

export function buildRecipeEnvelope({ recipe, recipeRuntime, input, status, steps }) {
  const resolvedSteps = Array.isArray(steps) ? steps : [];

  return {
    recipe,
    status,
    steps: resolvedSteps,
    runIds: buildRecipeRunIds(resolvedSteps),
    outputs: buildRecipeOutputs(resolvedSteps),
    limits: buildRecipeLimits(recipeRuntime ?? recipe),
    nextAction: buildRecipeNextAction({ recipe, input, steps: resolvedSteps, status }),
  };
}
