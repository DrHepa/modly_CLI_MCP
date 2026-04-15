import { toProcessRun } from '../../core/modly-normalizers.mjs';
import { prepareProcessRunCreateInput } from '../../core/process-run-input.mjs';
import { waitForProcessRun } from '../../core/process-run-wait.mjs';
import { BackendUnavailableError, UsageError } from '../../core/errors.mjs';
import {
  assertExactPositionals,
  assertNonEmptyString,
  parseCommandArgs,
  parseInteger,
  parseJsonObject,
} from './shared.mjs';

const PROCESS_RUN_SUBCOMMANDS = ['create', 'status', 'wait', 'cancel'];
const DEFAULT_WAIT_INTERVAL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 600000;

const CREATE_USAGE =
  "Usage: modly process-run create --process-id <id> --params-json '{...}' [--workspace-path <path>] [--output-path <path>] [--api-url <url>] [--json]";
const STATUS_USAGE = 'Usage: modly process-run status <run-id> [--api-url <url>] [--json]';
const WAIT_USAGE =
  'Usage: modly process-run wait <run-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]';
const CANCEL_USAGE = 'Usage: modly process-run cancel <run-id> [--api-url <url>] [--json]';

const TERMINAL_PROCESS_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

async function assertBackendReady(client) {
  try {
    await client.health();
  } catch (error) {
    throw new BackendUnavailableError('Modly backend is unavailable.', {
      cause: error,
      details: { check: '/health', group: 'process-run' },
    });
  }
}

function summarizeRun(run, fallbackRunId, action) {
  const runId = run?.run_id ?? run?.runId ?? fallbackRunId;
  const status = typeof run?.status === 'string' ? run.status : 'unknown';

  switch (action) {
    case 'created':
      return `Process run ${runId} created (${status}).`;
    case 'cancelled':
      return `Process run ${runId} cancel requested (${status}).`;
    default:
      return `Process run ${runId}: ${status}.`;
  }
}

function formatWaitProgressLine(runId, run) {
  const status = typeof run?.status === 'string' ? run.status : 'unknown';
  const suffix = [];

  if (typeof run?.error === 'string' && run.error.trim() !== '') {
    suffix.push(`error=${run.error.trim()}`);
  }

  return suffix.length > 0 ? `Process run ${runId}: ${status} (${suffix.join(', ')})` : `Process run ${runId}: ${status}`;
}

function isProcessRunTerminal(run) {
  return TERMINAL_PROCESS_RUN_STATUSES.has(typeof run?.status === 'string' ? run.status.toLowerCase() : '');
}

function parseWaitOptions(args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: WAIT_USAGE,
    valueFlags: ['--interval-ms', '--timeout-ms'],
  });

  assertExactPositionals(positionals, 1, WAIT_USAGE);

  return {
    runId: assertNonEmptyString(positionals[0], '<run-id>'),
    intervalMs: options['--interval-ms']
      ? parseInteger(options['--interval-ms'], '--interval-ms', { min: 1 })
      : DEFAULT_WAIT_INTERVAL_MS,
    timeoutMs: options['--timeout-ms']
      ? parseInteger(options['--timeout-ms'], '--timeout-ms', { min: 1 })
      : DEFAULT_WAIT_TIMEOUT_MS,
  };
}

async function runCreate(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: CREATE_USAGE,
    valueFlags: ['--process-id', '--workspace-path', '--output-path', '--params-json'],
  });

  assertExactPositionals(positionals, 0, CREATE_USAGE);

  if (!options['--process-id'] || !options['--params-json']) {
    throw new UsageError(CREATE_USAGE);
  }

  const params = parseJsonObject(options['--params-json']);

  await assertBackendReady(context.client);
  const capabilities = await context.client.getAutomationCapabilities();

  const payload = prepareProcessRunCreateInput(
    {
      process_id: options['--process-id'],
      workspace_path: options['--workspace-path'],
      outputPath: options['--output-path'],
      params,
    },
    { capabilities },
  );

  const response = await context.client.createProcessRun(payload);
  const run = toProcessRun(undefined, response);

  return {
    data: { run },
    humanMessage: summarizeRun(run, undefined, 'created'),
  };
}

async function runStatus(context, args) {
  assertExactPositionals(args, 1, STATUS_USAGE);

  const runId = assertNonEmptyString(args[0], '<run-id>');

  await assertBackendReady(context.client);

  const response = await context.client.getProcessRun(runId);
  const run = toProcessRun(runId, response);

  return {
    data: { run, meta: { terminal: isProcessRunTerminal(run) } },
    humanMessage: summarizeRun(run, runId, 'status'),
  };
}

async function runCancel(context, args) {
  assertExactPositionals(args, 1, CANCEL_USAGE);

  const runId = assertNonEmptyString(args[0], '<run-id>');

  await assertBackendReady(context.client);

  const response = await context.client.cancelProcessRun(runId);
  const run = toProcessRun(runId, response);

  return {
    data: { run },
    humanMessage: summarizeRun(run, runId, 'cancelled'),
  };
}

async function runWait(context, args) {
  const { runId, intervalMs, timeoutMs } = parseWaitOptions(args);

  await assertBackendReady(context.client);

  let lastProgressLine;
  const result = await waitForProcessRun({
    client: context.client,
    runId,
    intervalMs,
    timeoutMs,
    onProgress: (run) => {
      const progressLine = formatWaitProgressLine(runId, run);

      if (progressLine !== lastProgressLine) {
        process.stderr.write(`${progressLine}\n`);
        lastProgressLine = progressLine;
      }
    },
  });

  return {
    data: {
      runId,
      intervalMs,
      timeoutMs,
      run: result.run,
      meta: {
        terminal: true,
        polling: result.polling,
      },
    },
    humanMessage: summarizeRun(result.run, runId, 'status'),
  };
}

export async function runProcessRunCommand(context) {
  const [subcommand = 'create', ...args] = context.args;

  switch (subcommand) {
    case 'create':
      return runCreate(context, args);
    case 'status':
      return runStatus(context, args);
    case 'wait':
      return runWait(context, args);
    case 'cancel':
      return runCancel(context, args);
    default:
      throw new UsageError(
        `Unknown process-run subcommand: ${subcommand}. Available: ${PROCESS_RUN_SUBCOMMANDS.join(', ')}.`,
      );
  }
}
