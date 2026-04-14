#!/usr/bin/env node

import { resolveRuntimeConfig } from '../core/config.mjs';
import { EXIT_CODES } from '../core/contracts.mjs';
import { NotFoundError, UsageError, normalizeError } from '../core/errors.mjs';
import { createModlyApiClient } from '../core/modly-api.mjs';
import { runCapabilitiesCommand } from './commands/capabilities.mjs';
import { runConfigCommand } from './commands/config.mjs';
import { runExtCommand } from './commands/ext.mjs';
import { runGenerateCommand } from './commands/generate.mjs';
import { runHealthCommand } from './commands/health.mjs';
import { runJobCommand } from './commands/job.mjs';
import { runMeshCommand } from './commands/mesh.mjs';
import { runModelCommand } from './commands/model.mjs';
import { runProcessRunCommand } from './commands/process-run.mjs';
import { runWorkflowRunCommand } from './commands/workflow-run.mjs';
import {
  renderCapabilitiesHelp,
  renderConfigHelp,
  renderExtHelp,
  renderGenerateHelp,
  renderHelp,
  renderJobHelp,
  renderMeshHelp,
  renderModelHelp,
  renderProcessRunHelp,
  renderWorkflowRunHelp,
} from './help.mjs';

const commandHandlers = {
  capabilities: runCapabilitiesCommand,
  health: runHealthCommand,
  model: runModelCommand,
  generate: runGenerateCommand,
  job: runJobCommand,
  'process-run': runProcessRunCommand,
  'workflow-run': runWorkflowRunCommand,
  mesh: runMeshCommand,
  ext: runExtCommand,
  config: runConfigCommand,
};

const commandHelpRenderers = {
  capabilities: renderCapabilitiesHelp,
  model: renderModelHelp,
  generate: renderGenerateHelp,
  job: renderJobHelp,
  'process-run': renderProcessRunHelp,
  'workflow-run': renderWorkflowRunHelp,
  mesh: renderMeshHelp,
  ext: renderExtHelp,
  config: renderConfigHelp,
};

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitSuccess(result, config) {
  if (config.json) {
    writeJson({
      ok: true,
      data: result.data ?? {},
      meta: {
        apiUrl: config.apiUrl,
      },
    });
    return;
  }

  process.stdout.write(`${result.humanMessage ?? 'OK'}\n`);
}

function emitError(error, config) {
  if (config.json) {
    writeJson({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
      meta: {
        apiUrl: config.apiUrl,
      },
    });
    return;
  }

  process.stderr.write(`[${error.code}] ${error.message}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const config = resolveRuntimeConfig({ argv });

  if (config.positionals.length === 0) {
    process.stdout.write(renderHelp());
    return EXIT_CODES.SUCCESS;
  }

  if (config.help) {
    const [group] = config.positionals;
    const renderCommandHelp = commandHelpRenderers[group];

    process.stdout.write(renderCommandHelp ? renderCommandHelp() : renderHelp());
    return EXIT_CODES.SUCCESS;
  }

  const [group, ...args] = config.positionals;
  const handler = commandHandlers[group];

  if (!handler) {
    throw new UsageError(`Unknown command group: ${group}`);
  }

  const client = createModlyApiClient({ apiUrl: config.apiUrl });
  const result = await handler({ config, args, client });

  emitSuccess(result, config);
  return EXIT_CODES.SUCCESS;
}

try {
  const exitCode = await main();
  process.exitCode = exitCode;
} catch (error) {
  const normalized = normalizeError(error);

  if (normalized instanceof UsageError || normalized instanceof NotFoundError) {
    emitError(normalized, resolveRuntimeConfig({ argv: process.argv.slice(2) }));
  } else {
    emitError(normalized, resolveRuntimeConfig({ argv: process.argv.slice(2) }));
  }

  process.exitCode = normalized.exitCode ?? EXIT_CODES.FAILURE;
}
