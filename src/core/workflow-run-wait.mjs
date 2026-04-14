import { ValidationError } from './errors.mjs';
import { toWorkflowRun } from './modly-normalizers.mjs';
import { pollUntilTerminal } from './polling.mjs';

const TERMINAL_RUN_STATUSES = new Set(['done', 'error', 'cancelled']);

function getRunStatus(run) {
  return typeof run?.status === 'string' ? run.status.toLowerCase() : 'unknown';
}

export async function waitForWorkflowRun({ client, runId, intervalMs, timeoutMs, onProgress }) {
  if (!client || typeof client.getWorkflowRun !== 'function') {
    throw new ValidationError('client.getWorkflowRun must be a function.');
  }

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new ValidationError('runId must be a non-empty string.');
  }

  const normalizedRunId = runId.trim();

  const run = await pollUntilTerminal({
    intervalMs,
    timeoutMs,
    onProgress,
    load: async () => toWorkflowRun(normalizedRunId, await client.getWorkflowRun(normalizedRunId)),
    isTerminal: (candidate) => TERMINAL_RUN_STATUSES.has(getRunStatus(candidate)),
  });

  return { runId: normalizedRunId, run };
}
