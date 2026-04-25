import path from 'node:path';

import { ValidationError } from './errors.mjs';

export const EXTENSION_MANIFEST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function buildInvalidManifestIdReason(manifestId, label) {
  if (typeof manifestId !== 'string') {
    return `${label} must be a string.`;
  }

  if (manifestId.length === 0) {
    return `${label} must not be empty.`;
  }

  if (manifestId.trim() !== manifestId || /\s/u.test(manifestId)) {
    return `${label} must not contain whitespace.`;
  }

  if (manifestId === '.' || manifestId === '..') {
    return `${label} must not equal "." or "..".`;
  }

  if (manifestId.includes('/') || manifestId.includes('\\')) {
    return `${label} must not contain "/" or "\\" path separators.`;
  }

  if (path.posix.isAbsolute(manifestId) || path.win32.isAbsolute(manifestId)) {
    return `${label} must not be an absolute path.`;
  }

  if (/^[A-Za-z]:/u.test(manifestId)) {
    return `${label} must not contain a Windows drive prefix.`;
  }

  if (!EXTENSION_MANIFEST_ID_PATTERN.test(manifestId)) {
    return `${label} must match ^[a-z0-9][a-z0-9._-]{0,127}$.`;
  }

  return null;
}

export function describeInvalidManifestId(manifestId, options = {}) {
  const label = options.label ?? 'manifest.id';
  return buildInvalidManifestIdReason(manifestId, label);
}

export function normalizeExtensionManifestId(manifestId, options = {}) {
  const label = options.label ?? 'manifest.id';
  const code = options.code ?? 'MANIFEST_ID_INVALID';
  const reason = buildInvalidManifestIdReason(manifestId, label);

  if (reason) {
    throw new ValidationError(
      options.message ?? `${label} is invalid.`,
      {
        code,
        details: {
          manifestId: {
            label,
            value: manifestId ?? null,
            reason,
          },
        },
      },
    );
  }

  return manifestId;
}

export function assertPathWithinDirectory(basePath, targetPath, options = {}) {
  const resolvedBasePath = path.resolve(basePath);
  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(resolvedBasePath, resolvedTargetPath);
  const isContained = relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));

  if (isContained) {
    return resolvedTargetPath;
  }

  throw new ValidationError(
    options.message ?? 'Resolved extension path escapes the extensions directory.',
    {
      code: options.code ?? 'EXTENSION_PATH_OUTSIDE_ROOT',
      details: {
        extensionPath: {
          basePath: resolvedBasePath,
          targetPath: resolvedTargetPath,
          relativePath,
        },
      },
    },
  );
}

export function resolveContainedExtensionPath(basePath, childName, options = {}) {
  const targetPath = path.resolve(basePath, childName);
  return assertPathWithinDirectory(basePath, targetPath, options);
}
