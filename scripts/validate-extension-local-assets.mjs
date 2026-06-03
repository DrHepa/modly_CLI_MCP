#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildNotCheckedReport, validateExtensionLocalAssets } from '../src/core/extension-local-assets-validation.mjs';

function parseArgs(argv) {
  const parsed = { pretty: false, modlyHome: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      continue;
    }
    if (arg === '--pretty') {
      parsed.pretty = true;
      continue;
    }
    if (arg === '--modly-home') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('usage: --modly-home requires a value');
      }
      parsed.modlyHome = value;
      index += 1;
      continue;
    }
    throw new Error(`usage: unsupported argument ${arg}`);
  }
  return parsed;
}

async function loadLibrary() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const libraryPath = path.join(repoRoot, 'docs', 'extension-dependency-library', 'library.json');
  return JSON.parse(await readFile(libraryPath, 'utf8'));
}

function rootFrom(parsed, env) {
  if (parsed.modlyHome) {
    return { modlyHome: parsed.modlyHome, rootSource: 'argument' };
  }
  if (env.MODLY_HOME) {
    return { modlyHome: env.MODLY_HOME, rootSource: 'environment' };
  }
  return { modlyHome: null, rootSource: 'not_supplied' };
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  const library = await loadLibrary();
  const root = rootFrom(parsed, process.env);
  const report = root.modlyHome
    ? await validateExtensionLocalAssets({ library, modlyHome: root.modlyHome, rootSource: root.rootSource })
    : buildNotCheckedReport({ library, rootSource: 'not_supplied' });
  process.stdout.write(`${JSON.stringify(report, null, parsed.pretty ? 2 : 0)}\n`);
} catch (error) {
  process.stderr.write(`validate-extension-local-assets failed: ${error.message.replace(/\/[^\s]*/gu, '<redacted-path>')}\n`);
  process.exitCode = 2;
}
