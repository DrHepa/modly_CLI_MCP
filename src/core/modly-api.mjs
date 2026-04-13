import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { MODLY_API_CONTRACT } from './contracts.mjs';
import { requestBinary, requestJson, requestStream } from './http.mjs';

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

export function createModlyApiClient({ apiUrl, fetchImpl = globalThis.fetch } = {}) {
  const context = { baseUrl: apiUrl, fetchImpl };

  return {
    apiUrl,

    async health() {
      return requestJson({ ...context, ...MODLY_API_CONTRACT.health });
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
