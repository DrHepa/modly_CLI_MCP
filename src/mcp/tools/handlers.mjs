import { createModlyApiClient } from '../../core/modly-api.mjs';
import { ValidationError, extractErrorEnvelope } from '../../core/errors.mjs';
import { analyzeDiagnosticGuidance } from '../../core/diagnostic-guidance.mjs';
import {
  normalizeErrors,
  normalizePaths,
  toObservedExportUrl,
  toObservedMeshPath,
  toObservedSceneCandidate,
  toAutomationCapabilities,
  toCurrentModel,
  toJob,
  toModelList,
  toProcessRun,
  toWorkflowRun,
} from '../../core/modly-normalizers.mjs';
import {
  prepareCapabilityProcessInput,
  prepareProcessRunCreateInput,
} from '../../core/process-run-input.mjs';
import { evaluateCapabilityGuidance, planSmartCapability } from '../../core/smart-capability-planner.mjs';
import { waitForProcessRun } from '../../core/process-run-wait.mjs';
import { waitForWorkflowRun } from '../../core/workflow-run-wait.mjs';

const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(['done', 'error', 'cancelled']);
const TERMINAL_PROCESS_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const WORKFLOW_RUN_OPERATION_STATES = {
  queued: 'pending',
  running: 'in_progress',
  done: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
};
const PROCESS_RUN_OPERATION_STATES = {
  accepted: 'pending',
  running: 'in_progress',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'cancelled',
};
const DEFAULT_POLL_INTERVAL_MS = 1000;
const OPTIMIZER_PROCESS_ID = 'mesh-optimizer/optimize';
const EXPORTER_PROCESS_ID = 'mesh-exporter/export';
const RECIPE_STEP_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'partial_failed', 'cancelled']);
const RECIPE_STATUSES = new Set(['running', 'succeeded', 'failed', 'partial_failed', 'cancelled']);
const RECIPE_RUN_KINDS = new Set(['workflowRun', 'processRun']);

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

