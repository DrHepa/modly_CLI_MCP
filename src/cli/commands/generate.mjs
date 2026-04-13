import { ValidationError, UsageError } from '../../core/errors.mjs';
import { waitForJob } from './job.mjs';
import { assertFileExists, parseCommandArgs, parseInteger } from './shared.mjs';

const GENERATE_SUBCOMMANDS = ['from-image'];
const FROM_IMAGE_USAGE =
  "Usage: modly generate from-image --image <path> --model <id> [--collection <name>] [--remesh quad|triangle|none] [--texture] [--texture-resolution <n>] [--params-json '<json>'] [--wait] [--api-url <url>] [--json]";
const REMESH_VALUES = new Set(['quad', 'triangle', 'none']);
const INVALID_COLLECTION_CHARS = /[\/:*?"<>|\\]/;

function parseParamsJson(raw) {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('--params-json must parse to a JSON object.');
    }

    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ValidationError('--params-json must be valid JSON.');
  }
}

function extractJobId(response) {
  const jobId = response?.job_id ?? response?.jobId ?? response?.id ?? response?.job?.job_id ?? response?.job?.jobId;

  if (!jobId) {
    throw new ValidationError('Backend response did not include a job_id.');
  }

  return jobId;
}

async function runFromImage(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: FROM_IMAGE_USAGE,
    valueFlags: ['--image', '--model', '--collection', '--remesh', '--texture-resolution', '--params-json'],
    booleanFlags: ['--texture', '--wait'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(FROM_IMAGE_USAGE);
  }

  const imagePath = options['--image'];
  const modelId = options['--model'];
  const collection = options['--collection'];
  const remesh = options['--remesh'];
  const texture = Boolean(options['--texture']);
  const wait = Boolean(options['--wait']);

  if (!imagePath) {
    throw new UsageError(FROM_IMAGE_USAGE);
  }

  if (!modelId) {
    throw new UsageError(FROM_IMAGE_USAGE);
  }

  await assertFileExists(imagePath, '--image');

  if (collection && INVALID_COLLECTION_CHARS.test(collection)) {
    throw new ValidationError('--collection contains invalid filesystem characters.');
  }

  if (remesh && !REMESH_VALUES.has(remesh)) {
    throw new ValidationError('--remesh must be one of: quad, triangle, none.');
  }

  const textureResolution = options['--texture-resolution']
    ? parseInteger(options['--texture-resolution'], '--texture-resolution', { min: 1 })
    : undefined;
  const paramsJson = parseParamsJson(options['--params-json']);

  const submission = await context.client.generateFromImage({
    imagePath,
    modelId,
    collection,
    remesh,
    texture,
    textureResolution,
    paramsJson,
  });
  const jobId = extractJobId(submission);

  if (!wait) {
    return {
      data: { jobId },
      humanMessage: `Generation started. Job: ${jobId}.`,
    };
  }

  const result = await waitForJob({
    client: context.client,
    jobId,
    intervalMs: 1000,
    timeoutMs: 600000,
    onProgress: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });

  return {
    data: {
      jobId,
      job: result.job,
    },
    humanMessage: `Generation finished for job ${jobId}.`,
  };
}

export async function runGenerateCommand(context) {
  const [subcommand = 'from-image', ...args] = context.args;

  switch (subcommand) {
    case 'from-image':
      return runFromImage(context, args);
    default:
      throw new UsageError(
        `Unknown generate subcommand: ${subcommand}. Available: ${GENERATE_SUBCOMMANDS.join(', ')}.`,
      );
  }
}
