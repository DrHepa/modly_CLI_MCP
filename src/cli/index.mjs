#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { resolveRuntimeConfig } from '../core/config.mjs';
import { EXIT_CODES } from '../core/contracts.mjs';
import { NotFoundError, UsageError, extractErrorEnvelope, normalizeError } from '../core/errors.mjs';
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

function writeJson(payload, stdout = process.stdout) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitSuccess(result, config, { stdout = process.stdout } = {}) {
  if (config.json) {
    writeJson({
      ok: true,
      data: result.data ?? {},
      meta: {
        apiUrl: config.apiUrl,
      },
    }, stdout);
    return;
  }

  stdout.write(`${result.humanMessage ?? 'OK'}\n`);
}

function emitError(error, config, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (config.json) {
    const envelope = extractErrorEnvelope(error);
    writeJson({
      ok: false,
      error: {
        code: envelope.code,
        message: envelope.message,
        ...(Object.keys(envelope.details).length > 0 ? { details: envelope.details } : {}),
      },
      meta: {
        apiUrl: config.apiUrl,
      },
    }, stdout);
    return;
  }

  stderr.write(`[${error.code}] ${error.message}\n`);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const config = resolveRuntimeConfig({
    argv,
    env,
    experimentalRecipeExecution: deps.experimentalRecipeExecution,
  });

  if (config.positionals.length === 0) {
    stdout.write(renderHelp());
    return EXIT_CODES.SUCCESS;
  }

  if (config.help) {
    const [group] = config.positionals;
    const renderCommandHelp = (deps.commandHelpRenderers ?? commandHelpRenderers)[group];

    stdout.write(renderCommandHelp ? renderCommandHelp() : renderHelp());
    return EXIT_CODES.SUCCESS;
  }

  const [group, ...args] = config.positionals;
  const handler = (deps.commandHandlers ?? commandHandlers)[group];

  if (!handler) {
    throw new UsageError(`Unknown command group: ${group}`);
  }

  const createClient = deps.createClient ?? createModlyApiClient;
  const client = createClient({ apiUrl: config.apiUrl });
  const result = await handler({
    config,
    args,
    client,
    cwd: deps.cwd ?? process.cwd(),
    env,
    platform: deps.platform ?? process.platform,
    stageGitHubExtension: deps.stageGitHubExtension,
    applyStagedExtension: deps.applyStagedExtension,
    tmpdir: deps.tmpdir,
    spawnImpl: deps.spawnImpl,
  });

  emitSuccess(result, config, { stdout });
  return EXIT_CODES.SUCCESS;
}

async function runCliEntrypoint() {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    const normalized = normalizeError(error);
    emitError(normalized, resolveRuntimeConfig({ argv: process.argv.slice(2), env: process.env }));
    process.exitCode = normalized.exitCode ?? EXIT_CODES.FAILURE;
  }
}

function isCliEntrypoint(entryFileUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }

  try {
    return entryFileUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return entryFileUrl === pathToFileURL(argv1).href;
  }
}

if (isCliEntrypoint()) {
  await runCliEntrypoint();
}