function getModelId(model) {
  return model?.id ?? model?.model_id ?? model?.modelId ?? 'unknown';
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
  if (error === undefined) {
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

function buildRecipeStepOutputsFromRun(run) {
  const outputs = {};
  const meshPath = toObservedMeshPath(run);
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

function normalizeGuidedRecipeInput(recipeRuntime, input) {
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

  if (recipeRuntime.id === 'image_to_mesh_optimized') {
    const optimize = input.optimize === undefined ? {} : normalizeRecipeParams(input.optimize, 'input.optimize');
    normalized.optimize = {
      ...(optimize.outputPath !== undefined ? { outputPath: optimize.outputPath } : {}),
      params: normalizeRecipeParams(optimize.params, 'input.optimize.params'),
    };
  }

  if (recipeRuntime.id === 'image_to_mesh_exported') {
    const exportInput = input.export === undefined ? {} : normalizeRecipeParams(input.export, 'input.export');
    const exportParams = normalizeRecipeParams(exportInput.params, 'input.export.params');

    if (Object.hasOwn(exportInput, 'outputPath')) {
      throw new ValidationError('input.export.outputPath is unsupported for image_to_mesh_exported in this MVP.', {
        details: {
          field: 'input.export.outputPath',
          reason: 'unsupported_output_path_mvp',
          recipe: recipeRuntime.id,
        },
      });
    }

    if (Object.hasOwn(exportParams, 'output_path') || Object.hasOwn(exportParams, 'outputPath')) {
      throw new ValidationError('input.export.params.output_path is unsupported for image_to_mesh_exported in this MVP.', {
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

function normalizeRecipeModelParams(params) {
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

function updateRecipeStepFromRun(step, stepDefinition, run) {
  const runId = getRunId(run) ?? step.run?.runId;
  const outputs = {
    ...(step.outputs ?? {}),
    ...buildRecipeStepOutputsFromRun(run),
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

function markRecipeStepBoundaryFailure(steps, failedStepIndex, error) {
  const reason = error?.details?.reason ?? error?.details?.error?.reason ?? null;
  const targetIndex = reason === 'missing_required_output' && failedStepIndex > 0
    ? failedStepIndex - 1
    : failedStepIndex;

  steps[targetIndex] = failRecipeStep(steps[targetIndex], error);

  if (targetIndex !== failedStepIndex) {
    steps[failedStepIndex] = failRecipeStep(steps[failedStepIndex], error);
  }
}

function markRecipeStepRunning(step, stepDefinition, run) {
  const runId = getRunId(run);
  const outputs = {
    ...(step.outputs ?? {}),
    ...buildRecipeStepOutputsFromRun(run),
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

function getRecipeStepDefinition(recipeRuntime, stepId) {
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

function assertRecipeBackendReady({ health, capabilities, recipe }) {
  const healthStatus = normalizeNonEmptyString(health?.status ?? health?.state)?.toLowerCase() ?? 'unknown';

  if (healthStatus === 'ok' && capabilities?.backend_ready === true) {
    return;
  }

  throw createRecipeBackendNotReadyError({ health, capabilities, recipe });
}

function buildRecipeResult({ recipe, input, steps }) {
  const status = deriveRecipeStatusFromSteps(steps);
  return {
    data: buildRecipeEnvelope({ recipe, input, status, steps }),
    text: summarizeRecipeExecution(recipe, status),
  };
}

function assertSupportedRecipePlan(plan, { recipe, stepId, expectedSurface, expectedTargetKind }) {
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

function getRequiredRecipeMeshPath(steps, recipe, stepId) {
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

async function launchRecipeStep(modlyClient, { recipeRuntime, recipeInput, step, steps, capabilities }) {
  const stepDefinition = getRecipeStepDefinition(recipeRuntime, step.id);

  if (stepDefinition.id === 'generate_mesh') {
    const { run } = await dispatchWorkflowRunFromImage(modlyClient, {
      imagePath: recipeInput.imagePath,
      modelId: recipeInput.modelId,
      params: normalizeRecipeModelParams(recipeInput.modelParams),
    });

    return markRecipeStepRunning(step, stepDefinition, run);
  }

  if (stepDefinition.id === 'optimize_mesh') {
    const meshPath = getRequiredRecipeMeshPath(steps, recipeRuntime.id, step.id);
    const plan = planSmartCapability({
      capability: 'mesh optimizer',
      params: recipeInput.optimize?.params,
    }, capabilities);

    assertSupportedRecipePlan(plan, {
      recipe: recipeRuntime.id,
      stepId: step.id,
      expectedSurface: 'processRun.create',
      expectedTargetKind: 'process',
    });

    const resolvedExecution = resolveProcessCapabilityExecutionInput({
      kind: 'mesh',
      meshPath,
      ...(recipeInput.optimize?.outputPath !== undefined ? { outputPath: recipeInput.optimize.outputPath } : {}),
    }, plan);
    const payload = prepareProcessRunCreateInput(resolvedExecution.payload, { capabilities });
    const { run } = await dispatchProcessRun(modlyClient, capabilities, payload, { prepared: true });

    return markRecipeStepRunning(step, stepDefinition, run);
  }

  if (stepDefinition.id === 'export_mesh') {
    const meshPath = getRequiredRecipeMeshPath(steps, recipeRuntime.id, step.id);
    const exporterParams = recipeInput.export?.outputFormat
      ? { output_format: recipeInput.export.outputFormat }
      : {};
    const plan = planSmartCapability({
      capability: 'mesh exporter',
      params: exporterParams,
    }, capabilities);

    assertSupportedRecipePlan(plan, {
      recipe: recipeRuntime.id,
      stepId: step.id,
      expectedSurface: 'processRun.create',
      expectedTargetKind: 'process',
    });

    if (Object.hasOwn(plan.params ?? {}, 'output_path') || Object.hasOwn(plan.params ?? {}, 'outputPath')) {
      throw new ValidationError('mesh-exporter/export must stay in default_output_only mode for guided recipes.', {
        details: {
          field: Object.hasOwn(plan.params ?? {}, 'output_path') ? 'params.output_path' : 'outputPath',
          reason: 'unsupported_output_path_mvp',
          recipe: recipeRuntime.id,
          stepId: step.id,
          capability: EXPORTER_PROCESS_ID,
        },
      });
    }

    const resolvedExecution = resolveProcessCapabilityExecutionInput({
      kind: 'mesh',
      meshPath,
    }, plan);
    const payload = prepareProcessRunCreateInput(resolvedExecution.payload, { capabilities });
    const { run } = await dispatchProcessRun(modlyClient, capabilities, payload, { prepared: true });

    return markRecipeStepRunning(step, stepDefinition, run);
  }

  throw new ValidationError(`Unsupported recipe step launch: ${stepDefinition.id}.`, {
    details: { field: 'step.id', reason: 'unsupported_recipe_step_launch', stepId: stepDefinition.id },
  });
}

async function pollRecipeStepRun(modlyClient, recipeRuntime, step) {
  const stepDefinition = getRecipeStepDefinition(recipeRuntime, step.id);
  const runId = step.run?.runId;

  if (!runId) {
    throw new ValidationError(`Recipe step ${step.id} is missing run.runId for resume polling.`, {
      details: { field: `steps.${step.id}.run.runId`, reason: 'missing_recipe_run_id', recipe: recipeRuntime.id },
    });
  }

  if (stepDefinition.runKind === 'workflowRun') {
    const response = await modlyClient.getWorkflowRun(runId);
    return updateRecipeStepFromRun(step, stepDefinition, toWorkflowRun(runId, response));
  }

  const response = await modlyClient.getProcessRun(runId);
  return updateRecipeStepFromRun(step, stepDefinition, toProcessRun(runId, response));
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
      ...(resumeStep?.run ? buildRecipeStepOutputsFromRun(resumeStep.run) : {}),
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

export function buildRecipeEnvelope({ recipe, input, status, steps }) {
  const resolvedSteps = Array.isArray(steps) ? steps : [];

  return {
    recipe,
    status,
    steps: resolvedSteps,
    runIds: buildRecipeRunIds(resolvedSteps),
    outputs: buildRecipeOutputs(resolvedSteps),
    limits: buildRecipeLimits(recipe),
    nextAction: buildRecipeNextAction({ recipe, input, steps: resolvedSteps, status }),
  };
}

function assertCanonicalModelId(modelId, models) {
  const canonicalIds = new Set(models.map((model) => getModelId(model)).filter((id) => typeof id === 'string' && id !== 'unknown'));

  if (!canonicalIds.has(modelId)) {
    throw new ValidationError(`Unknown canonical modelId: ${modelId}.`, {
      details: {
        field: 'modelId',
        reason: 'non_canonical_model_id',
        modelId,
      },
    });
  }
}

function summarizeHealth(payload) {
  const status = payload?.status ?? payload?.state ?? 'unknown';
  return `Backend health: ${status}.`;
}

function summarizeCapabilities(capabilities) {
  const backendReady = capabilities?.backend_ready === true;
  const models = Array.isArray(capabilities?.models) ? capabilities.models.length : 0;
  const processes = Array.isArray(capabilities?.processes) ? capabilities.processes.length : 0;
  const errors = Array.isArray(capabilities?.errors) ? capabilities.errors.length : 0;

  return `Automation capabilities: backend_ready=${backendReady}, models=${models}, processes=${processes}, errors=${errors}.`;
}

function summarizeCapabilityPlan(plan) {
  return `Capability plan: ${plan.status}${plan.cap?.key ? ` (${plan.cap.key})` : ''}.`;
}

function summarizeCapabilityGuidance(guidance) {
  return `Capability guidance: ${guidance.status}${guidance.capability_key ? ` (${guidance.capability_key})` : ''}.`;
}

function summarizeModelList(models) {
  return models.length === 0 ? 'No models found.' : `Models available: ${models.length}.`;
}

function summarizeCurrentModel(model) {
  return model ? `Active model: ${getModelId(model)}.` : 'No active model.';
}

function summarizeModelParams(modelId) {
  return `Model params read for ${modelId}.`;
}

function summarizeExtensionErrors(errors) {
  const count = Array.isArray(errors) ? errors.length : Object.keys(errors).length;
  return count === 0 ? 'No extension load errors.' : `Extension load errors: ${count}.`;
}

function summarizeJob(jobId, job) {
  const status = typeof job?.status === 'string' ? job.status : 'unknown';
  return `Job ${jobId}: ${status}.`;
}

function summarizeWorkflowRun(runId, run, action = 'status') {
  const resolvedRunId = run?.run_id ?? run?.runId ?? runId;
  const status = typeof run?.status === 'string' ? run.status : 'unknown';

  switch (action) {
    case 'created':
      return `Workflow run ${resolvedRunId} created (${status}).`;
    case 'cancelled':
      return `Workflow run ${resolvedRunId} cancel requested (${status}).`;
    default:
      return `Workflow run ${resolvedRunId}: ${status}.`;
  }
}

function summarizeProcessRun(runId, run, action = 'status') {
  const resolvedRunId = run?.run_id ?? run?.runId ?? runId;
  const status = typeof run?.status === 'string' ? run.status : 'unknown';

  switch (action) {
    case 'created':
      return `Process run ${resolvedRunId} created (${status}).`;
    case 'cancelled':
      return `Process run ${resolvedRunId} cancel requested (${status}).`;
    default:
      return `Process run ${resolvedRunId}: ${status}.`;
  }
}

function isWorkflowRunTerminal(run) {
  return TERMINAL_WORKFLOW_RUN_STATUSES.has(typeof run?.status === 'string' ? run.status.toLowerCase() : '');
}

function isProcessRunTerminal(run) {
  return TERMINAL_PROCESS_RUN_STATUSES.has(typeof run?.status === 'string' ? run.status.toLowerCase() : '');
}

function getRunId(run) {
  return run?.run_id ?? run?.runId;
}

function getRunStatus(run) {
  return typeof run?.status === 'string' ? run.status.toLowerCase() : '';
}

function toOperationState(kind, run, terminal) {
  const status = getRunStatus(run);
  const states = kind === 'workflowRun' ? WORKFLOW_RUN_OPERATION_STATES : PROCESS_RUN_OPERATION_STATES;

  if (states[status]) {
    return states[status];
  }

  return terminal ? 'failed' : 'in_progress';
}

function buildRunMeta(kind, run, statusTool, opts = {}) {
  const runId = getRunId(run);
  const terminal = kind === 'workflowRun' ? isWorkflowRunTerminal(run) : isProcessRunTerminal(run);
  const meta = {
    terminal,
    operation: {
      kind,
      runId,
    },
    operationState: toOperationState(kind, run, terminal),
    nextAction: {
      kind: terminal ? 'observe_terminal' : 'poll_status',
      tool: statusTool,
      input: { runId },
    },
  };

  if (!terminal) {
    meta.suggestedPollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  }

  if (opts.polling) {
    meta.polling = opts.polling;
  }

  return meta;
}

function buildCapabilityExecuteMeta(polling = null) {
  return {
    polling,
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
  };
}

function buildCapabilityExecuteEnvelope({ plan, execution, run, polling, error = undefined }) {
  const envelope = {
    plan,
    execution,
    run,
    meta: buildCapabilityExecuteMeta(polling),
  };

  if (error !== undefined) {
    envelope.error = error;
  }

  return envelope;
}

function toCapabilityExecutionErrorCode(error) {
  return extractErrorEnvelope(error).code;
}

function toCapabilityExecutionError(error) {
  const envelope = extractErrorEnvelope(error);

  return {
    code: toCapabilityExecutionErrorCode(envelope.normalized),
    message: envelope.message,
    details: envelope.details,
  };
}

function summarizeCapabilityExecutionFailure(plan, execution) {
  return `Capability execution: ${plan.status} via ${execution.surface}; backend rejected execution.`;
}

function buildFailedCapabilityExecutionResult({ plan, execution, error }) {
  const executionError = toCapabilityExecutionError(error);

  executionError.diagnostic = buildCapabilityExecutionDiagnostic({
    plan,
    execution,
    error: executionError,
  });

  return {
    data: buildCapabilityExecuteEnvelope({
      plan,
      execution,
      run: null,
      polling: null,
      error: executionError,
    }),
    text: summarizeCapabilityExecutionFailure(plan, execution),
  };
}

function buildNonExecutedCapabilityResult(plan) {
  const execution = {
    executed: false,
    surface: null,
    arguments: null,
  };

  return {
    data: buildCapabilityExecuteEnvelope({
      plan,
      execution,
      run: null,
      polling: null,
    }),
    text: summarizeCapabilityExecution(plan, execution),
  };
}

function isFirstCutCapabilityExecutionSurface(planSurface) {
  return planSurface === 'workflowRun.createFromImage' || planSurface === 'processRun.create';
}

function toExecutionSurface(planSurface) {
  switch (planSurface) {
    case 'workflowRun.createFromImage':
      return 'modly.workflowRun.createFromImage';
    case 'processRun.create':
      return 'modly.processRun.create';
    default:
      return null;
  }
}

async function runHealthPreflight(modlyClient) {
  return modlyClient.health();
}

async function loadAutomationCapabilities(modlyClient) {
  return modlyClient.getAutomationCapabilities();
}

async function prepareAutomationContext(modlyClient) {
  const health = await runHealthPreflight(modlyClient);
  const capabilities = await loadAutomationCapabilities(modlyClient);
  return { health, capabilities };
}

function summarizeDiagnosticGuidance(result) {
  return `Diagnostic guidance: ${result.status}/${result.category}/${result.confidence}.`;
}

function toCapabilityExecutionRuntimeEvidence(details) {
  if (!isObject(details)) {
    return undefined;
  }

  if (isObject(details.runtimeEvidence)) {
    return details.runtimeEvidence;
  }

  const runtimeEvidence = {};

  if (typeof details.requestedUrl === 'string' && details.requestedUrl.trim() !== '') {
    runtimeEvidence.requestedUrl = details.requestedUrl;
  }

  if (isObject(details.response)) {
    runtimeEvidence.response = details.response;
  }

  if (details.body !== undefined) {
    runtimeEvidence.body = details.body;
  }

  if (typeof details.rawBody === 'string') {
    runtimeEvidence.rawBody = details.rawBody;
  }

  if (isObject(details.cause)) {
    runtimeEvidence.cause = details.cause;
  }

  return Object.keys(runtimeEvidence).length > 0 ? runtimeEvidence : undefined;
}

function buildCapabilityExecutionDiagnostic({ plan, execution, error }) {
  const diagnostic = {
    surface: 'backend_api',
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
    planner: {
      capability: plan?.cap?.key ?? plan?.cap?.requested,
      status: plan?.status,
      surface: plan?.surface,
      target: plan?.target,
      reasons: Array.isArray(plan?.reasons) ? plan.reasons : undefined,
    },
  };

  if (plan?.cap?.requested !== undefined || plan?.cap?.key !== undefined) {
    diagnostic.capability = {
      requested: plan?.cap?.requested,
      key: plan?.cap?.key,
    };
  }

  if (execution?.surface) {
    diagnostic.execution = { surface: execution.surface };
  }

  const runtimeEvidence = toCapabilityExecutionRuntimeEvidence(error.details);

  if (runtimeEvidence !== undefined) {
    diagnostic.runtimeEvidence = runtimeEvidence;
  }

  return diagnostic;
}

async function dispatchWorkflowRunFromImage(modlyClient, { imagePath, modelId, params }) {
  const modelsResponse = await modlyClient.listModels();
  const models = toModelList(modelsResponse);

  assertCanonicalModelId(modelId, models);

  const response = await modlyClient.createWorkflowRunFromImage({
    imagePath,
    modelId,
    paramsJson: params,
  });
  const run = toWorkflowRun(undefined, response);

  return {
    run,
    polling: buildRunMeta('workflowRun', run, 'modly.workflowRun.status'),
  };
}

async function dispatchProcessRun(modlyClient, capabilities, input, { prepared = false } = {}) {
  const payload = prepared ? input : prepareProcessRunCreateInput(input, { capabilities });
  const response = await modlyClient.createProcessRun(payload);
  const run = toProcessRun(undefined, response);

  return {
    payload,
    run,
    polling: buildRunMeta('processRun', run, 'modly.processRun.status'),
  };
}

function resolveCapabilityExecutionTarget(plan) {
  const targetId = typeof plan?.target?.id === 'string' && plan.target.id.trim() !== '' ? plan.target.id.trim() : null;

  if (targetId === null) {
    throw new ValidationError('Supported capability plan is missing a dispatch target.', {
      details: { field: 'plan.target.id', reason: 'missing_dispatch_target', planSurface: plan?.surface ?? null },
    });
  }

  return targetId;
}

function resolveImageCapabilityExecutionInput(input) {
  if (!isObject(input)) {
    throw new ValidationError('input must be a JSON object.', {
      details: { field: 'input', reason: 'invalid_input_shape' },
    });
  }

  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';

  if (kind !== 'image') {
    throw new ValidationError('input.kind must be "image" for workflow execution.', {
      details: { field: 'input.kind', reason: 'invalid_workflow_input_kind', value: input.kind ?? null },
    });
  }

  const imagePath = typeof input.imagePath === 'string' ? input.imagePath.trim() : '';

  if (imagePath === '') {
    throw new ValidationError('input.imagePath must be a non-empty string.', {
      details: { field: 'input.imagePath', reason: 'invalid_image_path' },
    });
  }

  return { kind, imagePath };
}

function resolveProcessCapabilityExecutionInput(input, plan) {
  const processId = resolveCapabilityExecutionTarget(plan);

  if (processId === OPTIMIZER_PROCESS_ID) {
    const resolvedInput = prepareCapabilityProcessInput(input);
    const executionInput = {
      process_id: processId,
      params: {
        mesh_path: resolvedInput.meshPath,
        ...plan.params,
      },
    };

    if (resolvedInput.workspacePath !== undefined) {
      executionInput.workspace_path = resolvedInput.workspacePath;
    }

    if (resolvedInput.outputPath !== undefined) {
      executionInput.outputPath = resolvedInput.outputPath;
    }

    return {
      payload: executionInput,
      outputMode: null,
    };
  }

  if (processId === EXPORTER_PROCESS_ID) {
    const resolvedInput = prepareCapabilityProcessInput(input, {
      processId,
      params: plan.params,
    });
    const executionInput = {
      process_id: processId,
      params: {
        mesh_path: resolvedInput.meshPath,
        ...resolvedInput.params,
      },
      workspace_path: resolvedInput.workspacePath,
    };

    return {
      payload: executionInput,
      outputMode: 'default_backend',
    };
  }

  return null;
}

function assertExporterExecutionRequestIsInScope(input, params, plan) {
  if (plan?.cap?.key !== 'mesh-exporter') {
    return;
  }

  prepareCapabilityProcessInput(input, {
    processId: EXPORTER_PROCESS_ID,
    params,
  });
}

function summarizeCapabilityExecution(plan, execution) {
  if (execution.executed) {
    return `Capability execution: ${plan.status} via ${execution.surface}.`;
  }

  return `Capability execution: ${plan.status}; not executed.`;
}

export function createToolHandlers({ client, apiUrl } = {}) {
  const modlyClient = client ?? createModlyApiClient({ apiUrl });

  return {
    async 'modly.capabilities.get'() {
      const response = await modlyClient.getAutomationCapabilities();
      const capabilities = toAutomationCapabilities(response);
      return { data: capabilities, text: summarizeCapabilities(capabilities) };
    },

    async 'modly.capability.plan'({ capability, params }) {
      const { capabilities } = await prepareAutomationContext(modlyClient);
      const plan = planSmartCapability({ capability, params }, capabilities);
      return { data: plan, text: summarizeCapabilityPlan(plan) };
    },

    async 'modly.capability.guide'({ capability, params }) {
      const { capabilities } = await prepareAutomationContext(modlyClient);
      const guidance = evaluateCapabilityGuidance({ capability, params }, capabilities);
      return { data: guidance, text: summarizeCapabilityGuidance(guidance) };
    },

    async 'modly.diagnostic.guidance'(input) {
      await prepareAutomationContext(modlyClient);
      const guidance = analyzeDiagnosticGuidance(input);

      return { data: guidance, text: summarizeDiagnosticGuidance(guidance) };
    },

    async 'modly.capability.execute'({ capability, input, params }) {
      const { capabilities } = await prepareAutomationContext(modlyClient);
      const plan = planSmartCapability({ capability, params }, capabilities);

      assertExporterExecutionRequestIsInScope(input, params, plan);

      if (plan.status !== 'supported') {
        return buildNonExecutedCapabilityResult(plan);
      }

      if (!isFirstCutCapabilityExecutionSurface(plan.surface)) {
        return buildNonExecutedCapabilityResult(plan);
      }

      let execution;
      let run;
      let polling;

      if (plan.surface === 'workflowRun.createFromImage') {
        const resolvedInput = resolveImageCapabilityExecutionInput(input);
        const modelId = resolveCapabilityExecutionTarget(plan);
        execution = {
          executed: true,
          surface: toExecutionSurface(plan.surface),
          arguments: {
            imagePath: resolvedInput.imagePath,
            modelId,
            params: plan.params,
          },
        };
        try {
          ({ run, polling } = await dispatchWorkflowRunFromImage(modlyClient, execution.arguments));
        } catch (error) {
          return buildFailedCapabilityExecutionResult({ plan, execution, error });
        }
      } else if (plan.surface === 'processRun.create') {
        const resolvedExecution = resolveProcessCapabilityExecutionInput(input, plan);

        if (resolvedExecution === null) {
          return buildNonExecutedCapabilityResult(plan);
        }

        const payload = prepareProcessRunCreateInput(resolvedExecution.payload, { capabilities });
        execution = {
          executed: true,
          surface: toExecutionSurface(plan.surface),
          arguments: payload,
          ...(resolvedExecution.outputMode ? { outputMode: resolvedExecution.outputMode } : {}),
        };
        try {
          ({ run, polling } = await dispatchProcessRun(modlyClient, capabilities, payload, { prepared: true }));
        } catch (error) {
          return buildFailedCapabilityExecutionResult({ plan, execution, error });
        }
      } else {
        return buildNonExecutedCapabilityResult(plan);
      }

      return {
        data: buildCapabilityExecuteEnvelope({ plan, execution, run, polling }),
        text: summarizeCapabilityExecution(plan, execution),
      };
    },

    async 'modly.recipe.execute'({ recipe, input, options }) {
      const recipeRuntime = resolveRecipeRuntime(recipe);
      const recipeInput = normalizeGuidedRecipeInput(recipeRuntime, input);
      const resume = parseRecipeResume(options?.resume);
      const { health, capabilities } = await prepareAutomationContext(modlyClient);
      const steps = buildRecipeSteps(recipeRuntime, resume);
      const activeStepIndex = steps.findIndex((step) => step.status === 'running' && step.run?.runId);

      try {
        assertRecipeBackendReady({ health, capabilities, recipe: recipeRuntime.id });
      } catch (error) {
        const fallbackStepIndex = activeStepIndex >= 0
          ? activeStepIndex
          : Math.max(steps.findIndex((step) => step.status === 'pending'), 0);
        markRecipeStepBoundaryFailure(steps, fallbackStepIndex, error);
        return buildRecipeResult({ recipe, input: recipeInput, steps });
      }

      if (activeStepIndex >= 0) {
        steps[activeStepIndex] = await pollRecipeStepRun(modlyClient, recipeRuntime, steps[activeStepIndex]);

        if (steps[activeStepIndex].status === 'succeeded') {
          const nextPendingStep = steps.find((step) => step.status === 'pending');

          if (nextPendingStep) {
            const nextIndex = steps.findIndex((step) => step.id === nextPendingStep.id);
            try {
              steps[nextIndex] = await launchRecipeStep(modlyClient, {
                recipeRuntime,
                recipeInput,
                step: steps[nextIndex],
                steps,
                capabilities,
              });
            } catch (error) {
              markRecipeStepBoundaryFailure(steps, nextIndex, error);
            }
          }
        }

        return buildRecipeResult({ recipe, input: recipeInput, steps });
      }

      if (steps.some((step) => step.status === 'failed' || step.status === 'partial_failed' || step.status === 'cancelled')) {
        return buildRecipeResult({ recipe, input: recipeInput, steps });
      }

      const nextPendingIndex = steps.findIndex((step) => step.status === 'pending');

      if (nextPendingIndex === -1) {
        return buildRecipeResult({ recipe, input: recipeInput, steps });
      }

      try {
        steps[nextPendingIndex] = await launchRecipeStep(modlyClient, {
          recipeRuntime,
          recipeInput,
          step: steps[nextPendingIndex],
          steps,
          capabilities,
        });
      } catch (error) {
        markRecipeStepBoundaryFailure(steps, nextPendingIndex, error);
      }

      return buildRecipeResult({ recipe, input: recipeInput, steps });
    },

    async 'modly.health'() {
      const data = await modlyClient.health();
      return { data, text: summarizeHealth(data) };
    },

    async 'modly.model.list'() {
      const response = await modlyClient.listModels();
      const models = toModelList(response);
      return { data: { models }, text: summarizeModelList(models) };
    },

    async 'modly.model.current'() {
      const response = await modlyClient.getCurrentModel();
      const model = toCurrentModel(response);
      return { data: { model }, text: summarizeCurrentModel(model) };
    },

    async 'modly.model.params'({ modelId }) {
      const modelsResponse = await modlyClient.listModels();
      const models = toModelList(modelsResponse);

      assertCanonicalModelId(modelId, models);

      const params = await modlyClient.getModelParams(modelId);
      return { data: { modelId, params }, text: summarizeModelParams(modelId) };
    },

    async 'modly.ext.errors'() {
      const result = await modlyClient.getExtensionErrors();
      const errors = normalizeErrors(result);
      return { data: { errors, result }, text: summarizeExtensionErrors(errors) };
    },

    async 'modly.config.paths.get'() {
      const result = await modlyClient.getRuntimePaths();
      const paths = normalizePaths(result);
      return { data: { paths, runtimeOnly: true }, text: 'Runtime paths read.' };
    },

    async 'modly.job.status'({ jobId }) {
      const response = await modlyClient.getJobStatus(jobId);
      const job = toJob(jobId, response);
      return { data: { jobId, job }, text: summarizeJob(jobId, job) };
    },

    async 'modly.workflowRun.createFromImage'({ imagePath, modelId, params }) {
      const { run, polling } = await dispatchWorkflowRunFromImage(modlyClient, { imagePath, modelId, params });
      return {
        data: {
          run,
          meta: polling,
        },
        text: summarizeWorkflowRun(undefined, run, 'created'),
      };
    },

    async 'modly.workflowRun.status'({ runId }) {
      const response = await modlyClient.getWorkflowRun(runId);
      const run = toWorkflowRun(runId, response);
      return {
        data: {
          run,
          meta: buildRunMeta('workflowRun', run, 'modly.workflowRun.status'),
        },
        text: summarizeWorkflowRun(runId, run),
      };
    },

    async 'modly.workflowRun.cancel'({ runId }) {
      const response = await modlyClient.cancelWorkflowRun(runId);
      const run = toWorkflowRun(runId, response);
      return { data: { run }, text: summarizeWorkflowRun(runId, run, 'cancelled') };
    },

    async 'modly.workflowRun.wait'({ runId, intervalMs, timeoutMs }) {
      const { run, polling } = await waitForWorkflowRun({
        client: modlyClient,
        runId,
        intervalMs,
        timeoutMs,
      });

      return {
        data: {
          run,
          meta: buildRunMeta('workflowRun', run, 'modly.workflowRun.status', { polling }),
        },
        text: summarizeWorkflowRun(runId, run),
      };
    },

    async 'modly.processRun.create'({ process_id, params, workspace_path, outputPath }) {
      const capabilities = await loadAutomationCapabilities(modlyClient);
      const { run, polling } = await dispatchProcessRun(modlyClient, capabilities, {
        process_id,
        params,
        workspace_path,
        outputPath,
      });

      return {
        data: {
          run,
          meta: polling,
        },
        text: summarizeProcessRun(undefined, run, 'created'),
      };
    },

    async 'modly.processRun.status'({ runId }) {
      const response = await modlyClient.getProcessRun(runId);
      const run = toProcessRun(runId, response);
      return {
        data: {
          run,
          meta: buildRunMeta('processRun', run, 'modly.processRun.status'),
        },
        text: summarizeProcessRun(runId, run),
      };
    },

    async 'modly.processRun.wait'({ runId, intervalMs, timeoutMs }) {
      const { run, polling } = await waitForProcessRun({
        client: modlyClient,
        runId,
        intervalMs,
        timeoutMs,
      });

      return {
        data: {
          run,
          meta: buildRunMeta('processRun', run, 'modly.processRun.status', { polling }),
        },
        text: summarizeProcessRun(runId, run),
      };
    },

    async 'modly.processRun.cancel'({ runId }) {
      const response = await modlyClient.cancelProcessRun(runId);
      const run = toProcessRun(runId, response);
      return { data: { run }, text: summarizeProcessRun(runId, run, 'cancelled') };
    },
  };
}
