import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { SCENE_MESH_IMPORT_CONTRACT } from './contracts.mjs';
import { UnsupportedOperationError, ValidationError } from './errors.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim();
}

function normalizeWorkspacePathSeparators(meshPath) {
  return meshPath.trim().replace(/\\+/g, '/').split('/').filter((segment) => segment !== '').join('/');
}

function isWindowsAbsolutePath(meshPath) {
  return /^[A-Za-z]:[\\/]/.test(meshPath) || meshPath.startsWith('\\\\');
}

function isInsideWorkspace({ workspaceRoot, candidate }) {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validationError(message, details) {
  return new ValidationError(message, {
    details: {
      field: 'meshPath',
      ...details,
    },
  });
}

function unsupportedSceneImportError() {
  return new UnsupportedOperationError('Desktop scene mesh import is not supported by the current bridge.', {
    code: 'SCENE_IMPORT_UNSUPPORTED',
    details: {
      capability: SCENE_MESH_IMPORT_CONTRACT.capability,
      recovery: 'Update or repair Modly Desktop so the Electron bridge advertises scene.import_mesh support.',
    },
  });
}

function pickSceneImportCapability(capabilities) {
  if (!isObject(capabilities?.scene)) {
    return undefined;
  }

  return capabilities.scene.import_mesh ?? capabilities.scene.importMesh;
}

export function isSceneMeshImportSupported(capabilities) {
  return pickSceneImportCapability(capabilities)?.supported === true;
}

export function getSceneMeshImportExtensions(capabilities) {
  const advertised = pickSceneImportCapability(capabilities)?.extensions;

  if (!Array.isArray(advertised) || advertised.length === 0) {
    return [...SCENE_MESH_IMPORT_CONTRACT.extensions];
  }

  const normalized = advertised
    .filter((extension) => typeof extension === 'string' && extension.trim() !== '')
    .map((extension) => extension.trim().toLowerCase())
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`))
    .filter((extension) => SCENE_MESH_IMPORT_CONTRACT.extensions.includes(extension));

  return normalized.length > 0 ? normalized : [...SCENE_MESH_IMPORT_CONTRACT.extensions];
}

export async function validateSceneMeshImportPath({
  workspaceRoot = process.cwd(),
  meshPath,
  allowedExtensions = SCENE_MESH_IMPORT_CONTRACT.extensions,
} = {}) {
  if (typeof meshPath !== 'string' || meshPath.trim() === '') {
    throw validationError('Mesh path must be a non-empty workspace-relative path.', { reason: 'empty_path' });
  }

  if (path.isAbsolute(meshPath) || isWindowsAbsolutePath(meshPath)) {
    throw validationError('Mesh path must be workspace-relative.', { reason: 'absolute_path' });
  }

  const normalizedMeshPath = normalizeWorkspacePathSeparators(meshPath);
  const segments = normalizedMeshPath.split('/');

  if (segments.includes('..')) {
    throw validationError('Mesh path must not traverse outside the workspace.', {
      reason: 'path_traversal',
      value: normalizedMeshPath,
    });
  }

  const extension = path.posix.extname(normalizedMeshPath).toLowerCase();
  const normalizedAllowedExtensions = allowedExtensions.map((value) => value.toLowerCase());

  if (!normalizedAllowedExtensions.includes(extension)) {
    throw validationError('Mesh path extension is not supported for scene import.', {
      reason: 'unsupported_extension',
      value: normalizedMeshPath,
      extension,
      allowedExtensions: normalizedAllowedExtensions,
    });
  }

  const realWorkspaceRoot = await realpath(workspaceRoot);
  const candidatePath = path.resolve(realWorkspaceRoot, ...segments);

  if (!isInsideWorkspace({ workspaceRoot: realWorkspaceRoot, candidate: candidatePath })) {
    throw validationError('Mesh path must stay inside the workspace.', {
      reason: 'path_traversal',
      value: normalizedMeshPath,
    });
  }

  let candidateStat;

  try {
    candidateStat = await stat(candidatePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw validationError('Mesh path does not exist.', {
        reason: 'missing_file',
        value: normalizedMeshPath,
      });
    }

    throw error;
  }

  if (!candidateStat.isFile()) {
    throw validationError('Mesh path must point to a file.', {
      reason: 'not_a_file',
      value: normalizedMeshPath,
    });
  }

  const realCandidatePath = await realpath(candidatePath);

  if (!isInsideWorkspace({ workspaceRoot: realWorkspaceRoot, candidate: realCandidatePath })) {
    throw validationError('Mesh path realpath must stay inside the workspace.', {
      reason: 'path_traversal',
      value: normalizedMeshPath,
    });
  }

  return {
    meshPath: normalizedMeshPath,
    absolutePath: realCandidatePath,
    extension,
  };
}

export function toSceneMeshImportResult(payload, meshPath) {
  const status = firstString(payload?.status, payload?.state) ?? 'unknown';
  const result = {
    status,
    meshPath: firstString(payload?.mesh_path, payload?.meshPath) ?? meshPath,
  };

  const sceneId = firstString(payload?.scene_id, payload?.sceneId);
  const objectId = firstString(payload?.object_id, payload?.objectId);
  const runId = firstString(payload?.run_id, payload?.runId);
  const statusUrl = firstString(payload?.status_url, payload?.statusUrl);

  if (sceneId !== undefined) result.sceneId = sceneId;
  if (objectId !== undefined) result.objectId = objectId;
  if (runId !== undefined) result.runId = runId;
  if (statusUrl !== undefined) result.statusUrl = statusUrl;

  return result;
}

export async function importSceneMeshWithBridge({
  workspaceRoot = process.cwd(),
  meshPath,
  capabilities,
  importSceneMesh,
} = {}) {
  if (!isSceneMeshImportSupported(capabilities)) {
    throw unsupportedSceneImportError();
  }

  if (typeof importSceneMesh !== 'function') {
    throw unsupportedSceneImportError();
  }

  const validated = await validateSceneMeshImportPath({
    workspaceRoot,
    meshPath,
    allowedExtensions: getSceneMeshImportExtensions(capabilities),
  });
  const payload = { mesh_path: validated.meshPath };
  const bridgeResponse = await importSceneMesh(payload);

  return toSceneMeshImportResult(bridgeResponse, validated.meshPath);
}
