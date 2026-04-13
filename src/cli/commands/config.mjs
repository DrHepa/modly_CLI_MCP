import { UsageError, ValidationError } from '../../core/errors.mjs';
import { normalizePaths } from '../../core/modly-normalizers.mjs';
import { parseCommandArgs } from './shared.mjs';

const CONFIG_SUBCOMMANDS = ['paths'];
const PATHS_SUBCOMMANDS = ['get', 'set'];

function formatPaths(paths) {
  const modelsDir = paths.models_dir ?? paths.modelsDir ?? '—';
  const workspaceDir = paths.workspace_dir ?? paths.workspaceDir ?? '—';

  return `models_dir: ${modelsDir}\nworkspace_dir: ${workspaceDir}`;
}

function normalizeRuntimeDir(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${flag} must be a non-empty path.`);
  }

  return value.trim();
}

async function runPathsGet(context, args) {
  if (args.length !== 0) {
    throw new UsageError('Usage: modly config paths get [--api-url <url>] [--json]');
  }

  const result = await context.client.getRuntimePaths();
  const paths = normalizePaths(result);

  return {
    data: { paths, runtimeOnly: true },
    humanMessage: `${formatPaths(paths)}\n(runtime-only; not persisted to desktop settings)`,
  };
}

async function runPathsSet(context, args) {
  const usage =
    'Usage: modly config paths set [--models-dir <dir>] [--workspace-dir <dir>] [--api-url <url>] [--json]';
  const { positionals, options } = parseCommandArgs(args, {
    usage,
    valueFlags: ['--models-dir', '--workspace-dir'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(usage);
  }

  const modelsDir = options['--models-dir'];
  const workspaceDir = options['--workspace-dir'];

  if (!modelsDir && !workspaceDir) {
    throw new UsageError(`At least one of --models-dir or --workspace-dir is required.\n${usage}`);
  }

  const payload = {};

  if (modelsDir) {
    payload.models_dir = normalizeRuntimeDir(modelsDir, '--models-dir');
  }

  if (workspaceDir) {
    payload.workspace_dir = normalizeRuntimeDir(workspaceDir, '--workspace-dir');
  }

  const result = await context.client.setRuntimePaths(payload);
  const paths = normalizePaths(result);

  return {
    data: { paths, runtimeOnly: true, requested: payload },
    humanMessage: `${formatPaths(paths)}\nUpdated runtime paths only; changes are not persisted.`,
  };
}

async function runPathsCommand(context, args) {
  const [subcommand = 'get', ...rest] = args;

  switch (subcommand) {
    case 'get':
      return runPathsGet(context, rest);
    case 'set':
      return runPathsSet(context, rest);
    default:
      throw new UsageError(`Unknown config paths subcommand: ${subcommand}. Available: ${PATHS_SUBCOMMANDS.join(', ')}.`);
  }
}

export async function runConfigCommand(context) {
  const [subcommand = 'paths', ...args] = context.args;

  switch (subcommand) {
    case 'paths':
      return runPathsCommand(context, args);
    default:
      throw new UsageError(`Unknown config subcommand: ${subcommand}. Available: ${CONFIG_SUBCOMMANDS.join(', ')}.`);
  }
}
