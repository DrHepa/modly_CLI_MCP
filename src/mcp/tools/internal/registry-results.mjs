import {
  BackendUnavailableError,
  ModlyError,
  UnsupportedOperationError,
  ValidationError,
  normalizeError,
} from '../../../core/errors.mjs';

const MAX_TEXT_LENGTH = 180;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimTextSummary(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().replace(/\s+/g, ' ');

  if (normalized === '') {
    return fallback;
  }

  return normalized.length > MAX_TEXT_LENGTH ? `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…` : normalized;
}

function toSafeDetails(error) {
  if ((error instanceof ValidationError || error instanceof ModlyError) && isPlainObject(error.details)) {
    return error.details;
  }

  return {};
}

function toErrorCode(error) {
  if (error instanceof UnsupportedOperationError) {
    return 'UNSUPPORTED_OPERATION';
  }

  if (typeof error?.details?.error?.code === 'string' && error.details.error.code.trim() !== '') {
    return error.details.error.code.trim();
  }

  return error.code ?? 'MODLY_ERROR';
}

export function createSuccessResult({ toolName, data, text }) {
  return {
    structuredContent: {
      ok: true,
      data,
    },
    content: [
      {
        type: 'text',
        text: trimTextSummary(text, `${toolName} ok.`),
      },
    ],
  };
}

export function createErrorResult({ toolName, error }) {
  const normalized = normalizeError(error);
  const message =
    normalized instanceof BackendUnavailableError ? 'Modly backend is unavailable.' : normalized.message;

  return {
    isError: true,
    structuredContent: {
      ok: false,
      error: {
        code: toErrorCode(normalized),
        message,
        details: toSafeDetails(normalized),
      },
      meta: { tool: toolName },
    },
    content: [
      {
        type: 'text',
        text: trimTextSummary(message, `${toolName} failed.`),
      },
    ],
  };
}
