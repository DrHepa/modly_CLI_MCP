import { access } from 'node:fs/promises';
import path from 'node:path';
import { UsageError, ValidationError } from '../../core/errors.mjs';

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseCommandArgs(args, { usage, valueFlags = [], booleanFlags = [], repeatableValueFlags = [] }) {
  const options = {};
  const positionals = [];
  const valueFlagSet = new Set(valueFlags);
  const booleanFlagSet = new Set(booleanFlags);
  const repeatableValueFlagSet = new Set(repeatableValueFlags);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    if (valueFlagSet.has(token)) {
      const value = args[index + 1];

      if (!value || value.startsWith('--')) {
        throw new UsageError(`Expected a value after ${token}.\n${usage}`);
      }

      options[token] = value;
      index += 1;
      continue;
    }

    if (repeatableValueFlagSet.has(token)) {
      const value = args[index + 1];

      if (!value || value.startsWith('--')) {
        throw new UsageError(`Expected a value after ${token}.\n${usage}`);
      }

      options[token] ??= [];
      options[token].push(value);
      index += 1;
      continue;
    }

    if (booleanFlagSet.has(token)) {
      options[token] = true;
      continue;
    }

    throw new UsageError(`Unknown option: ${token}.\n${usage}`);
  }

  return { positionals, options };
}

export function assertExactPositionals(positionals, expectedCount, usage) {
  if (positionals.length !== expectedCount) {
    throw new UsageError(usage);
  }
}

export function parseInteger(value, label, { min, max } = {}) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new ValidationError(`${label} must be an integer.`);
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(`${label} must be a safe integer.`);
  }

  if (min !== undefined && parsed < min) {
    throw new ValidationError(`${label} must be >= ${min}.`);
  }

  if (max !== undefined && parsed > max) {
    throw new ValidationError(`${label} must be <= ${max}.`);
  }

  return parsed;
}

export function assertNonEmptyString(value, label, { usage } = {}) {
  if (typeof value !== 'string') {
    if (usage) {
      throw new UsageError(usage);
    }

    throw new ValidationError(`${label} is required.`);
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }

  return trimmed;
}

export function parseJsonObject(value, label = '--params-json') {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);

    if (!isJsonObject(parsed)) {
      throw new ValidationError(`${label} must parse to a JSON object.`);
    }

    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ValidationError(`${label} must be valid JSON.`);
  }
}

export async function assertFileExists(filePath, label) {
  try {
    await access(filePath);
  } catch {
    throw new ValidationError(`${label} must point to an existing file.`);
  }
}

export function assertWorkspaceRelativePath(inputPath, label = '--path') {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ValidationError(`${label} is required.`);
  }

  if (path.isAbsolute(inputPath) || /^[a-zA-Z]:[\\/]/.test(inputPath)) {
    throw new ValidationError(`${label} must be workspace-relative.`);
  }

  const segments = inputPath.split(/[\\/]+/).filter(Boolean);

  if (segments.length === 0 || segments.includes('..')) {
    throw new ValidationError(`${label} must be workspace-relative and must not contain traversal.`);
  }

  return segments.filter((segment) => segment !== '.').join('/');
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
