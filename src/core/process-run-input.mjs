import path from 'node:path';
import { ValidationError } from './errors.mjs';
import { getCanonicalProcessIds } from './modly-normalizers.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalRelativePath(inputPath, field) {
  if (inputPath === undefined) {
    return undefined;
  }

  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string.`, {
      details: { field, reason: 'invalid_path' },
    });
  }

  const candidate = inputPath.trim();

  if (path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate)) {
    throw new ValidationError(`${field} must be workspace-relative.`, {
      details: { field, reason: 'absolute_path', value: candidate },
    });
  }

  const segments = candidate.split(/[\\/]+/).filter(Boolean);

  if (segments.length === 0 || segments.includes('..')) {
    throw new ValidationError(`${field} must be workspace-relative and must not contain traversal.`, {
      details: { field, reason: 'path_traversal', value: candidate },
    });
  }

  return segments.filter((segment) => segment !== '.').join('/');
}

function validateProcessId(processId, capabilities) {
  if (typeof processId !== 'string' || processId.trim() === '') {
    throw new ValidationError('process_id must be a non-empty string.', {
      details: { field: 'process_id', reason: 'required' },
    });
  }

  const normalizedProcessId = processId.trim();
  const canonicalProcessIds = getCanonicalProcessIds(capabilities);

  if (Array.isArray(capabilities?.processes) && !canonicalProcessIds.has(normalizedProcessId)) {
    throw new ValidationError(`Unknown canonical process_id: ${normalizedProcessId}.`, {
      details: {
        field: 'process_id',
        reason: 'non_canonical_process_id',
        process_id: normalizedProcessId,
      },
    });
  }

  return normalizedProcessId;
}

export function prepareProcessRunCreateInput(input, { capabilities } = {}) {
  if (!isObject(input)) {
    throw new ValidationError('process-run create input must be a JSON object.', {
      details: { reason: 'invalid_input_shape' },
    });
  }

  const processId = validateProcessId(input.process_id, capabilities);

  if (!isObject(input.params)) {
    throw new ValidationError('params must be a JSON object.', {
      details: { field: 'params', reason: 'invalid_params' },
    });
  }

  const workspacePath = normalizeOptionalRelativePath(input.workspace_path, 'workspace_path');
  const params = { ...input.params };
  const explicitOutputPath = normalizeOptionalRelativePath(params.output_path, 'params.output_path');
  const outputPath = normalizeOptionalRelativePath(input.outputPath, 'outputPath');

  if (outputPath !== undefined && explicitOutputPath !== undefined && outputPath !== explicitOutputPath) {
    throw new ValidationError('outputPath conflicts with params.output_path.', {
      details: {
        field: 'outputPath',
        reason: 'conflicting_output_path',
        outputPath,
        params_output_path: explicitOutputPath,
      },
    });
  }

  if (explicitOutputPath !== undefined) {
    params.output_path = explicitOutputPath;
  } else if (outputPath !== undefined) {
    params.output_path = outputPath;
  }

  const payload = {
    ...input,
    process_id: processId,
    params,
  };

  if (workspacePath !== undefined) {
    payload.workspace_path = workspacePath;
  }

  delete payload.outputPath;

  return payload;
}
