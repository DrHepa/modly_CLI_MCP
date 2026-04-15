import { createModlyApiClient } from '../../core/modly-api.mjs';
import { ValidationError } from '../../core/errors.mjs';
import {
  normalizeErrors,
  normalizePaths,
  toAutomationCapabilities,
  toCurrentModel,
  toJob,
  toModelList,
  toProcessRun,
  toWorkflowRun,
} from '../../core/modly-normalizers.mjs';
import {
  prepareProcessRunCreateInput,
} from '../../core/process-run-input.mjs';
import { planSmartCapability } from '../../core/smart-capability-planner.mjs';
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

function getModelId(model) {
  return model?.id ?? model?.model_id ?? model?.modelId ?? 'unknown';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function buildCapabilityExecuteEnvelope({ plan, execution, run, polling }) {
  return {
    plan,
    execution,
    run,
    meta: buildCapabilityExecuteMeta(polling),
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
  return planSurface === 'workflowRun.createFromImage';
}

function toExecutionSurface(planSurface) {
  switch (planSurface) {
    case 'workflowRun.createFromImage':
      return 'modly.workflowRun.createFromImage';
    default:
      return null;
  }
}

async function runHealthPreflight(modlyClient) {
  await modlyClient.health();
}

async function loadAutomationCapabilities(modlyClient) {
  return modlyClient.getAutomationCapabilities();
}

async function prepareAutomationContext(modlyClient) {
  await runHealthPreflight(modlyClient);
  const capabilities = await loadAutomationCapabilities(modlyClient);
  return { capabilities };
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

async function dispatchProcessRun(modlyClient, capabilities, input) {
  const payload = prepareProcessRunCreateInput(input, { capabilities });
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

    async 'modly.capability.execute'({ capability, input, params }) {
      const { capabilities } = await prepareAutomationContext(modlyClient);
      const plan = planSmartCapability({ capability, params }, capabilities);

      if (plan.status !== 'supported') {
        return buildNonExecutedCapabilityResult(plan);
      }

      if (!isFirstCutCapabilityExecutionSurface(plan.surface)) {
        return buildNonExecutedCapabilityResult(plan);
      }

      const resolvedInput = resolveImageCapabilityExecutionInput(input);
      const modelId = resolveCapabilityExecutionTarget(plan);
      const execution = {
        executed: true,
        surface: toExecutionSurface(plan.surface),
        arguments: {
          imagePath: resolvedInput.imagePath,
          modelId,
          params: plan.params,
        },
      };
      const { run, polling } = await dispatchWorkflowRunFromImage(modlyClient, execution.arguments);

      return {
        data: buildCapabilityExecuteEnvelope({ plan, execution, run, polling }),
        text: summarizeCapabilityExecution(plan, execution),
      };
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
