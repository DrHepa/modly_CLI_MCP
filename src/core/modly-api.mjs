import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolveAutomationCapabilitiesUrl, resolveProcessRunsUrl } from './config.mjs';
import { MODLY_API_CONTRACT } from './contracts.mjs';
import { ModlyError } from './errors.mjs';
import { requestBinary, requestJson, requestJsonRuntime, requestStream } from './http.mjs';
import { toAutomationCapabilities } from './modly-normalizers.mjs';

function resolvePath(template, replacements = {}) {
  return Object.entries(replacements).reduce(
    (path, [key, value]) => path.replace(`:${key}`, encodeURIComponent(String(value))),
    template,
  );
}

async function createImageFormData({ imagePath, modelId, collection, remesh, texture, textureResolution, paramsJson }) {
  const form = new FormData();
  const bytes = await readFile(imagePath);
  const fileName = path.basename(imagePath) || 'input-image';
  const imageMimeType = inferImageMimeType(fileName);

  form.set('image', new Blob([bytes], imageMimeType ? { type: imageMimeType } : undefined), fileName);
  form.set('model_id', modelId);

  if (collection) form.set('collection', collection);
  if (remesh) form.set('remesh', remesh);
  if (texture !== undefined) form.set('enable_texture', String(Boolean(texture)));
  if (textureResolution !== undefined) form.set('texture_resolution', String(textureResolution));
  if (paramsJson !== undefined) {
    form.set('params', typeof paramsJson === 'string' ? paramsJson : JSON.stringify(paramsJson));
  }

  return form;
}

function inferImageMimeType(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return undefined;
  }
}

function toCapabilitiesResponseDetails(result) {
  return {
    responseReceived: result.responseReceived,
    status: result.status,
    statusText: result.statusText,
    url: result.url,
    contentType: result.contentType,
  };
}

function toCapabilitiesDiagnosticDetails({ runtimeEvidence, classificationBranch, reason, payload }) {
  const details = { classificationBranch };

  if (runtimeEvidence?.requestedUrl !== undefined) {
    details.requestedUrl = runtimeEvidence.requestedUrl;
  }

  if (runtimeEvidence?.response !== undefined) {
    details.response = runtimeEvidence.response;
  }

  if (runtimeEvidence?.body !== undefined) {
    details.body = runtimeEvidence.body;
  }

  if (runtimeEvidence?.rawBody !== undefined) {
    details.rawBody = runtimeEvidence.rawBody;
  }

  if (runtimeEvidence?.cause !== undefined) {
    details.cause = runtimeEvidence.cause;
  }

  if (reason !== undefined) {
    details.reason = reason;
  }

  if (payload !== undefined) {
    details.payload = payload;
  }

  return details;
}

function toCapabilitiesFailureBranch({ error, runtimeEvidence, parseError }) {
  if (parseError?.code === 'INVALID_CONTENT_TYPE') {
    return 'invalid_content_type';
  }

  if (parseError?.code === 'INVALID_JSON_RESPONSE') {
    return 'invalid_json';
  }

  if (runtimeEvidence?.response?.status >= 500) {
    return 'http_5xx';
  }

  if (
    error?.code === 'TIMEOUT'
    || error?.details?.reason === 'TIMEOUT'
    || error?.cause?.code === 'TIMEOUT'
    || error?.cause?.name === 'TimeoutError'
    || runtimeEvidence?.cause?.name === 'AbortError'
    || runtimeEvidence?.cause?.code === 'ABORT_ERR'
  ) {
    return 'timeout';
  }

  if (runtimeEvidence?.response === undefined) {
    return 'transport_error';
  }

  return 'invalid_capabilities_payload';
}

function toInvalidCapabilitiesPayloadError({ result, reason, payload, rawBody, cause }) {
  const details = toCapabilitiesDiagnosticDetails({
    runtimeEvidence: result.runtimeEvidence ?? {
      requestedUrl: result.url,
      response: toCapabilitiesResponseDetails(result),
      rawBody,
    },
    classificationBranch: toCapabilitiesFailureBranch({
      runtimeEvidence: result.runtimeEvidence,
      parseError: result.parseError,
    }),
    reason,
    payload,
  });

  return new ModlyError('Invalid automation capabilities payload.', {
    code: 'INVALID_CAPABILITIES_PAYLOAD',
    details,
    cause,
  });
}

