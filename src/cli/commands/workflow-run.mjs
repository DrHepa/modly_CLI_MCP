import path from 'node:path';
import { toModelList, toWorkflowRun } from '../../core/modly-normalizers.mjs';
import { waitForWorkflowRun } from '../../core/workflow-run-wait.mjs';
import { BackendUnavailableError, UsageError, ValidationError } from '../../core/errors.mjs';
import {
  assertExactPositionals,
  assertFileExists,
  assertNonEmptyString,
  parseCommandArgs,
  parseInteger,
  parseJsonObject,
} from './shared.mjs';

const WORKFLOW_RUN_SUBCOMMANDS = ['from-image', 'status', 'wait', 'cancel'];
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DEFAULT_WAIT_INTERVAL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 600000;

const FROM_IMAGE_USAGE =
  "Usage: modly workflow-run from-image --image <path> --model <id> [--params-json '{...}'] [--api-url <url>] [--json]";
const STATUS_USAGE = 'Usage: modly workflow-run status <run-id> [--api-url <url>] [--json]';
const WAIT_USAGE =
  'Usage: modly workflow-run wait <run-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]';
const CANCEL_USAGE = 'Usage: modly workflow-run cancel <run-id> [--api-url <url>] [--json]';

const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(['done', 'error', 'cancelled']);

function getModelId(model) {
  return model?.id ?? model?.model_id ?? model?.modelId ?? 'unknown';
}

async function assertBackendReady(client) {
  try {
    await client.health();
  } catch (error) {
    throw new BackendUnavailableError('Modly backend is unavailable.', {
      cause: error,
      details: { check: '/health', group: 'workflow-run' },
    });
  }
}

async function assertImagePath(imagePath) {
  const normalizedPath = assertNonEmptyString(imagePath, '--image');
  await assertFileExists(normalizedPath, '--image');

  if (!SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase())) {
    throw new ValidationError('--image must point to a supported image file (.png, .jpg, .jpeg, .webp).');
  }

  return normalizedPath;
}

async function assertCanonicalModelId(client, modelId) {
  const normalizedModelId = assertNonEmptyString(modelId, '--model');
  const modelsResponse = await client.listModels();
  const models = toModelList(modelsResponse);
  const canonicalIds = new Set(
    models.map((model) => getModelId(model)).filter((id) => typeof id === 'string' && id !== 'unknown'),
  );

  if (!canonicalIds.has(normalizedModelId)) {
    throw new ValidationError(`Unknown canonical modelId: ${normalizedModelId}.`, {
      details: {
        field: 'modelId',
        reason: 'non_canonical_model_id',
        modelId: normalizedModelId,
      },
    });
  }

  return normalizedModelId;
}

function summarizeRun(run, fallbackRunId, action) {
  const runId = run?.run_id ?? run?.runId ?? fallbackRunId;
  const status = typeof run?.status === 'string' ? run.status : 'unknown';

  switch (action) {
    case 'created':
      return `Workflow run ${runId} created (${status}).`;
    case 'cancelled':
      return `Workflow run ${runId} cancel requested (${status}).`;
    default:
      return `Workflow run ${runId}: ${status}.`;
  }
}

function formatWaitProgressLine(runId, run) {
  const status = typeof run?.status === 'string' ? run.status : 'unknown';
  const suffix = [];

  if (typeof run?.progress === 'number') {
    suffix.push(`progress=${run.progress}`);
  }

  if (typeof run?.step === 'string' && run.step.trim() !== '') {
    suffix.push(`step=${run.step.trim()}`);
  }

  if (typeof run?.error === 'string' && run.error.trim() !== '') {
    suffix.push(`error=${run.error.trim()}`);
  }

  return suffix.length > 0 ? `Workflow run ${runId}: ${status} (${suffix.join(', ')})` : `Workflow run ${runId}: ${status}`;
}

function isWorkflowRunTerminal(run) {
  return TERMINAL_WORKFLOW_RUN_STATUSES.has(typeof run?.status === 'string' ? run.status.toLowerCase() : '');
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

async function runFromImage(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: FROM_IMAGE_USAGE,
    valueFlags: ['--image', '--model', '--params-json'],
  });

  assertExactPositionals(positionals, 0, FROM_IMAGE_USAGE);

  if (!options['--image'] || !options['--model']) {
    throw new UsageError(FROM_IMAGE_USAGE);
  }

  const imagePath = await assertImagePath(options['--image']);
  const paramsJson = parseJsonObject(options['--params-json']);

  await assertBackendReady(context.client);
  const modelId = await assertCanonicalModelId(context.client, options['--model']);

  const response = await context.client.createWorkflowRunFromImage({
    imagePath,
    modelId,
    paramsJson,
  });
  const run = toWorkflowRun(undefined, response);

  return {
    data: { run },
    humanMessage: summarizeRun(run, undefined, 'created'),
  };
}

async function runStatus(context, args) {
  assertExactPositionals(args, 1, STATUS_USAGE);

  const runId = assertNonEmptyString(args[0], '<run-id>');

  await assertBackendReady(context.client);

  const response = await context.client.getWorkflowRun(runId);
  const run = toWorkflowRun(runId, response);

  return {
    data: { run, meta: { terminal: isWorkflowRunTerminal(run) } },
    humanMessage: summarizeRun(run, runId, 'status'),
  };
}

async function runCancel(context, args) {
  assertExactPositionals(args, 1, CANCEL_USAGE);

  const runId = assertNonEmptyString(args[0], '<run-id>');

  await assertBackendReady(context.client);

  const response = await context.client.cancelWorkflowRun(runId);
  const run = toWorkflowRun(runId, response);

  return {
    data: { run },
    humanMessage: summarizeRun(run, runId, 'cancelled'),
  };
}

async function runWait(context, args) {
  const { runId, intervalMs, timeoutMs } = parseWaitOptions(args);

  await assertBackendReady(context.client);

  let lastProgressLine;
  const result = await waitForWorkflowRun({
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

export async function runWorkflowRunCommand(context) {
  const [subcommand = 'from-image', ...args] = context.args;

  switch (subcommand) {
    case 'from-image':
      return runFromImage(context, args);
    case 'status':
      return runStatus(context, args);
    case 'wait':
      return runWait(context, args);
    case 'cancel':
      return runCancel(context, args);
    default:
      throw new UsageError(
        `Unknown workflow-run subcommand: ${subcommand}. Available: ${WORKFLOW_RUN_SUBCOMMANDS.join(', ')}.`,
      );
  }
}
