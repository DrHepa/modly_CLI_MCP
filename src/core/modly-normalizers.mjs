function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.hasOwn(value ?? {}, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeProgress(payload) {
  const progress = firstDefined(payload?.progress, payload?.run?.progress, payload?.data?.progress);
  return typeof progress === 'number' ? progress : undefined;
}

function normalizeStep(payload) {
  return firstDefined(payload?.step, payload?.run?.step, payload?.data?.step);
}

function normalizeOutputUrl(payload) {
  return firstDefined(
    payload?.output_url,
    payload?.outputUrl,
    payload?.run?.output_url,
    payload?.run?.outputUrl,
    payload?.data?.output_url,
    payload?.data?.outputUrl,
  );
}

function normalizeError(payload) {
  return firstDefined(payload?.error, payload?.run?.error, payload?.data?.error);
}

function normalizeSceneCandidate(payload) {
  return firstDefined(
    payload?.scene_candidate,
    payload?.sceneCandidate,
    payload?.run?.scene_candidate,
    payload?.run?.sceneCandidate,
    payload?.data?.scene_candidate,
    payload?.data?.sceneCandidate,
  );
}

function normalizeWorkspacePath(payload) {
  return firstDefined(
    payload?.workspace_path,
    payload?.workspacePath,
    payload?.run?.workspace_path,
    payload?.run?.workspacePath,
    payload?.data?.workspace_path,
    payload?.data?.workspacePath,
  );
}

function normalizeParams(payload) {
  return isObject(payload?.params)
    ? payload.params
    : isObject(payload?.run?.params)
      ? payload.run.params
      : isObject(payload?.data?.params)
        ? payload.data.params
        : undefined;
}

export function toAutomationCapabilities(payload) {
  if (!isObject(payload)) {
    throw new TypeError('Capabilities payload must be an object.');
  }

  const hasCanonicalShape = [
    'backend_ready',
    'source',
    'errors',
    'excluded',
    'models',
    'processes',
  ].some((key) => hasOwn(payload, key));

  if (!hasCanonicalShape) {
    throw new TypeError('Capabilities payload is missing canonical fields.');
  }

  const excluded = isObject(payload.excluded) ? payload.excluded : {};

  return {
    backend_ready: payload.backend_ready,
    source: payload.source,
    errors: hasOwn(payload, 'errors') ? payload.errors : [],
    excluded: {
      ...excluded,
      ui_only_nodes: Array.isArray(excluded.ui_only_nodes) ? excluded.ui_only_nodes : [],
    },
    models: Array.isArray(payload.models) ? payload.models : [],
    processes: Array.isArray(payload.processes) ? payload.processes : [],
  };
}

export function toModelList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.models)) {
    return payload.models;
  }

  return [];
}

export function toCurrentModel(payload) {
  if (Object.hasOwn(payload ?? {}, 'model')) {
    return isObject(payload.model) ? payload.model : null;
  }

  return isObject(payload) ? payload : null;
}

export function toJob(jobId, payload) {
  if (isObject(payload?.job)) {
    return {
      ...payload.job,
      job_id: payload.job.job_id ?? payload.job.jobId ?? payload.job.id ?? payload.job_id ?? jobId,
    };
  }

  if (isObject(payload)) {
    return {
      ...payload,
      job_id: payload.job_id ?? payload.jobId ?? payload.id ?? jobId,
    };
  }

  return { job_id: jobId, status: undefined };
}

export function toWorkflowRun(runId, payload) {
  const source = isObject(payload?.run)
    ? payload.run
    : isObject(payload?.data?.run)
      ? payload.data.run
      : isObject(payload)
        ? payload
        : {};

  const resolvedRunId = firstDefined(source.run_id, source.runId, source.id, payload?.run_id, payload?.runId, runId);

  return {
    ...source,
    run_id: resolvedRunId,
    runId: resolvedRunId,
    status: firstDefined(source.status, payload?.status),
    progress: normalizeProgress(payload),
    step: normalizeStep(payload),
    outputUrl: normalizeOutputUrl(payload),
    error: normalizeError(payload),
    sceneCandidate: normalizeSceneCandidate(payload),
  };
}

export function getCanonicalProcessIds(capabilities) {
  const processes = Array.isArray(capabilities?.processes) ? capabilities.processes : [];
  const canonicalIds = new Set();

  for (const process of processes) {
    if (typeof process === 'string' && process.trim() !== '') {
      canonicalIds.add(process.trim());
      continue;
    }

    const candidate = firstDefined(process?.id, process?.process_id, process?.processId);

    if (typeof candidate === 'string' && candidate.trim() !== '') {
      canonicalIds.add(candidate.trim());
    }
  }

  return canonicalIds;
}

export function toProcessRun(runId, payload) {
  const source = isObject(payload?.run)
    ? payload.run
    : isObject(payload?.data?.run)
      ? payload.data.run
      : isObject(payload)
        ? payload
        : {};

  const resolvedRunId = firstDefined(source.run_id, source.runId, source.id, payload?.run_id, payload?.runId, runId);
  const resolvedProcessId = firstDefined(
    source.process_id,
    source.processId,
    payload?.process_id,
    payload?.processId,
  );

  return {
    ...source,
    run_id: resolvedRunId,
    runId: resolvedRunId,
    process_id: resolvedProcessId,
    processId: resolvedProcessId,
    status: firstDefined(source.status, payload?.status),
    params: normalizeParams(payload),
    workspacePath: normalizeWorkspacePath(payload),
    outputUrl: normalizeOutputUrl(payload),
    error: normalizeError(payload),
  };
}

export function normalizePaths(payload) {
  if (isObject(payload?.paths)) {
    return payload.paths;
  }

  return isObject(payload) ? payload : {};
}

export function normalizeErrors(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.errors)) {
    return payload.errors;
  }

  if (isObject(payload?.errors)) {
    return payload.errors;
  }

  return isObject(payload) ? payload : {};
}
