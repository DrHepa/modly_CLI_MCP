import { EXIT_CODES } from './contracts.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ModlyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code ?? 'MODLY_ERROR';
    this.exitCode = options.exitCode ?? EXIT_CODES.FAILURE;
    this.cause = options.cause;
    this.details = options.details;
  }
}

export class UsageError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'INVALID_USAGE', exitCode: EXIT_CODES.USAGE });
  }
}

export class ValidationError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'VALIDATION_ERROR', exitCode: EXIT_CODES.VALIDATION });
  }
}

export class BackendUnavailableError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'BACKEND_UNAVAILABLE', exitCode: EXIT_CODES.BACKEND_UNAVAILABLE });
  }
}

export class NotFoundError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'NOT_FOUND', exitCode: EXIT_CODES.NOT_FOUND });
  }
}

export class UnsupportedOperationError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'UNSUPPORTED_HEADLESS_OPERATION', exitCode: EXIT_CODES.UNSUPPORTED });
  }
}

export class TimeoutError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'TIMEOUT', exitCode: EXIT_CODES.TIMEOUT });
  }
}

export class NotImplementedYetError extends ModlyError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'NOT_IMPLEMENTED_YET', exitCode: EXIT_CODES.UNSUPPORTED });
  }
}

export function normalizeError(error, fallbackMessage = 'Unexpected Modly CLI error') {
  if (error instanceof ModlyError) {
    return error;
  }

  return new ModlyError(error?.message ?? fallbackMessage, {
    cause: error,
    details: error,
  });
}

export function extractErrorEnvelope(error, fallbackMessage = 'Unexpected Modly CLI error') {
  const normalized = normalizeError(error, fallbackMessage);
  const nestedError = isObject(normalized.details?.error) ? normalized.details.error : null;

  return {
    normalized,
    code:
      typeof nestedError?.code === 'string' && nestedError.code.trim() !== ''
        ? nestedError.code.trim()
        : (normalized.code ?? 'MODLY_ERROR'),
    message: normalized.message,
    details: normalized instanceof ModlyError && isObject(normalized.details) ? normalized.details : {},
  };
}
