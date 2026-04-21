import { ValidationError } from '../../../core/errors.mjs';

const MAX_INPUT_PROPERTIES = 8;

export const OPEN_INPUT_PATH_ALLOWLIST = Object.freeze([
  'input.params',
  'input.input',
  'input.error.details',
  'input.planner.target',
  'input.run.error',
  'input.runtimeEvidence.response',
  'input.runtimeEvidence.body',
  'input.runtimeEvidence.cause',
  'input.liveContext.health',
  'input.liveContext.capabilities',
  'input.liveContext.runtimePaths',
  'input.liveContext.extensionErrors[*]',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toValidationError(message, details) {
  return new ValidationError(message, { details });
}

function createValidationDetails({ toolName, path, ...details }) {
  return {
    tool: toolName,
    ...(path ? { path } : {}),
    ...details,
  };
}

function tokenizeInputPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    return [];
  }

  return path.match(/[^.[\]]+|\[(?:\*|\d+)\]/g) ?? [];
}

function pathSegmentMatches(patternSegment, pathSegment) {
  if (patternSegment === '[*]') {
    return /^\[\d+\]$/.test(pathSegment) || pathSegment === '[*]';
  }

  return patternSegment === pathSegment;
}

export function matchesOpenInputPath(path, allowlist = OPEN_INPUT_PATH_ALLOWLIST) {
  const pathSegments = tokenizeInputPath(path);

  if (pathSegments.length === 0) {
    return false;
  }

  return allowlist.some((candidate) => {
    const candidateSegments = tokenizeInputPath(candidate);

    if (candidateSegments.length !== pathSegments.length) {
      return false;
    }

    for (let index = 0; index < candidateSegments.length; index += 1) {
      if (!pathSegmentMatches(candidateSegments[index], pathSegments[index])) {
        return false;
      }
    }

    return true;
  });
}

function appendObjectPath(path, key) {
  return `${path}.${key}`;
}

function appendArrayPath(path, index) {
  return `${path}[${index}]`;
}

function hasObjectValidationKeywords(schema) {
  return (
    isPlainObject(schema) &&
    (isPlainObject(schema.properties) || Array.isArray(schema.required) || schema.additionalProperties === false)
  );
}

function applyNumericBounds({ schema, value, path, toolName }) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw toValidationError(
      `${path} must be >= ${schema.minimum}.`,
      createValidationDetails({ path, toolName, minimum: schema.minimum, received: value }),
    );
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    throw toValidationError(
      `${path} must be <= ${schema.maximum}.`,
      createValidationDetails({ path, toolName, maximum: schema.maximum, received: value }),
    );
  }
}

function applyEnumConstraint({ schema, value, path, toolName }) {
  if (!Array.isArray(schema.enum) || schema.enum.includes(value)) {
    return;
  }

  throw toValidationError(
    `${path} must be one of: ${schema.enum.join(', ')}.`,
    createValidationDetails({ path, toolName, reason: 'enum_no_match', expected: schema.enum, received: value }),
  );
}

function trySanitizeBySchema(args) {
  try {
    return { ok: true, value: sanitizeBySchema(args) };
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        ok: false,
        message: error.message,
        details: isPlainObject(error.details) ? error.details : {},
      };
    }

    throw error;
  }
}

function sanitizeAnyOf({ schema, value, path, toolName }) {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
    return value;
  }

  const failures = [];

  for (const branch of schema.anyOf) {
    const attempt = trySanitizeBySchema({ schema: branch, value, path, toolName });

    if (attempt.ok) {
      return attempt.value;
    }

    failures.push({
      message: attempt.message,
      details: attempt.details,
    });
  }

  throw toValidationError(
    `${path} must satisfy at least one schema branch.`,
    createValidationDetails({
      path,
      toolName,
      reason: 'anyOf_no_match',
      branchesTried: schema.anyOf.length,
      firstFailure: failures[0]
        ? {
            message: failures[0].message,
            details: failures[0].details,
          }
        : undefined,
    }),
  );
}

