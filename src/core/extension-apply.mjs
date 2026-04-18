import path from 'node:path';
import * as defaultFs from 'node:fs/promises';

import { ValidationError } from './errors.mjs';
import { inspectStagedExtension } from './github-extension-staging.mjs';
import { normalizeErrors } from './modly-normalizers.mjs';

function normalizeStagePath(stagePath, cwd) {
  if (typeof stagePath !== 'string' || stagePath.trim() === '') {
    throw new ValidationError('Expected --stage-path to point to a prepared extension stage.', {
      code: 'APPLY_STAGE_INVALID',
      details: {
        apply: {
          phase: 'preflight',
          code: 'APPLY_STAGE_INVALID',
          stagePath,
        },
      },
    });
  }

  return path.resolve(cwd, stagePath.trim());
}

function resolveExtensionsDir(extensionsDir, stagePath) {
  if (typeof extensionsDir !== 'string' || extensionsDir.trim() === '' || !path.isAbsolute(extensionsDir.trim())) {
    throw new ValidationError('Expected --extensions-dir to be an absolute path.', {
      code: 'EXTENSIONS_DIR_UNRESOLVABLE',
      details: {
        apply: {
          phase: 'resolve_extensions_dir',
          code: 'EXTENSIONS_DIR_UNRESOLVABLE',
          stagePath,
        },
      },
    });
  }

  return {
    extensionsDir: extensionsDir.trim(),
    source: 'cli-flag',
    verified: true,
  };
}

