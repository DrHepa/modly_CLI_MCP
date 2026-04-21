import { UsageError } from '../../core/errors.mjs';
import { planLocalExtDev } from '../../core/ext-dev/planner.mjs';

const EXT_DEV_SUBCOMMANDS = Object.freeze(['bucket-detect', 'preflight', 'scaffold', 'audit', 'release-plan']);
const EXT_DEV_USAGE = 'Usage: modly ext-dev <bucket-detect|preflight|scaffold|audit|release-plan> [--api-url <url>] [--json]';

function buildHumanMessage(subcommand, plan) {
  if (subcommand === 'scaffold') {
    return `ext-dev scaffold: ${plan.bucket} implementation plan ready (non-executable).`;
  }

  if (subcommand === 'release-plan') {
    return `ext-dev release-plan: ${plan.bucket} ordered checklist ready (non-executable).`;
  }

  return `ext-dev ${subcommand}: ${plan.bucket} plan-only.`;
}

export async function runExtDevCommand(context) {
  const [subcommand, ...rest] = context.args;

  if (!subcommand) {
    throw new UsageError(EXT_DEV_USAGE);
  }

  if (rest.length > 0) {
    throw new UsageError(EXT_DEV_USAGE);
  }

  if (!EXT_DEV_SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(`Unknown ext-dev subcommand: ${subcommand}. Available: ${EXT_DEV_SUBCOMMANDS.join(', ')}.`);
  }

  const plan = await planLocalExtDev({
    cwd: context.cwd,
    workspace: '.',
    command: subcommand,
    client: context.client,
  });

  return {
    data: {
      plan,
    },
    humanMessage: buildHumanMessage(subcommand, plan),
  };
}

export { EXT_DEV_SUBCOMMANDS, EXT_DEV_USAGE };