export function createModlyApiClient({
  apiUrl,
  automationUrl = process.env.MODLY_AUTOMATION_URL,
  processUrl = process.env.MODLY_PROCESS_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const automationCapabilitiesUrl = resolveAutomationCapabilitiesUrl({ apiUrl, automationUrl });
  const processRunsUrl = resolveProcessRunsUrl({ apiUrl, processUrl });
  const context = { baseUrl: apiUrl, fetchImpl };
  const processRunsContext = { ...context, baseUrl: processRunsUrl };

  return {
    apiUrl,

    async health() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.health });
    },

    async getAutomationCapabilities() {
      let result;

      try {
        result = await requestJsonRuntime({
          ...context,
          baseUrl: automationCapabilitiesUrl,
          ...MODLY_API_CONTRACT.getAutomationCapabilities,
        });
      } catch (error) {
        if (error instanceof ModlyError && error.code === 'BACKEND_UNAVAILABLE') {
          throw new ModlyError(error.message, {
            code: error.code,
            cause: error.cause,
            details: toCapabilitiesDiagnosticDetails({
              runtimeEvidence: error.details?.runtimeEvidence,
              classificationBranch: toCapabilitiesFailureBranch({
                error,
                runtimeEvidence: error.details?.runtimeEvidence,
              }),
            }),
          });
        }

        throw error;
      }

      if (result.parseError) {
        throw toInvalidCapabilitiesPayloadError({
          result,
          reason: result.parseError.code,
          rawBody: result.rawBody,
          cause: result.parseError,
        });
      }

      const payload = result.payload;

      try {
        return toAutomationCapabilities(payload);
      } catch (error) {
        throw toInvalidCapabilitiesPayloadError({
          result,
          reason: error?.message,
          payload,
          cause: error,
        });
      }
    },

    async listModels() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.listModels });
    },

    async getCurrentModel() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.getCurrentModel });
    },

    async getModelParams(modelId) {
      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.getModelParams,
        query: { model_id: modelId },
      });
    },

    async switchModel(modelId) {
      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.switchModel,
        query: { model_id: modelId },
      });
    },

    async unloadAllModels() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.unloadAllModels });
    },

    async downloadModel({ repoId, modelId, skipPrefixes = [] }) {
      return requestStream({
        ...context,
        ...MODLY_API_CONTRACT.downloadModel,
        query: {
          repo_id: repoId,
          model_id: modelId,
          skip_prefixes: JSON.stringify(skipPrefixes),
        },
      });
    },

    async generateFromImage(input) {
      const form = await createImageFormData(input);

      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.generateFromImage,
        body: form,
      });
    },

    async createWorkflowRunFromImage(input) {
      const form = await createImageFormData(input);

      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.createWorkflowRunFromImage,
        body: form,
      });
    },

    async createProcessRun(payload) {
      return requestJson({
        ...processRunsContext,
        ...MODLY_API_CONTRACT.createProcessRun,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },

    async getJobStatus(jobId) {
      return requestJson({
        ...context,
        method: MODLY_API_CONTRACT.getJobStatus.method,
        path: resolvePath(MODLY_API_CONTRACT.getJobStatus.path, { jobId }),
      });
    },

    async cancelJob(jobId) {
      return requestJson({
        ...context,
        method: MODLY_API_CONTRACT.cancelJob.method,
        path: resolvePath(MODLY_API_CONTRACT.cancelJob.path, { jobId }),
      });
    },

    async getWorkflowRun(runId) {
      return requestJson({
        ...context,
        method: MODLY_API_CONTRACT.getWorkflowRun.method,
        path: resolvePath(MODLY_API_CONTRACT.getWorkflowRun.path, { runId }),
      });
    },

    async cancelWorkflowRun(runId) {
      return requestJson({
        ...context,
        method: MODLY_API_CONTRACT.cancelWorkflowRun.method,
        path: resolvePath(MODLY_API_CONTRACT.cancelWorkflowRun.path, { runId }),
      });
    },

    async getProcessRun(runId) {
      return requestJson({
        ...processRunsContext,
        method: MODLY_API_CONTRACT.getProcessRun.method,
        path: resolvePath(MODLY_API_CONTRACT.getProcessRun.path, { runId }),
      });
    },

    async cancelProcessRun(runId) {
      return requestJson({
        ...processRunsContext,
        method: MODLY_API_CONTRACT.cancelProcessRun.method,
        path: resolvePath(MODLY_API_CONTRACT.cancelProcessRun.path, { runId }),
      });
    },

    async optimizeMesh(payload) {
      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.optimizeMesh,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },

    async smoothMesh(payload) {
      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.smoothMesh,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },

    async exportMesh({ format, path }) {
      return requestBinary({
        ...context,
        method: MODLY_API_CONTRACT.exportMesh.method,
        path: resolvePath(MODLY_API_CONTRACT.exportMesh.path, { format }),
        query: { path },
      });
    },

    async reloadExtensions() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.reloadExtensions });
    },

    async getExtensionErrors() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.getExtensionErrors });
    },

    async getRuntimePaths() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.getRuntimePaths });
    },

    async setRuntimePaths(payload) {
      return requestJson({
        ...context,
        ...MODLY_API_CONTRACT.setRuntimePaths,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
  };
}
