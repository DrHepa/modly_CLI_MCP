import { ModlyError, TimeoutError, UsageError } from '../../core/errors.mjs';
import { toJob } from '../../core/modly-normalizers.mjs';
import { assertExactPositionals, parseCommandArgs, parseInteger, sleep } from './shared.mjs';

const JOB_SUBCOMMANDS = ['status', 'wait', 'cancel'];
const TERMINAL_JOB_STATES = new Set(['done', 'error', 'cancelled']);
const DEFAULT_WAIT_INTERVAL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 600000;

const STATUS_USAGE = 'Usage: modly job status <job-id> [--api-url <url>] [--json]';
const WAIT_USAGE =
  'Usage: modly job wait <job-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]';
const CANCEL_USAGE = 'Usage: modly job cancel <job-id> [--api-url <url>] [--json]';

function getJobStatus(job) {
  return typeof job?.status === 'string' ? job.status.toLowerCase() : 'unknown';
}

function formatJobLine(jobId, job) {
  const status = getJobStatus(job);
  const progress = job?.progress ?? job?.progress_percent ?? job?.progressPercent;
  const message = job?.message ?? job?.detail ?? job?.error ?? job?.error_message;
  const suffix = [];

  if (progress !== undefined && progress !== null) {
    suffix.push(`progress=${progress}`);
  }

  if (message) {
    suffix.push(String(message));
  }

  return suffix.length > 0 ? `Job ${jobId}: ${status} (${suffix.join(', ')})` : `Job ${jobId}: ${status}`;
}

function assertJobId(jobId, usage) {
  if (!jobId) {
    throw new UsageError(usage);
  }
}

function parseWaitOptions(args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: WAIT_USAGE,
    valueFlags: ['--interval-ms', '--timeout-ms'],
  });

  assertExactPositionals(positionals, 1, WAIT_USAGE);

  return {
    jobId: positionals[0],
    intervalMs: options['--interval-ms']
      ? parseInteger(options['--interval-ms'], '--interval-ms', { min: 1 })
      : DEFAULT_WAIT_INTERVAL_MS,
    timeoutMs: options['--timeout-ms']
      ? parseInteger(options['--timeout-ms'], '--timeout-ms', { min: 1 })
      : DEFAULT_WAIT_TIMEOUT_MS,
  };
}

export async function waitForJob({ client, jobId, intervalMs, timeoutMs, onProgress }) {
  const startedAt = Date.now();
  let lastProgressLine;

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new TimeoutError(`Timed out while waiting for job ${jobId}.`);
    }

    const response = await client.getJobStatus(jobId);
    const job = toJob(jobId, response);
    const status = getJobStatus(job);
    const progressLine = formatJobLine(jobId, job);

    if (onProgress && progressLine !== lastProgressLine) {
      onProgress(progressLine, job);
      lastProgressLine = progressLine;
    }

    if (TERMINAL_JOB_STATES.has(status)) {
      if (status === 'error') {
        throw new ModlyError(job?.message ?? job?.error ?? `Job ${jobId} failed.`, {
          code: 'JOB_FAILED',
        });
      }

      return { jobId, job };
    }

    await sleep(intervalMs);
  }
}

async function runStatus(context, args) {
  assertExactPositionals(args, 1, STATUS_USAGE);

  const [jobId] = args;
  assertJobId(jobId, STATUS_USAGE);

  const response = await context.client.getJobStatus(jobId);
  const job = toJob(jobId, response);

  return {
    data: { jobId, job },
    humanMessage: formatJobLine(jobId, job),
  };
}

async function runWait(context, args) {
  const { jobId, intervalMs, timeoutMs } = parseWaitOptions(args);

  const result = await waitForJob({
    client: context.client,
    jobId,
    intervalMs,
    timeoutMs,
    onProgress: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });

  return {
    data: {
      jobId,
      intervalMs,
      timeoutMs,
      job: result.job,
    },
    humanMessage:
      getJobStatus(result.job) === 'cancelled'
        ? `Job ${jobId} cancelled.`
        : `Job ${jobId} done.`,
  };
}

async function runCancel(context, args) {
  assertExactPositionals(args, 1, CANCEL_USAGE);

  const [jobId] = args;
  assertJobId(jobId, CANCEL_USAGE);

  const result = await context.client.cancelJob(jobId);

  return {
    data: { jobId, result },
    humanMessage: `Cancel requested for job ${jobId}.`,
  };
}

export async function runJobCommand(context) {
  const [subcommand = 'status', ...args] = context.args;

  switch (subcommand) {
    case 'status':
      return runStatus(context, args);
    case 'wait':
      return runWait(context, args);
    case 'cancel':
      return runCancel(context, args);
    default:
      throw new UsageError(`Unknown job subcommand: ${subcommand}. Available: ${JOB_SUBCOMMANDS.join(', ')}.`);
  }
}
