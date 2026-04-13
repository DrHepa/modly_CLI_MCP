import {
  BackendUnavailableError,
  ModlyError,
  UnsupportedOperationError,
  ValidationError,
  normalizeError,
} from '../../core/errors.mjs';
import { createModlyApiClient } from '../../core/modly-api.mjs';
import { MCP_TOOL_CATALOG } from './catalog.mjs';
import { createToolHandlers } from './handlers.mjs';

const MAX_INPUT_PROPERTIES = 8;
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

function toValidationError(message, details) {
  return new ValidationError(message, { details });
}

function sanitizeValue({ schema, value, path }) {
  if (schema?.type === 'string') {
    if (typeof value !== 'string') {
      throw toValidationError(`${path} must be a string.`, { path, expected: 'string' });
    }

    const trimmed = value.trim();

    if (trimmed === '') {
      throw toValidationError(`${path} must be a non-empty string.`, { path, reason: 'empty_string' });
    }

    return trimmed;
  }

  if (schema?.type === 'object') {
    if (!isPlainObject(value)) {
      throw toValidationError(`${path} must be a JSON object.`, {
        path,
        expected: 'object',
      });
    }

    return value;
  }

  return value;
}

function sanitizeArguments(tool, input) {
  const schema = tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false };

  if (!isPlainObject(input)) {
    throw toValidationError(`${tool.name} expects a JSON object input.`, {
      tool: tool.name,
      reason: 'non_object_input',
    });
  }

  const keys = Object.keys(input);

  if (keys.length > MAX_INPUT_PROPERTIES) {
    throw toValidationError(`${tool.name} accepts at most ${MAX_INPUT_PROPERTIES} input properties.`, {
      tool: tool.name,
      limit: MAX_INPUT_PROPERTIES,
      received: keys.length,
    });
  }

  const properties = schema.properties ?? {};
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  const allowedKeys = new Set(Object.keys(properties));

  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      throw toValidationError(`${tool.name} requires ${key}.`, {
        tool: tool.name,
        missing: key,
      });
    }
  }

  if (schema.additionalProperties === false) {
    const unknownKeys = keys.filter((key) => !allowedKeys.has(key));

    if (unknownKeys.length > 0) {
      throw toValidationError(`${tool.name} does not accept unknown properties.`, {
        tool: tool.name,
        unknownKeys,
      });
    }
  }

  const sanitized = {};

  for (const key of keys) {
    sanitized[key] = sanitizeValue({
      schema: properties[key],
      value: input[key],
      path: `input.${key}`,
    });
  }

  return sanitized;
}

async function assertBackendReady({ client, toolName }) {
  try {
    await client.health();
  } catch (error) {
    throw new BackendUnavailableError('Modly backend is unavailable.', {
      cause: error,
      details: { tool: toolName, check: '/health' },
    });
  }
}

function createSuccessResult({ toolName, data, text }) {
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

  return error.code ?? 'MODLY_ERROR';
}

function createErrorResult({ toolName, error }) {
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

export function createToolRegistry({ apiUrl }) {
  const client = createModlyApiClient({ apiUrl });
  const handlers = createToolHandlers({ client, apiUrl });
  const catalogByName = new Map(MCP_TOOL_CATALOG.map((tool) => [tool.name, tool]));

  return {
    catalog: MCP_TOOL_CATALOG,
    client,
    async invoke(name, args = {}) {
      const tool = catalogByName.get(name);

      if (!tool) {
        return createErrorResult({
          toolName: name,
          error: new UnsupportedOperationError(`Unknown MCP tool: ${name}`, { code: 'UNSUPPORTED_OPERATION' }),
        });
      }

      try {
        const input = sanitizeArguments(tool, args);
        const handler = handlers[name];

        if (!handler) {
          throw new UnsupportedOperationError(`${name} is not available in this MVP batch.`, {
            code: 'UNSUPPORTED_OPERATION',
          });
        }

        if (name !== 'modly.health') {
          await assertBackendReady({ client, toolName: name });
        }

        const result = await handler(input);

        if (!isPlainObject(result) || !Object.hasOwn(result, 'data')) {
          throw new ModlyError(`Handler for ${name} returned an invalid result.`, {
            code: 'INVALID_HANDLER_RESULT',
          });
        }

        return createSuccessResult({
          toolName: name,
          data: result.data,
          text: result.text,
        });
      } catch (error) {
        return createErrorResult({ toolName: name, error });
      }
    },
  };
}
