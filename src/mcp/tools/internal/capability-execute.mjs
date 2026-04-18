import { ValidationError, extractErrorEnvelope } from '../../../core/errors.mjs';
import { prepareCapabilityProcessInput, prepareProcessRunCreateInput } from '../../../core/process-run-input.mjs';
import { planSmartCapability } from '../../../core/smart-capability-planner.mjs';
import {
  dispatchProcessRun,
  dispatchWorkflowRunFromImage,
  getProcessExecutionScope,
  isFirstCutExecutionSurface,
  resolveDispatchTarget,
  toObservedExecutionSurface,
} from './run-dispatch.mjs';
import { prepareAutomationContext } from './automation-context.mjs';

const EXPORTER_PROCESS_ID = 'mesh-exporter/export';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

export function resolveProcessCapabilityExecutionInput(input, plan) {
  const processId = resolveDispatchTarget(plan);
  const executionScope = getProcessExecutionScope(processId);

  if (executionScope === 'optimizer') {
    const resolvedInput = prepareCapabilityProcessInput(input, { processId });
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

  if (executionScope === 'exporter') {
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

export function createCapabilityExecuteHandler(modlyClient) {
  return async function capabilityExecuteHandler({ capability, input, params }) {
    const { capabilities } = await prepareAutomationContext(modlyClient);
    const plan = planSmartCapability({ capability, params }, capabilities);

    assertExporterExecutionRequestIsInScope(input, params, plan);

    if (plan.status !== 'supported') {
      return buildNonExecutedCapabilityResult(plan);
    }

    if (!isFirstCutExecutionSurface(plan.surface)) {
      return buildNonExecutedCapabilityResult(plan);
    }

    let execution;
    let run;
    let polling;

    if (plan.surface === 'workflowRun.createFromImage') {
      const resolvedInput = resolveImageCapabilityExecutionInput(input);
      const modelId = resolveDispatchTarget(plan);
      execution = {
        executed: true,
        surface: toObservedExecutionSurface(plan.surface),
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
        surface: toObservedExecutionSurface(plan.surface),
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
  };
}
