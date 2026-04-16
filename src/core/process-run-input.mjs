import path from 'node:path';
import { ValidationError } from './errors.mjs';
import { getCanonicalProcessIds } from './modly-normalizers.mjs';

const EXPORTER_PROCESS_ID = 'mesh-exporter/export';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeWorkspaceRelativePath(inputPath, field, { omitIfEmpty = false } = {}) {
  if (inputPath === undefined) {
    return undefined;
  }

  if (typeof inputPath !== 'string') {
    throw new ValidationError(`${field} must be a non-empty string.`, {
      details: { field, reason: 'invalid_path' },
    });
  }

  if (inputPath.trim() === '') {
    if (omitIfEmpty) {
      return undefined;
    }

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

function hasOwn(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function validateCapabilityProcessBaseInput(input) {
  if (!isObject(input)) {
    throw new ValidationError('input must be a JSON object.', {
      details: { field: 'input', reason: 'invalid_input_shape' },
    });
  }

  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';

  if (kind !== '' && kind !== 'mesh' && kind !== 'workspace') {
    throw new ValidationError('input.kind must be "mesh" or "workspace" for process execution.', {
      details: { field: 'input.kind', reason: 'invalid_process_input_kind', value: input.kind ?? null },
    });
  }

  if (input.meshPath === undefined) {
    throw new ValidationError('input.meshPath is required for process execution.', {
      details: { field: 'input.meshPath', reason: 'required' },
    });
  }

  const meshPath = normalizeWorkspaceRelativePath(input.meshPath, 'input.meshPath');
  const workspacePath = normalizeWorkspaceRelativePath(input.workspacePath, 'input.workspacePath', { omitIfEmpty: true })
    ?? meshPath;

  return { kind, meshPath, workspacePath };
}

function rejectExplicitExporterOutputPath(field) {
  throw new ValidationError(`${field} is unsupported for mesh-exporter/export in this MVP.`, {
    details: {
      field,
      reason: 'unsupported_output_path_mvp',
      capability: EXPORTER_PROCESS_ID,
    },
  });
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

  const workspacePath = normalizeWorkspaceRelativePath(input.workspace_path, 'workspace_path');
  const params = { ...input.params };
  const explicitOutputPath = normalizeWorkspaceRelativePath(params.output_path, 'params.output_path', {
    omitIfEmpty: true,
  });
  const outputPath = normalizeWorkspaceRelativePath(input.outputPath, 'outputPath', { omitIfEmpty: true });

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
  } else {
    delete params.output_path;
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

export function prepareCapabilityProcessInput(input, { processId, params } = {}) {
  const { kind, meshPath, workspacePath } = validateCapabilityProcessBaseInput(input);

  if (processId === EXPORTER_PROCESS_ID) {
    if (hasOwn(input, 'outputPath')) {
      rejectExplicitExporterOutputPath('input.outputPath');
    }

    if (params !== undefined && !isObject(params)) {
      throw new ValidationError('params must be a JSON object.', {
        details: { field: 'params', reason: 'invalid_params' },
      });
    }

    if (hasOwn(params, 'output_path')) {
      rejectExplicitExporterOutputPath('params.output_path');
    }

    const preparedInput = {
      meshPath,
      workspacePath,
      params: {},
    };

    if (kind !== '') {
      preparedInput.kind = kind;
    }

    if (hasOwn(params, 'output_format') && params.output_format !== undefined) {
      preparedInput.params.output_format = params.output_format;
    }

    return preparedInput;
  }

  const outputPath = normalizeWorkspaceRelativePath(input.outputPath, 'input.outputPath', { omitIfEmpty: true });
  const preparedInput = {
    meshPath,
    workspacePath,
    outputPath,
  };

  if (kind !== '') {
    preparedInput.kind = kind;
  }

  return preparedInput;
}
