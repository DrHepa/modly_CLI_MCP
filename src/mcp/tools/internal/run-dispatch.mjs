import { ValidationError } from '../../../core/errors.mjs';
import { toProcessRun, toWorkflowRun, toModelList } from '../../../core/modly-normalizers.mjs';
import { prepareProcessRunCreateInput } from '../../../core/process-run-input.mjs';
import { buildRunMeta } from './run-meta.mjs';

const OPTIMIZER_PROCESS_ID = 'mesh-optimizer/optimize';
const EXPORTER_PROCESS_ID = 'mesh-exporter/export';

function getModelId(model) {
  return model?.id ?? model?.model_id ?? model?.modelId ?? 'unknown';
}

export function assertCanonicalModelId(modelId, models) {
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

export async function dispatchWorkflowRunFromImage(modlyClient, { imagePath, modelId, params }) {
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

export async function dispatchProcessRun(modlyClient, capabilities, input, { prepared = false } = {}) {
  const payload = prepared ? input : prepareProcessRunCreateInput(input, { capabilities });
  const response = await modlyClient.createProcessRun(payload);
  const run = toProcessRun(undefined, response);

  return {
    payload,
    run,
    polling: buildRunMeta('processRun', run, 'modly.processRun.status'),
  };
}

export function resolveDispatchTarget(plan) {
  const targetId = typeof plan?.target?.id === 'string' && plan.target.id.trim() !== '' ? plan.target.id.trim() : null;

  if (targetId === null) {
    throw new ValidationError('Supported capability plan is missing a dispatch target.', {
      details: { field: 'plan.target.id', reason: 'missing_dispatch_target', planSurface: plan?.surface ?? null },
    });
  }

  return targetId;
}

export function isFirstCutExecutionSurface(planSurface) {
  return planSurface === 'workflowRun.createFromImage' || planSurface === 'processRun.create';
}

export function toObservedExecutionSurface(planSurface) {
  switch (planSurface) {
    case 'workflowRun.createFromImage':
      return 'modly.workflowRun.createFromImage';
    case 'processRun.create':
      return 'modly.processRun.create';
    default:
      return null;
  }
}

export function getProcessExecutionScope(processId) {
  if (processId === OPTIMIZER_PROCESS_ID) {
    return 'optimizer';
  }

  if (processId === EXPORTER_PROCESS_ID) {
    return 'exporter';
  }

  return null;
}
