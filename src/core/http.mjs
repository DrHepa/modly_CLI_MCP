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

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw toHttpError({ response, path, body: errorBody });
    }

    return response;
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
    throw new ModlyError(`Expected JSON response for ${options.method ?? 'GET'} ${options.path}.`, {
      code: 'INVALID_CONTENT_TYPE',
      details: { contentType },
    });
  }

  return response.json();
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
