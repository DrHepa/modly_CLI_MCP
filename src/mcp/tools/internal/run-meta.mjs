const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(['done', 'error', 'cancelled']);
const TERMINAL_PROCESS_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const WORKFLOW_RUN_OPERATION_STATES = {
  queued: 'pending',
  running: 'in_progress',
  done: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
};
const PROCESS_RUN_OPERATION_STATES = {
  accepted: 'pending',
  running: 'in_progress',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'cancelled',
};
const DEFAULT_POLL_INTERVAL_MS = 1000;

export function summarizeWorkflowRun(runId, run, action = 'status') {
  const resolvedRunId = run?.run_id ?? run?.runId ?? runId;
  const status = typeof run?.status === 'string' ? run.status : 'unknown';

  switch (action) {
    case 'created':
      return `Workflow run ${resolvedRunId} created (${status}).`;
    case 'cancelled':
      return `Workflow run ${resolvedRunId} cancel requested (${status}).`;
    default:
      return `Workflow run ${resolvedRunId}: ${status}.`;
  }
}

export function summarizeProcessRun(runId, run, action = 'status') {
  const resolvedRunId = run?.run_id ?? run?.runId ?? runId;
  const status = typeof run?.status === 'string' ? run.status : 'unknown';

  switch (action) {
    case 'created':
      return `Process run ${resolvedRunId} created (${status}).`;
    case 'cancelled':
      return `Process run ${resolvedRunId} cancel requested (${status}).`;
    default:
      return `Process run ${resolvedRunId}: ${status}.`;
  }
}

export function isWorkflowRunTerminal(run) {
  return TERMINAL_WORKFLOW_RUN_STATUSES.has(typeof run?.status === 'string' ? run.status.toLowerCase() : '');
}

export function isProcessRunTerminal(run) {
  return TERMINAL_PROCESS_RUN_STATUSES.has(typeof run?.status === 'string' ? run.status.toLowerCase() : '');
}

function getRunId(run) {
  return run?.run_id ?? run?.runId;
}

function getRunStatus(run) {
  return typeof run?.status === 'string' ? run.status.toLowerCase() : '';
}

export function toOperationState(kind, run, terminal) {
  const status = getRunStatus(run);
  const states = kind === 'workflowRun' ? WORKFLOW_RUN_OPERATION_STATES : PROCESS_RUN_OPERATION_STATES;

  if (states[status]) {
    return states[status];
  }

  return terminal ? 'failed' : 'in_progress';
}

export function buildRunMeta(kind, run, statusTool, opts = {}) {
  const runId = getRunId(run);
  const terminal = kind === 'workflowRun' ? isWorkflowRunTerminal(run) : isProcessRunTerminal(run);
  const meta = {
    terminal,
    operation: {
      kind,
      runId,
    },
    operationState: toOperationState(kind, run, terminal),
    nextAction: {
      kind: terminal ? 'observe_terminal' : 'poll_status',
      tool: statusTool,
      input: { runId },
    },
  };

  if (!terminal) {
    meta.suggestedPollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  }

  if (opts.polling) {
    meta.polling = opts.polling;
  }

  return meta;
}
