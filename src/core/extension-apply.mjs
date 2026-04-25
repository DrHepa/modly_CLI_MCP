import path from 'node:path';
import * as defaultFs from 'node:fs/promises';

import { ValidationError } from './errors.mjs';
import {
  assertPathWithinDirectory,
  normalizeExtensionManifestId,
  resolveContainedExtensionPath,
} from './extension-manifest-id.mjs';
import { configureStagedExtension } from './extension-setup.mjs';
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
  if (typeof extensionsDir !== 'string' || extensionsDir.trim() === '') {
    throw new ValidationError('Expected --extensions-dir to be provided explicitly for the live target.', {
      code: 'EXTENSIONS_DIR_REQUIRED',
      details: {
        apply: {
          phase: 'resolve_extensions_dir',
          code: 'EXTENSIONS_DIR_REQUIRED',
          stagePath,
        },
      },
    });
  }

  if (!path.isAbsolute(extensionsDir.trim())) {
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

function createApplyOperationError({ message, code, phase, stagePath, manifestId, resolution, cause, extraDetails = {} }) {
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
        ...extraDetails,
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
    return `https://github.com/${repo}`;
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canObserveExtensionErrors(payload) {
  return Array.isArray(payload)
    || Array.isArray(payload?.errors)
    || isObject(payload?.errors)
    || isObject(payload);
}

function observeExtensionErrors(payload, manifestId) {
  if (!canObserveExtensionErrors(payload)) {
    return {
      observed: false,
      matched: [],
      diagnostic: {
        code: 'ERRORS_UNOBSERVABLE',
        message: 'Extension error observation returned an unsupported payload.',
      },
    };
  }

  return {
    observed: true,
    matched: collectMatchedErrors(normalizeErrors(payload), manifestId),
  };
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

function planPaths({ extensionsDir, manifestId, destinationExists, backupMode = 'when-destination-exists' }) {
  const expectsBackup = backupMode === 'when-destination-exists' && destinationExists;

  return {
    destination: {
      path: resolveContainedExtensionPath(extensionsDir, manifestId),
      exists: destinationExists,
    },
    backup: {
      path: expectsBackup ? resolveContainedExtensionPath(extensionsDir, `${manifestId}.backup`) : null,
      expected: expectsBackup,
      created: false,
      restored: null,
    },
    candidate: {
      path: resolveContainedExtensionPath(extensionsDir, `${manifestId}.candidate`),
    },
  };
}

function assertApplyPathsContained(extensionsDir, paths) {
  assertPathWithinDirectory(extensionsDir, paths.destination.path);
  assertPathWithinDirectory(extensionsDir, paths.candidate.path);

  if (paths.backup.path) {
    assertPathWithinDirectory(extensionsDir, paths.backup.path);
  }
}

function shouldRunLiveSetup(input, stageInspection, deps) {
  return Boolean(stageInspection?.setupContract || typeof deps.configureExtension === 'function');
}

function setupCompletedCleanly(setup) {
  return !setup || setup.status === 'configured';
}

function buildSetupStatusCommand(extensionsDir, manifestId) {
  return `modly ext setup-status --extensions-dir "${extensionsDir}" --manifest-id "${manifestId}"`;
}

function extractSetupObservation(setup, { extensionsDir, manifestId }) {
  if (!setup || typeof setup !== 'object') {
    return null;
  }

  const journal = setup.journal && typeof setup.journal === 'object' ? setup.journal : null;
  const status = setup.status ?? journal?.status ?? null;
  const runId = setup.runId ?? journal?.runId ?? null;
  const logPath = setup.logPath ?? journal?.logPath ?? null;
  const staleReason = setup.staleReason ?? journal?.staleReason ?? null;
  const statusCommand = setup.statusCommand ?? buildSetupStatusCommand(extensionsDir, manifestId);
  const attempt = setup.attempt ?? setup.execution?.attempt ?? journal?.attempt ?? null;
  const maxAttempts = setup.maxAttempts ?? setup.execution?.maxAttempts ?? journal?.maxAttempts ?? null;
  const failureClass = setup.failureClass ?? setup.execution?.failureClass ?? journal?.failureClass ?? null;
  const retryable = setup.retryable ?? setup.execution?.retryable ?? journal?.retryable ?? null;
  const attempts = Array.isArray(setup.attempts)
    ? setup.attempts
    : Array.isArray(setup.execution?.attempts)
      ? setup.execution.attempts
      : Array.isArray(journal?.attempts)
        ? journal.attempts
        : null;

  if (status === null
    && runId === null
    && logPath === null
    && staleReason === null
    && attempt === null
    && maxAttempts === null
    && failureClass === null
    && retryable === null
    && attempts === null) {
    return null;
  }

  return {
    status,
    runId,
    logPath,
    statusCommand,
    staleReason,
    ...(typeof attempt === 'number' ? { attempt } : {}),
    ...(typeof maxAttempts === 'number' ? { maxAttempts } : {}),
    ...(failureClass !== null ? { failureClass } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(attempts ? { attempts } : {}),
  };
}

async function promoteStagedExtension(input = {}, deps = {}, statusMap) {
  const fs = {
    ...defaultFs,
    ...(deps.fs ?? {}),
  };
  const inspectStage = deps.inspectStage ?? inspectStagedExtension;
  const configureExtension = deps.configureExtension ?? configureStagedExtension;
  const reloadExtensions = deps.reloadExtensions;
  const getExtensionErrors = deps.getExtensionErrors;
  const cwd = deps.cwd ?? process.cwd();
  const stagePath = normalizeStagePath(input.stagePath, cwd);
  const resolution = resolveExtensionsDir(input.extensionsDir, stagePath);

  let stageInspection;

  try {
    stageInspection = await inspectStage(stagePath);
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
    id: normalizeExtensionManifestId(stageInspection.manifestSummary.id, {
      message: 'Prepared stage manifest.id is invalid for live-target apply.',
    }),
    name: stageInspection.manifestSummary.name,
    version: stageInspection.manifestSummary.version,
    extensionType: stageInspection.manifestSummary.extensionType,
  };
  const destinationPath = resolveContainedExtensionPath(resolution.extensionsDir, manifest.id);
  const destinationExists = await pathExists(destinationPath);
  const paths = planPaths({
    extensionsDir: resolution.extensionsDir,
    manifestId: manifest.id,
    destinationExists,
    backupMode: statusMap.backupMode,
  });
  assertApplyPathsContained(resolution.extensionsDir, paths);

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

  let setup = null;
  let setupObservation = null;

  let backupCreated = false;
  let backupRestored = paths.backup.expected ? false : null;

  try {
    if (paths.backup.expected) {
      await fs.rm(paths.backup.path, { recursive: true, force: true });
      await fs.rename(paths.destination.path, paths.backup.path);
      backupCreated = true;
    } else if (paths.destination.exists) {
      await fs.rm(paths.destination.path, { recursive: true, force: true });
    }

    await fs.rename(paths.candidate.path, paths.destination.path);

    if (shouldRunLiveSetup(input, stageInspection, deps)) {
      setup = await configureExtension(
        {
          extensionPath: paths.destination.path,
          pythonExe: input.pythonExe,
          allowThirdParty: input.allowThirdParty,
          setupPayload: input.setupPayload,
        },
        {
          cwd,
          inspectStage,
          spawnImpl: deps.spawnImpl,
          isProcessAlive: deps.isProcessAlive,
          now: deps.now,
        },
      );

      if (!setupCompletedCleanly(setup)) {
        setupObservation = extractSetupObservation(setup, {
          extensionsDir: resolution.extensionsDir,
          manifestId: manifest.id,
        });
        warnings.push({
          code: 'SETUP_DEGRADED',
          message: 'Live-target setup did not complete cleanly after promotion.',
          detail: setup,
        });
      }
    }
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
      extraDetails: {
        backup: {
          ...paths.backup,
          created: backupCreated,
          restored: backupRestored,
        },
        ...(extractSetupObservation(error?.details?.setup, {
          extensionsDir: resolution.extensionsDir,
          manifestId: manifest.id,
        }) ? {
          setupObservation: extractSetupObservation(error?.details?.setup, {
            extensionsDir: resolution.extensionsDir,
            manifestId: manifest.id,
          }),
        } : {}),
      },
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
      message: 'Reload dependency was not provided to the staged extension promotion flow.',
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
      const observedErrors = observeExtensionErrors(await getExtensionErrors(), manifest.id);
      errors.observed = observedErrors.observed;
      errors.matched = observedErrors.matched;

      if (observedErrors.diagnostic) {
        errors.diagnostic = observedErrors.diagnostic;
        warnings.push({
          code: 'ERRORS_UNOBSERVABLE',
          message: 'Extension error observation failed after promotion.',
          detail: errors.diagnostic,
        });
      }
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
      message: 'Error observation dependency was not provided to the staged extension promotion flow.',
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
    status: reload.succeeded && errors.observed && errors.matched.length === 0 && setupCompletedCleanly(setup)
      ? statusMap.clean
      : statusMap.degraded,
    [statusMap.flag]: true,
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
    setup,
    ...(setupObservation ? { setupObservation } : {}),
    reload,
    errors,
    warnings,
  };
}

export async function applyStagedExtension(input = {}, deps = {}) {
  return promoteStagedExtension(input, deps, {
    clean: 'applied',
    degraded: 'applied_degraded',
    flag: 'applied',
    backupMode: 'when-destination-exists',
  });
}

export async function repairStagedExtension(input = {}, deps = {}) {
  return promoteStagedExtension(input, deps, {
    clean: 'repaired',
    degraded: 'repaired_degraded',
    flag: 'repaired',
    backupMode: 'never',
  });
}
