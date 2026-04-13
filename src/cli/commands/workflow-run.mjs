import path from 'node:path';
import { toModelList, toWorkflowRun } from '../../core/modly-normalizers.mjs';
import { BackendUnavailableError, UsageError, ValidationError } from '../../core/errors.mjs';
import {
  assertExactPositionals,
  assertFileExists,
  assertNonEmptyString,
  parseCommandArgs,
  parseJsonObject,
} from './shared.mjs';

const WORKFLOW_RUN_SUBCOMMANDS = ['from-image', 'status', 'cancel'];
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const FROM_IMAGE_USAGE =
  "Usage: modly workflow-run from-image --image <path> --model <id> [--params-json '{...}'] [--api-url <url>] [--json]";
const STATUS_USAGE = 'Usage: modly workflow-run status <run-id> [--api-url <url>] [--json]';
const CANCEL_USAGE = 'Usage: modly workflow-run cancel <run-id> [--api-url <url>] [--json]';

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
    data: { run },
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

export async function runWorkflowRunCommand(context) {
  const [subcommand = 'from-image', ...args] = context.args;

  switch (subcommand) {
    case 'from-image':
      return runFromImage(context, args);
    case 'status':
      return runStatus(context, args);
    case 'cancel':
      return runCancel(context, args);
    default:
      throw new UsageError(
        `Unknown workflow-run subcommand: ${subcommand}. Available: ${WORKFLOW_RUN_SUBCOMMANDS.join(', ')}.`,
      );
  }
}
