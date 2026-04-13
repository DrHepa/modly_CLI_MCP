#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const repoRoot = path.resolve(scriptDir, '..', '..');
const envFile = path.join(repoRoot, 'tools', '_tmp', 'modly_mcp', 'local.env');
const isWindows = process.platform === 'win32';

function parseEnvFile(content, filePath) {
  const parsed = {};
  const lines = content.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = rawLine.indexOf('=');

    if (equalsIndex <= 0) {
      throw new Error(`Invalid local.env entry at ${filePath}:${index + 1}. Expected KEY=VALUE.`);
    }

    const key = rawLine.slice(0, equalsIndex).trim();
    const value = rawLine.slice(equalsIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid local.env key at ${filePath}:${index + 1}: ${key}`);
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      parsed[key] = value.slice(1, -1);
      continue;
    }

    parsed[key] = value;
  }

  return parsed;
}

function canExecute(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateLocalBins() {
  const base = path.join(repoRoot, 'node_modules', '.bin');
  const names = isWindows ? ['modly-mcp.cmd', 'modly-mcp'] : ['modly-mcp'];
  return names.map((name) => path.join(base, name));
}

function resolveFromPath(commandName) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, extension && !commandName.endsWith(extension.toLowerCase()) ? `${commandName}${extension.toLowerCase()}` : commandName);
      if (existsSync(candidate) && canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveCommand() {
  for (const candidate of candidateLocalBins()) {
    if (existsSync(candidate) && canExecute(candidate)) {
      return {
        mode: 'local',
        command: candidate,
      };
    }
  }

  const globalCommand = resolveFromPath(isWindows ? 'modly-mcp.cmd' : 'modly-mcp');
  if (globalCommand) {
    return {
      mode: 'global',
      command: globalCommand,
    };
  }

  const sourceCheckoutHint = scriptFile.includes(`${path.sep}templates${path.sep}opencode${path.sep}`)
    ? ' This file is a template inside the source checkout; copy it into a consumer repo as tools/modly_mcp/run_server.mjs instead of pointing OpenCode at this checkout.'
    : '';

  throw new Error(
    `Could not resolve modly-mcp for repo root ${repoRoot}. Install modly-cli-mcp in the consumer repo so node_modules/.bin/modly-mcp exists, or install modly-cli-mcp globally so modly-mcp is available on PATH.${sourceCheckoutHint}`,
  );
}

function loadLocalEnv() {
  if (!existsSync(envFile)) {
    return {
      path: envFile,
      exists: false,
      values: {},
    };
  }

  const content = readFileSync(envFile, 'utf8');

  return {
    path: envFile,
    exists: true,
    values: parseEnvFile(content, envFile),
  };
}

function buildCheckResult({ ok, resolution, envState, error }) {
  return {
    ok,
    repoRoot,
    scriptFile,
    envFile: {
      path: envState.path,
      exists: envState.exists,
      appliedKeys: Object.keys(envState.values),
    },
    resolution: resolution
      ? {
          mode: resolution.mode,
          command: resolution.command,
        }
      : null,
    message: error ?? `Wrapper is ready. It would use ${resolution.mode} mode.`,
  };
}

async function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes('--check');
  const passthroughArgs = argv.filter((arg) => arg !== '--check');
  const envState = loadLocalEnv();

  try {
    const resolution = resolveCommand();

    if (checkOnly) {
      process.stdout.write(`${JSON.stringify(buildCheckResult({ ok: true, resolution, envState }), null, 2)}\n`);
      return 0;
    }

    const child = spawn(resolution.command, passthroughArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...envState.values,
      },
    });

    const forwardSignal = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };

    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);

    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        process.removeListener('SIGINT', forwardSignal);
        process.removeListener('SIGTERM', forwardSignal);

        if (signal) {
          process.kill(process.pid, signal);
          return;
        }

        resolve(code ?? 0);
      });
    });
  } catch (error) {
    if (checkOnly) {
      process.stdout.write(`${JSON.stringify(buildCheckResult({ ok: false, resolution: null, envState, error: error.message }), null, 2)}\n`);
      return 1;
    }

    throw error;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
