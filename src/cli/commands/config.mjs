import { NotFoundError, UsageError, ValidationError } from '../../core/errors.mjs';
import { normalizePaths } from '../../core/modly-normalizers.mjs';
import { openModlyLauncher, resolveModlyLauncher } from '../../core/modly-launcher.mjs';
import { parseCommandArgs } from './shared.mjs';

const CONFIG_SUBCOMMANDS = ['paths', 'launcher'];
const PATHS_SUBCOMMANDS = ['get', 'set'];
const LAUNCHER_SUBCOMMANDS = ['locate', 'open'];

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

function formatLauncher(locator) {
  return `launcher: ${locator.path}\nroot: ${locator.root}\nentry: ${locator.entry}\nsource: ${locator.source}`;
}

async function requireResolvedLauncher(context) {
  const launcher = await resolveModlyLauncher({
    cwd: context.cwd ?? process.cwd(),
    env: context.env ?? process.env,
    platform: context.platform ?? process.platform,
  });

  if (!launcher) {
    throw new NotFoundError(
      'modly config launcher locate could not locate a valid Modly launcher. Checked MODLY_LAUNCHER, current repo/ancestors, and sibling ../modly with repo markers api/main.py + electron/main.',
    );
  }

  return launcher;
}

async function runLauncherLocate(context, args) {
  if (args.length !== 0) {
    throw new UsageError('Usage: modly config launcher locate [--json]');
  }

  const launcher = await requireResolvedLauncher(context);

  return {
    data: { launcher },
    humanMessage: formatLauncher(launcher),
  };
}

async function runLauncherOpen(context, args) {
  const usage = 'Usage: modly config launcher open [--foreground] [--json]';
  const { positionals, options } = parseCommandArgs(args, {
    usage,
    booleanFlags: ['--foreground'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(usage);
  }

  const launcher = await requireResolvedLauncher(context);
  const mode = options['--foreground'] === true ? 'foreground' : 'background';
  const opened = await openModlyLauncher({
    launcherPath: launcher.path,
    platform: context.platform ?? process.platform,
    spawnImpl: context.spawnLauncher,
    detached: mode === 'background',
  });

  return {
    data: {
      launcher,
      mode,
      opened,
    },
    humanMessage: `${formatLauncher(launcher)}\nopened launcher in ${mode} with ${opened.command} ${opened.args.join(' ')}`,
  };
}

async function runLauncherCommand(context, args) {
  const [subcommand = 'locate', ...rest] = args;

  switch (subcommand) {
    case 'locate':
      return runLauncherLocate(context, rest);
    case 'open':
      return runLauncherOpen(context, rest);
    default:
      throw new UsageError(
        `Unknown config launcher subcommand: ${subcommand}. Available: ${LAUNCHER_SUBCOMMANDS.join(', ')}.`,
      );
  }
}

export async function runConfigCommand(context) {
  const [subcommand = 'paths', ...args] = context.args;

  switch (subcommand) {
    case 'paths':
      return runPathsCommand(context, args);
    case 'launcher':
      return runLauncherCommand(context, args);
    default:
      throw new UsageError(`Unknown config subcommand: ${subcommand}. Available: ${CONFIG_SUBCOMMANDS.join(', ')}.`);
  }
}