function sanitizeValue({ schema, value, path, toolName }) {
  if (schema?.type === 'string') {
    if (typeof value !== 'string') {
      throw toValidationError(
        `${path} must be a string.`,
        createValidationDetails({ path, toolName, expected: 'string' }),
      );
    }

    const trimmed = value.trim();

    if (trimmed === '') {
      if (path === 'input.outputPath') {
        return '';
      }

      throw toValidationError(
        `${path} must be a non-empty string.`,
        createValidationDetails({ path, toolName, reason: 'empty_string' }),
      );
    }

    if (schema.minLength !== undefined && trimmed.length < schema.minLength) {
      throw toValidationError(
        `${path} must have length >= ${schema.minLength}.`,
        createValidationDetails({ path, toolName, minLength: schema.minLength, received: trimmed.length }),
      );
    }

    if (schema.maxLength !== undefined && trimmed.length > schema.maxLength) {
      throw toValidationError(
        `${path} must have length <= ${schema.maxLength}.`,
        createValidationDetails({ path, toolName, maxLength: schema.maxLength, received: trimmed.length }),
      );
    }

    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, 'u').test(trimmed))) {
      throw toValidationError(
        `${path} must match pattern: ${schema.pattern}.`,
        createValidationDetails({ path, toolName, reason: 'pattern_no_match', pattern: schema.pattern, received: trimmed }),
      );
    }

    applyEnumConstraint({ schema, value: trimmed, path, toolName });

    return trimmed;
  }

  if (schema?.type === 'integer') {
    if (!Number.isInteger(value)) {
      throw toValidationError(
        `${path} must be an integer.`,
        createValidationDetails({ path, toolName, expected: 'integer' }),
      );
    }

    applyNumericBounds({ schema, value, path, toolName });

    return value;
  }

  if (schema?.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw toValidationError(
        `${path} must be a number.`,
        createValidationDetails({ path, toolName, expected: 'number' }),
      );
    }

    applyNumericBounds({ schema, value, path, toolName });

    return value;
  }

  if (schema?.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw toValidationError(
        `${path} must be a boolean.`,
        createValidationDetails({ path, toolName, expected: 'boolean' }),
      );
    }

    return value;
  }

  if (schema?.type === 'object') {
    if (!isPlainObject(value)) {
      throw toValidationError(
        `${path} must be a JSON object.`,
        createValidationDetails({ path, toolName, expected: 'object' }),
      );
    }

    return value;
  }

  if (schema?.type === 'array') {
    if (!Array.isArray(value)) {
      throw toValidationError(
        `${path} must be an array.`,
        createValidationDetails({ path, toolName, expected: 'array' }),
      );
    }

    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw toValidationError(
        `${path} must contain at least ${schema.minItems} items.`,
        createValidationDetails({ path, toolName, minItems: schema.minItems, received: value.length }),
      );
    }

    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw toValidationError(
        `${path} must contain at most ${schema.maxItems} items.`,
        createValidationDetails({ path, toolName, maxItems: schema.maxItems, received: value.length }),
      );
    }

    return value;
  }

  return value;
}

function sanitizeObject({ schema, value, path, toolName }) {
  if (!isPlainObject(value)) {
    throw toValidationError(
      `${path} must be a JSON object.`,
      createValidationDetails({ path, toolName, expected: 'object' }),
    );
  }

  if (matchesOpenInputPath(path)) {
    return value;
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  const keys = Object.keys(value);
  const allowedKeys = new Set(Object.keys(properties));

  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw toValidationError(
        `${path} requires ${key}.`,
        createValidationDetails({ path, toolName, missing: key }),
      );
    }
  }

  if (path === 'input' && keys.length > MAX_INPUT_PROPERTIES) {
    throw toValidationError(
      `${toolName} accepts at most ${MAX_INPUT_PROPERTIES} input properties.`,
      createValidationDetails({ path, toolName, limit: MAX_INPUT_PROPERTIES, received: keys.length }),
    );
  }

  if (schema.additionalProperties === false) {
    const unknownKeys = keys.filter((key) => !allowedKeys.has(key));

    if (unknownKeys.length > 0) {
      throw toValidationError(
        `${path} does not accept unknown properties.`,
        createValidationDetails({ path, toolName, unknownKeys }),
      );
    }
  }

  const sanitized = {};

  for (const key of keys) {
    sanitized[key] = sanitizeBySchema({
      schema: properties[key],
      value: value[key],
      path: appendObjectPath(path, key),
      toolName,
    });
  }

  return sanitized;
}

function sanitizeArray({ schema, value, path, toolName }) {
  if (!Array.isArray(value)) {
    throw toValidationError(
      `${path} must be an array.`,
      createValidationDetails({ path, toolName, expected: 'array' }),
    );
  }

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw toValidationError(
      `${path} must contain at least ${schema.minItems} items.`,
      createValidationDetails({ path, toolName, minItems: schema.minItems, received: value.length }),
    );
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw toValidationError(
      `${path} must contain at most ${schema.maxItems} items.`,
      createValidationDetails({ path, toolName, maxItems: schema.maxItems, received: value.length }),
    );
  }

  return value.map((item, index) =>
    sanitizeBySchema({
      schema: schema.items,
      value: item,
      path: appendArrayPath(path, index),
      toolName,
    }),
  );
}

function sanitizeBySchema({ schema, value, path, toolName }) {
  if (!schema) {
    return value;
  }

  let sanitized = value;

  if (schema.type === 'array') {
    sanitized = sanitizeArray({ schema, value, path, toolName });
  } else if (schema.type === 'object' || hasObjectValidationKeywords(schema)) {
    sanitized = sanitizeObject({ schema, value, path, toolName });
  } else {
    sanitized = sanitizeValue({ schema, value, path, toolName });
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return sanitizeAnyOf({ schema, value: sanitized, path, toolName });
  }

  if (schema.type !== 'string') {
    applyEnumConstraint({ schema, value: sanitized, path, toolName });
  }

  return sanitized;
}

export function sanitizeArguments(tool, input) {
  const schema = tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false };

  if (!isPlainObject(input)) {
    throw toValidationError(`${tool.name} expects a JSON object input.`, {
      tool: tool.name,
      reason: 'non_object_input',
    });
  }

  return sanitizeBySchema({ schema, value: input, path: 'input', toolName: tool.name });
}
