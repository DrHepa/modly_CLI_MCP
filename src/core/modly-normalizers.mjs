function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
