import { TimeoutError, ValidationError } from './errors.mjs';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 600000;

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive safe integer.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function pollUntilTerminal({
  load,
  isTerminal,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress,
}) {
  if (typeof load !== 'function') {
    throw new ValidationError('load must be a function.');
  }

  if (typeof isTerminal !== 'function') {
    throw new ValidationError('isTerminal must be a function.');
  }

  assertPositiveInteger(intervalMs, 'intervalMs');
  assertPositiveInteger(timeoutMs, 'timeoutMs');

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastObservedRun;

  while (true) {
    const payload = await load();
    attempts += 1;
    lastObservedRun = payload;
    const elapsedMs = Date.now() - startedAt;

    const polling = {
      intervalMs,
      timeoutMs,
      elapsedMs,
      attempts,
    };

    if (typeof onProgress === 'function') {
      onProgress(payload);
    }

    if (isTerminal(payload)) {
      return { payload, polling };
    }

    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      throw new TimeoutError('Polling timed out before reaching a terminal state.', {
        details: {
          ...polling,
          startedAt,
          lastObservedRun,
        },
      });
    }

    await sleep(Math.min(intervalMs, remainingMs));
  }
}
