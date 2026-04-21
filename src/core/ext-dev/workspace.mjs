import path from 'node:path';
import * as defaultFs from 'node:fs/promises';

import { ValidationError } from '../errors.mjs';

const MANIFEST_FILENAME = 'manifest.json';

function createWorkspaceValidationError(message, code, details = {}) {
  return new ValidationError(message, {
    code,
    details: {
      extDev: {
        ...details,
        code,
      },
    },
  });
}

function normalizeWorkspaceInput(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw createWorkspaceValidationError('Expected a non-empty workspace path relative to the current directory.', 'EXT_DEV_WORKSPACE_REQUIRED', {
      phase: 'resolve_workspace',
      workspace,
    });
  }

  return workspace.trim();
}

function assertRelativeWorkspace(workspace, cwd) {
  if (path.isAbsolute(workspace)) {
    throw createWorkspaceValidationError('Expected a workspace-relative path; absolute paths are outside the local planner boundary.', 'EXT_DEV_WORKSPACE_ABSOLUTE', {
      phase: 'resolve_workspace',
      cwd,
      workspace,
    });
  }

  const resolvedPath = path.resolve(cwd, workspace);
  const relativePath = path.relative(cwd, resolvedPath);

  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    throw createWorkspaceValidationError('Workspace traversal outside the current directory is not allowed for local extension planning.', 'EXT_DEV_WORKSPACE_TRAVERSAL', {
      phase: 'resolve_workspace',
      cwd,
      workspace,
      resolvedPath,
    });
  }

  return resolvedPath;
}

async function readTargetType(targetPath, fs) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function resolveManifestCandidate({ resolvedWorkspacePath, targetStat }) {
  if (targetStat?.isFile()) {
    if (path.basename(resolvedWorkspacePath) !== MANIFEST_FILENAME) {
      throw createWorkspaceValidationError('V1 only supports manifest.json as the manifest filename for local extension planning.', 'EXT_DEV_MANIFEST_FILENAME_UNSUPPORTED', {
        phase: 'resolve_workspace',
        workspace: resolvedWorkspacePath,
        supportedManifestFilenames: [MANIFEST_FILENAME],
      });
    }

    return {
      root: path.dirname(resolvedWorkspacePath),
      manifestPath: resolvedWorkspacePath,
    };
  }

  return {
    root: resolvedWorkspacePath,
    manifestPath: path.join(resolvedWorkspacePath, MANIFEST_FILENAME),
  };
}

async function readManifestJson(manifestPath, fs) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createWorkspaceValidationError('V1 only supports manifest.json and it was not found in the selected workspace.', 'EXT_DEV_MANIFEST_MISSING', {
        phase: 'read_manifest',
        manifestPath,
        manifestFilename: MANIFEST_FILENAME,
        supportedManifestFilenames: [MANIFEST_FILENAME],
      });
    }

    if (error instanceof SyntaxError) {
      throw createWorkspaceValidationError('manifest.json could not be parsed as valid JSON.', 'EXT_DEV_MANIFEST_INVALID', {
        phase: 'read_manifest',
        manifestPath,
        manifestFilename: MANIFEST_FILENAME,
      });
    }

    throw error;
  }
}

export async function resolveExtDevWorkspace({ cwd = process.cwd(), workspace, fs = defaultFs } = {}) {
  const normalizedWorkspace = normalizeWorkspaceInput(workspace);
  const normalizedCwd = path.resolve(cwd);
  const resolvedWorkspacePath = assertRelativeWorkspace(normalizedWorkspace, normalizedCwd);
  const targetStat = await readTargetType(resolvedWorkspacePath, fs);
  const { root, manifestPath } = resolveManifestCandidate({ resolvedWorkspacePath, targetStat });
  const manifest = await readManifestJson(manifestPath, fs);

  return {
    root,
    manifestPath,
    manifestFilename: MANIFEST_FILENAME,
    manifest,
  };
}

export { MANIFEST_FILENAME };
