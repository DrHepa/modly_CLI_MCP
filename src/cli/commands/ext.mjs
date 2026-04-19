import { UnsupportedOperationError, UsageError } from '../../core/errors.mjs';
import { applyStagedExtension, repairStagedExtension } from '../../core/extension-apply.mjs';
import { configureStagedExtension } from '../../core/extension-setup.mjs';
import { stageGitHubExtension } from '../../core/github-extension-staging.mjs';
import { normalizeErrors } from '../../core/modly-normalizers.mjs';
import { assertExactPositionals, parseCommandArgs, parseJsonObject } from './shared.mjs';

const EXT_SUBCOMMANDS = ['reload', 'errors', 'stage github', 'apply', 'setup', 'repair'];
const STAGE_GITHUB_USAGE =
  'Usage: modly ext stage github --repo <owner/name> [--ref <ref>] [--staging-dir <workspace-relative-path>] [--api-url <url>] [--json]';
const APPLY_USAGE =
  'Usage: modly ext apply --stage-path <path> --extensions-dir <abs-path> [--source-repo <owner/name> --source-ref <ref> --source-commit <sha>] [--api-url <url>] [--json]';
const SETUP_USAGE =
  "Usage: modly ext setup --stage-path <path> --python-exe <exe> --allow-third-party [--setup-payload-json '{...}'] [--api-url <url>] [--json]";
const REPAIR_USAGE =
  'Usage: modly ext repair --stage-path <path> --extensions-dir <abs-path> [--source-repo <owner/name> --source-ref <ref> --source-commit <sha>] [--api-url <url>] [--json]';

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

function renderApplyHumanMessage(apply) {
  const runtimeErrorCount = Array.isArray(apply.errors?.matched) ? apply.errors.matched.length : 0;
  const lines = [
    `CLI-only apply over prepared stage: ${apply.status} for ${apply.manifest?.id ?? '<unknown>'}.`,
    `stagePath: ${apply.stagePath}`,
    `extensionsDir: ${apply.resolution?.extensionsDir ?? '<unknown>'}`,
    `destination: ${apply.destination?.path ?? '<unknown>'}`,
    'No GitHub fetch, install, build, or repair was attempted.',
  ];

  if (apply.backup?.created && apply.backup.path) {
    lines.push(`backup: ${apply.backup.path}`);
  }

  if (apply.reload?.requested) {
    lines.push(`reload: ${apply.reload.succeeded ? 'requested and observed' : 'requested but degraded'}`);
  }

  if (runtimeErrorCount > 0) {
    lines.push(`runtime errors: ${runtimeErrorCount}`);
  }

  if (Array.isArray(apply.warnings) && apply.warnings.length > 0) {
    lines.push(`warnings: ${apply.warnings.length}`);
  }

  return lines.join('\n');
}

async function runApply(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: APPLY_USAGE,
    valueFlags: ['--stage-path', '--extensions-dir', '--source-repo', '--source-ref', '--source-commit'],
  });
  assertExactPositionals(positionals, 0, APPLY_USAGE);

  if (!options['--stage-path']) {
    throw new UsageError(APPLY_USAGE);
  }

  const apply = context.applyStagedExtension ?? applyStagedExtension;
  const result = await apply(
    {
      stagePath: options['--stage-path'],
      extensionsDir: options['--extensions-dir'],
      sourceRepo: options['--source-repo'],
      sourceRef: options['--source-ref'],
      sourceCommit: options['--source-commit'],
    },
    {
      cwd: context.cwd,
      reloadExtensions: context.client.reloadExtensions?.bind(context.client),
      getExtensionErrors: context.client.getExtensionErrors?.bind(context.client),
    },
  );

  return {
    data: { apply: result },
    humanMessage: renderApplyHumanMessage(result),
  };
}

function renderSetupHumanMessage(setup) {
  const lines = [
    `CLI-only staged setup: ${setup.status}.`,
    `stagePath: ${setup.stagePath}`,
    `contract: ${setup.plan?.setupContract?.kind ?? '<unsupported>'}`,
    `catalog support: ${setup.catalogStatus ?? setup.plan?.setupContract?.catalogStatus ?? 'unknown'}`,
    `third-party execution: ${setup.plan?.consentGranted ? 'consent granted explicitly' : 'consent NOT granted'}`,
    'No install completo, apply, repair, ni build implícito fue intentado.',
  ];

  if ((setup.catalogStatus ?? setup.plan?.setupContract?.catalogStatus) === 'unknown') {
    lines.push('limited catalog support; not universal setup compatibility');
  }

  if (typeof setup.execution?.exitCode === 'number') {
    lines.push(`exitCode: ${setup.execution.exitCode}`);
  }

  if (Array.isArray(setup.blockers) && setup.blockers.length > 0) {
    lines.push(`blockers: ${setup.blockers.length}`);

    const missingInputs = setup.blockers
      .filter((blocker) => blocker?.code === 'SETUP_INPUT_REQUIRED' && Array.isArray(blocker.detail))
      .flatMap((blocker) => blocker.detail)
      .filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);

    if (missingInputs.length > 0) {
      lines.push(`missing setup inputs: ${missingInputs.join(', ')}`);
    }
  }

  if (Array.isArray(setup.artifacts?.after?.warnings) && setup.artifacts.after.warnings.length > 0) {
    lines.push(`warnings: ${setup.artifacts.after.warnings.length}`);
  }

  return lines.join('\n');
}

