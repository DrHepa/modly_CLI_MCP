import { ValidationError } from './errors.mjs';
import { toProcessRun } from './modly-normalizers.mjs';
import { pollUntilTerminal } from './polling.mjs';

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

function getRunStatus(run) {
  return typeof run?.status === 'string' ? run.status.toLowerCase() : 'unknown';
}

export async function waitForProcessRun({ client, runId, intervalMs, timeoutMs, onProgress }) {
  if (!client || typeof client.getProcessRun !== 'function') {
    throw new ValidationError('client.getProcessRun must be a function.');
  }

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new ValidationError('runId must be a non-empty string.');
  }

  const normalizedRunId = runId.trim();

  const run = await pollUntilTerminal({
    intervalMs,
    timeoutMs,
    onProgress,
    load: async () => toProcessRun(normalizedRunId, await client.getProcessRun(normalizedRunId)),
    isTerminal: (candidate) => TERMINAL_RUN_STATUSES.has(getRunStatus(candidate)),
  });

  return { runId: normalizedRunId, run };
}
