import { BackendUnavailableError, ModlyError, NotFoundError, TimeoutError } from './errors.mjs';

function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }

        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function readErrorBody(response) {
  const contentType = response.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      return await response.json();
    }

    return await response.text();
  } catch {
    return undefined;
  }
}

function toHttpError({ response, path, body }) {
  const statusText = response.statusText || (response.status === 404 ? 'Not Found' : 'Error');
  const message = `${response.status} ${statusText} for ${path}`;

  if (response.status === 404) {
    return new NotFoundError(message, { details: body });
  }

  return new ModlyError(message, {
    code: `HTTP_${response.status}`,
    details: body,
  });
}

function toInvalidContentTypeError({ method, path, contentType }) {
  return new ModlyError(`Expected JSON response for ${method} ${path}.`, {
    code: 'INVALID_CONTENT_TYPE',
    details: { contentType },
  });
}

function toInvalidJsonError({ method, path, rawBody, cause }) {
  return new ModlyError(`Failed to parse JSON response for ${method} ${path}.`, {
    code: 'INVALID_JSON_RESPONSE',
    details: {
      rawBody,
      cause: cause?.message,
    },
    cause,
  });
}

function serializeCause(cause) {
  if (!cause || typeof cause !== 'object') {
    return undefined;
  }

  const serialized = {};

  if (typeof cause.name === 'string' && cause.name) {
    serialized.name = cause.name;
  }

  if (typeof cause.message === 'string' && cause.message) {
    serialized.message = cause.message;
  }

  if (typeof cause.code === 'string' && cause.code) {
    serialized.code = cause.code;
  }

  return Object.keys(serialized).length > 0 ? serialized : undefined;
}

function pickRelevantHeaders(headers) {
  const relevantHeaders = {};

  for (const name of ['content-type', 'content-length', 'location']) {
    const value = headers.get(name);

    if (value) {
      relevantHeaders[name] = value;
    }
  }

  return relevantHeaders;
}

function toRuntimeEvidence({ requestedUrl, response, rawBody, body, cause }) {
  const evidence = { requestedUrl };

  if (response) {
    evidence.response = {
      url: response.url || requestedUrl,
      redirected: Boolean(response.redirected),
      status: response.status,
      statusText: response.statusText,
      headers: pickRelevantHeaders(response.headers),
    };
  }

  if (body !== undefined) {
    evidence.body = body;
  }

  if (rawBody !== undefined) {
    evidence.rawBody = rawBody;
  }

  const serializedCause = serializeCause(cause);

  if (serializedCause) {
    evidence.cause = serializedCause;
  }

  return evidence;
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function parseRuntimeBody({ contentType, rawBody }) {
  if (rawBody === undefined) {
    return undefined;
  }

  if (!contentType.includes('application/json')) {
    return rawBody;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function toResponseMetadata({ response, url }) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: String(url),
    contentType: response.headers.get('content-type') ?? '',
    responseReceived: true,
  };
}

async function execute({
  baseUrl,
  path,
  method = 'GET',
  query,
  headers = {},
  body,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const url = buildUrl(baseUrl, path, query);

  if (typeof fetchImpl !== 'function') {
    throw new BackendUnavailableError('Global fetch is not available in this Node runtime.');
  }

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal,
    });

    return { response, url, method, path };
  } catch (error) {
    if (error instanceof ModlyError) {
      throw error;
    }

    if (error?.name === 'AbortError') {
      throw new TimeoutError(`Request to ${path} timed out.`, { cause: error });
    }

    throw new BackendUnavailableError(`${method} ${path} failed`, { cause: error });
  }
}

export async function request({
  baseUrl,
  path,
  method = 'GET',
  query,
  headers = {},
  body,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const { response } = await execute({
    baseUrl,
    path,
    method,
    query,
    headers,
    body,
    signal,
    fetchImpl,
  });

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    throw toHttpError({ response, path, body: errorBody });
  }

  return response;
}

export async function requestJson(options) {
  const response = await request({
    ...options,
    headers: {
      accept: 'application/json',
      ...options.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    throw toInvalidContentTypeError({
      method: options.method ?? 'GET',
      path: options.path,
      contentType,
    });
  }

  return response.json();
}

export async function requestJsonRuntime(options) {
  const method = options.method ?? 'GET';
  const requestedUrl = String(buildUrl(options.baseUrl, options.path, options.query));

  let execution;

  try {
    execution = await execute({
      ...options,
      headers: {
        accept: 'application/json',
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof TimeoutError) {
      throw new BackendUnavailableError(`${method} ${options.path} failed`, {
        cause: error,
        details: {
          responseReceived: false,
          reason: error.code,
          runtimeEvidence: toRuntimeEvidence({
            requestedUrl,
            cause: error.cause ?? error,
          }),
        },
      });
    }

    if (error instanceof BackendUnavailableError) {
      throw new BackendUnavailableError(error.message, {
        cause: error.cause,
        details: {
          ...(error.details ?? {}),
          runtimeEvidence: toRuntimeEvidence({
            requestedUrl,
            cause: error.cause ?? error,
          }),
        },
      });
    }

    throw error;
  }

  const { response, url, path } = execution;
  const metadata = toResponseMetadata({ response, url });
  const rawBody = await readResponseText(response);
  const runtimeBody = parseRuntimeBody({ contentType: metadata.contentType, rawBody });
  const runtimeEvidence = toRuntimeEvidence({
    requestedUrl,
    response,
    rawBody,
    body: runtimeBody,
  });

  if (response.status >= 500) {
    throw new BackendUnavailableError(`${method} ${path} failed`, {
      details: {
        ...metadata,
        body: runtimeBody,
        rawBody,
        runtimeEvidence,
      },
    });
  }

  if (!metadata.contentType.includes('application/json')) {
    return {
      ...metadata,
      payload: undefined,
      rawBody,
      runtimeEvidence,
      parseError: toInvalidContentTypeError({ method, path, contentType: metadata.contentType }),
    };
  }

  try {
    return {
      ...metadata,
      payload: JSON.parse(rawBody),
      rawBody,
      runtimeEvidence,
    };
  } catch (error) {
    return {
      ...metadata,
      payload: undefined,
      rawBody,
      runtimeEvidence,
      parseError: toInvalidJsonError({ method, path, rawBody, cause: error }),
    };
  }
}

export async function requestBinary(options) {
  const response = await request(options);

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type'),
  };
}

export async function requestStream(options) {
  return request(options);
}