async function runSetup(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: SETUP_USAGE,
    valueFlags: ['--stage-path', '--python-exe', '--setup-payload-json'],
    booleanFlags: ['--allow-third-party'],
  });
  assertExactPositionals(positionals, 0, SETUP_USAGE);

  if (!options['--stage-path'] || !options['--python-exe']) {
    throw new UsageError(SETUP_USAGE);
  }

  const setupPayload = parseJsonObject(options['--setup-payload-json'], '--setup-payload-json') ?? {};
  const configure = context.configureStagedExtension ?? configureStagedExtension;
  const result = await configure({
    stagePath: options['--stage-path'],
    pythonExe: options['--python-exe'],
    allowThirdParty: options['--allow-third-party'] === true,
    setupPayload,
  }, {
    cwd: context.cwd,
    spawnImpl: context.spawnImpl,
  });

  return {
    data: { setup: result },
    humanMessage: renderSetupHumanMessage(result),
  };
}

function renderRepairHumanMessage(repair) {
  const runtimeErrorCount = Array.isArray(repair.errors?.matched) ? repair.errors.matched.length : 0;
  const lines = [
    `CLI-only repair/reapply over prepared stage: ${repair.status} for ${repair.manifest?.id ?? '<unknown>'}.`,
    `stagePath: ${repair.stagePath}`,
    `extensionsDir: ${repair.resolution?.extensionsDir ?? '<unknown>'}`,
    `destination: ${repair.destination?.path ?? '<unknown>'}`,
    'No GitHub fetch, install, setup, build, or general health fix was attempted.',
  ];

  if (repair.backup?.created && repair.backup.path) {
    lines.push(`backup: ${repair.backup.path}`);
  }

  if (repair.reload?.requested) {
    lines.push(`reload: ${repair.reload.succeeded ? 'requested and observed' : 'requested but degraded'}`);
  }

  if (runtimeErrorCount > 0) {
    lines.push(`runtime errors: ${runtimeErrorCount}`);
  }

  if (Array.isArray(repair.warnings) && repair.warnings.length > 0) {
    lines.push(`warnings: ${repair.warnings.length}`);
  }

  return lines.join('\n');
}

async function runRepair(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: REPAIR_USAGE,
    valueFlags: ['--stage-path', '--extensions-dir', '--source-repo', '--source-ref', '--source-commit'],
  });
  assertExactPositionals(positionals, 0, REPAIR_USAGE);

  if (!options['--stage-path']) {
    throw new UsageError(REPAIR_USAGE);
  }

  if (!options['--extensions-dir']) {
    throw new UsageError(REPAIR_USAGE);
  }

  const repair = context.repairStagedExtension ?? repairStagedExtension;
  const result = await repair(
    {
      stagePath: options['--stage-path'],
      extensionsDir: options['--extensions-dir'],
      sourceRepo: options['--source-repo'],
      sourceRef: options['--source-ref'],
      sourceCommit: options['--source-commit'],
    },
    {
      cwd: context.cwd,
      reloadExtensions: context.client.reloadExtensions?.bind(context.client),
      getExtensionErrors: context.client.getExtensionErrors?.bind(context.client),
    },
  );

  return {
    data: { repair: result },
    humanMessage: renderRepairHumanMessage(result),
  };
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
      throw new UnsupportedOperationError(
        'Live extension install is out of scope for this CLI seam. Use `modly ext stage github` to prepare a stage first.',
        { code: 'EXT_LIVE_INSTALL_OUT_OF_SCOPE' },
      );
    case 'apply':
      return runApply(context, args);
    case 'setup':
      return runSetup(context, args);
    case 'repair':
      return runRepair(context, args);
    default:
      throw new UsageError(`Unknown ext subcommand: ${subcommand}. Available: ${EXT_SUBCOMMANDS.join(', ')}.`);
  }
}
