import { UnsupportedOperationError, UsageError } from '../../core/errors.mjs';
import { stageGitHubExtension } from '../../core/github-extension-staging.mjs';
import { normalizeErrors } from '../../core/modly-normalizers.mjs';
import { assertExactPositionals, parseCommandArgs } from './shared.mjs';

const EXT_SUBCOMMANDS = ['reload', 'errors', 'stage github'];
const STAGE_GITHUB_USAGE =
  'Usage: modly ext stage github --repo <owner/name> [--ref <ref>] [--staging-dir <workspace-relative-path>] [--api-url <url>] [--json]';

async function runReload(context, args) {
  if (args.length !== 0) {
    throw new UsageError('Usage: modly ext reload [--api-url <url>] [--json]');
  }

  const result = await context.client.reloadExtensions();

  return {
    data: { result },
    humanMessage: 'Extension registry reload requested.',
  };
}

async function runErrors(context, args) {
  if (args.length !== 0) {
    throw new UsageError('Usage: modly ext errors [--api-url <url>] [--json]');
  }

  const result = await context.client.getExtensionErrors();
  const errors = normalizeErrors(result);
  const errorCount = Array.isArray(errors) ? errors.length : Object.keys(errors).length;

  return {
    data: { errors, result },
    humanMessage:
      errorCount === 0
        ? 'No extension load errors reported.'
        : `Extension load errors: ${errorCount}\n${JSON.stringify(errors, null, 2)}`,
  };
}

function renderStageHumanMessage(staging) {
  const lines = [
    `GitHub extension stage/preflight only: ${staging.status} for ${staging.source.repo}.`,
    `stagePath: ${staging.stagePath}`,
    'No live install was attempted.',
  ];

  if (staging.manifestSummary?.id) {
    lines.push(`manifest.id: ${staging.manifestSummary.id}`);
  }

  if (staging.diagnostics?.code) {
    lines.push(`diagnostic: ${staging.diagnostics.code}`);
  }

  if (Array.isArray(staging.nextManualActions) && staging.nextManualActions.length > 0) {
    lines.push(`manual next actions: ${staging.nextManualActions.length}`);
  }

  return lines.join('\n');
}

async function runStageGithub(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: STAGE_GITHUB_USAGE,
    valueFlags: ['--repo', '--ref', '--staging-dir'],
  });
  assertExactPositionals(positionals, 0, STAGE_GITHUB_USAGE);

  const stage = context.stageGitHubExtension ?? stageGitHubExtension;
  const staging = await stage(
    {
      repo: options['--repo'],
      ref: options['--ref'],
      stagingDir: options['--staging-dir'],
    },
    {
      cwd: context.cwd,
      tmpdir: context.tmpdir,
      spawnImpl: context.spawnImpl,
    },
  );

  return {
    data: { staging },
    humanMessage: renderStageHumanMessage(staging),
  };
}

async function runStage(context, args) {
  const [target, ...rest] = args;

  if (target !== 'github') {
    throw new UsageError(`Unknown ext stage target: ${target ?? '<missing>'}. Available: github.`);
  }

  return runStageGithub(context, rest);
}

export async function runExtCommand(context) {
  const [subcommand = 'reload', ...args] = context.args;

  switch (subcommand) {
    case 'reload':
      return runReload(context, args);
    case 'errors':
      return runErrors(context, args);
    case 'stage':
      return runStage(context, args);
    case 'install':
    case 'apply':
      throw new UnsupportedOperationError(
        'Live extension install/apply is out of scope for this CLI seam. Use `modly ext stage github` for staging/preflight only.',
        { code: 'EXT_LIVE_INSTALL_OUT_OF_SCOPE' },
      );
    default:
      throw new UsageError(`Unknown ext subcommand: ${subcommand}. Available: ${EXT_SUBCOMMANDS.join(', ')}.`);
  }
}