async function pathExists(targetPath) {
  try {
    await defaultFs.access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function createApplyOperationError({ message, code, phase, stagePath, manifestId, resolution, cause }) {
  return new ValidationError(message, {
    code,
    cause,
    details: {
      apply: {
        phase,
        code,
        stagePath,
        manifestId,
        resolution,
      },
    },
  });
}

function normalizeTrustedSourceValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function getTrustedManifestSource(input) {
  const repo = normalizeTrustedSourceValue(input.sourceRepo);
  const ref = normalizeTrustedSourceValue(input.sourceRef);
  const commit = normalizeTrustedSourceValue(input.sourceCommit);

  if (repo && ref && commit) {
    return {
      kind: 'github',
      repo,
      ref,
      commit,
    };
  }

  return null;
}

async function rewriteManifestSource(candidatePath, manifestSource, fs) {
  const manifestPath = path.join(candidatePath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.source = manifestSource;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
}

function toDiagnostic(error, fallbackCode) {
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? fallbackCode,
  };
}

function collectMatchedErrors(rawErrors, manifestId) {
  if (Array.isArray(rawErrors)) {
    return rawErrors.filter((entry) => {
      const candidateId = entry?.manifestId ?? entry?.manifest_id ?? entry?.extensionId ?? entry?.extension_id ?? entry?.id;
      return candidateId === manifestId;
    });
  }

  if (rawErrors && typeof rawErrors === 'object') {
    const directMatch = rawErrors[manifestId];

    if (Array.isArray(directMatch)) {
      return directMatch;
    }

    if (directMatch && typeof directMatch === 'object') {
      return [directMatch];
    }
  }

  return [];
}

function createApplyStageInvalidError(stagePath, stageInspection) {
  return new ValidationError(stageInspection?.diagnostics?.detail ?? 'Prepared stage is invalid for apply.', {
    code: 'APPLY_STAGE_INVALID',
    details: {
      apply: {
        phase: 'preflight',
        code: 'APPLY_STAGE_INVALID',
        stagePath,
        stageInspection: stageInspection?.diagnostics ?? null,
      },
    },
  });
}

function planPaths({ extensionsDir, manifestId, destinationExists }) {
  return {
    destination: {
      path: path.join(extensionsDir, manifestId),
      exists: destinationExists,
    },
    backup: {
      path: destinationExists ? path.join(extensionsDir, `${manifestId}.backup`) : null,
      expected: destinationExists,
      created: false,
      restored: null,
    },
    candidate: {
      path: path.join(extensionsDir, `${manifestId}.candidate`),
    },
  };
}

export async function applyStagedExtension(input = {}, deps = {}) {
  const fs = {
    ...defaultFs,
    ...(deps.fs ?? {}),
  };
  const reloadExtensions = deps.reloadExtensions;
  const getExtensionErrors = deps.getExtensionErrors;
  const cwd = deps.cwd ?? process.cwd();
  const stagePath = normalizeStagePath(input.stagePath, cwd);
  const resolution = resolveExtensionsDir(input.extensionsDir, stagePath);

  let stageInspection;

  try {
    stageInspection = await inspectStagedExtension(stagePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createApplyStageInvalidError(stagePath, {
        diagnostics: {
          phase: 'inspect',
          code: 'MANIFEST_MISSING',
          detail: 'manifest.json was not found in the staged extension snapshot.',
        },
      });
    }

    throw error;
  }

  if (stageInspection.status !== 'prepared' || !stageInspection.manifestSummary?.id) {
    throw createApplyStageInvalidError(stagePath, stageInspection);
  }

  const manifest = {
    id: stageInspection.manifestSummary.id,
    name: stageInspection.manifestSummary.name,
    version: stageInspection.manifestSummary.version,
    extensionType: stageInspection.manifestSummary.extensionType,
  };
  const destinationPath = path.join(resolution.extensionsDir, manifest.id);
  const destinationExists = await pathExists(destinationPath);
  const paths = planPaths({
    extensionsDir: resolution.extensionsDir,
    manifestId: manifest.id,
    destinationExists,
  });

  try {
    await fs.mkdir(resolution.extensionsDir, { recursive: true });
    await fs.rm(paths.candidate.path, { recursive: true, force: true });
    await fs.cp(stagePath, paths.candidate.path, { recursive: true, force: true });
  } catch (error) {
    throw createApplyOperationError({
      message: 'Failed to copy the prepared stage into the promotion candidate.',
      code: 'APPLY_COPY_FAILED',
      phase: 'copy_candidate',
      stagePath,
      manifestId: manifest.id,
      resolution,
      cause: error,
    });
  }

  const warnings = [...stageInspection.warnings];
  const trustedManifestSource = getTrustedManifestSource(input);

  if (trustedManifestSource) {
    await rewriteManifestSource(paths.candidate.path, trustedManifestSource, fs);
  } else {
    warnings.push({
      code: 'MANIFEST_SOURCE_UNCHANGED',
      message: 'manifest.source was left unchanged because no trusted GitHub source metadata was supplied.',
    });
  }

  let backupCreated = false;
  let backupRestored = paths.backup.expected ? false : null;

  try {
    if (paths.backup.expected) {
      await fs.rm(paths.backup.path, { recursive: true, force: true });
      await fs.rename(paths.destination.path, paths.backup.path);
      backupCreated = true;
    }

    await fs.rename(paths.candidate.path, paths.destination.path);
  } catch (error) {
    if (backupCreated) {
      try {
        await fs.rm(paths.destination.path, { recursive: true, force: true });
        await fs.rename(paths.backup.path, paths.destination.path);
        backupRestored = true;
      } catch {
        backupRestored = false;
      }
    }

    throw createApplyOperationError({
      message: 'Failed to promote the staged candidate into the live extension destination.',
      code: 'APPLY_PROMOTE_FAILED',
      phase: 'promote',
      stagePath,
      manifestId: manifest.id,
      resolution,
      cause: error,
    });
  }

  const reload = {
    requested: typeof reloadExtensions === 'function',
    succeeded: false,
  };

  if (typeof reloadExtensions === 'function') {
    try {
      await reloadExtensions();
      reload.succeeded = true;
    } catch (error) {
      reload.diagnostic = toDiagnostic(error, 'RELOAD_FAILED');
      warnings.push({
        code: 'RELOAD_FAILED',
        message: 'Extension reload request failed after promotion.',
        detail: reload.diagnostic,
      });
    }
  } else {
    reload.diagnostic = {
      code: 'RELOAD_FAILED',
      message: 'Reload dependency was not provided to applyStagedExtension().',
    };
    warnings.push({
      code: 'RELOAD_FAILED',
      message: 'Extension reload request failed after promotion.',
      detail: reload.diagnostic,
    });
  }

  const errors = {
    observed: false,
    matched: [],
  };

  if (typeof getExtensionErrors === 'function') {
    try {
      const rawErrors = normalizeErrors(await getExtensionErrors());
      errors.observed = true;
      errors.matched = collectMatchedErrors(rawErrors, manifest.id);
    } catch (error) {
      errors.diagnostic = toDiagnostic(error, 'ERRORS_UNOBSERVABLE');
      warnings.push({
        code: 'ERRORS_UNOBSERVABLE',
        message: 'Extension error observation failed after promotion.',
        detail: errors.diagnostic,
      });
    }
  } else {
    errors.diagnostic = {
      code: 'ERRORS_UNOBSERVABLE',
      message: 'Error observation dependency was not provided to applyStagedExtension().',
    };
    warnings.push({
      code: 'ERRORS_UNOBSERVABLE',
      message: 'Extension error observation failed after promotion.',
      detail: errors.diagnostic,
    });
  }

  if (errors.matched.length > 0) {
    warnings.push({
      code: 'EXTENSION_RUNTIME_ERRORS',
      message: 'Extension runtime errors were observed after reload for the promoted extension.',
      detail: errors.matched,
    });
  }

  return {
    status: reload.succeeded && errors.observed && errors.matched.length === 0 ? 'applied' : 'applied_degraded',
    applied: true,
    stagePath,
    manifest,
    resolution,
    destination: {
      ...paths.destination,
      exists: true,
    },
    backup: {
      ...paths.backup,
      created: backupCreated,
      restored: backupRestored,
    },
    candidate: paths.candidate,
    reload,
    errors,
    warnings,
  };
}
