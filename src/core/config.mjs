import { DEFAULT_API_URL } from './contracts.mjs';
import { UsageError } from './errors.mjs';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';

export function resolveAutomationCapabilitiesUrl({ apiUrl = DEFAULT_API_URL, automationUrl } = {}) {
  const url = new URL(automationUrl ?? apiUrl);

  if (!automationUrl) {
    url.port = '8766';
  }

  url.pathname = '/automation/capabilities';
  url.search = '';
  url.hash = '';

  return url.toString();
}

export function resolveProcessRunsUrl({
  apiUrl = DEFAULT_API_URL,
  processUrl = process.env.MODLY_PROCESS_URL,
} = {}) {
  const url = new URL(processUrl ?? apiUrl);

  if (!processUrl) {
    url.port = '8766';
  }

  url.pathname = '/';
  url.search = '';
  url.hash = '';

  return url.toString();
}

function resolveExperimentalRecipeExecutionFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

export function resolveRecipeWorkflowCatalogDir({ catalogDir } = {}) {
  if (typeof catalogDir !== 'string' || catalogDir.trim() === '') {
    return null;
  }

  const resolvedDir = path.resolve(catalogDir.trim());

  try {
    if (!statSync(resolvedDir).isDirectory()) {
      return null;
    }

    const hasJsonWorkflow = readdirSync(resolvedDir, { withFileTypes: true }).some(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'),
    );

    return hasJsonWorkflow ? resolvedDir : null;
  } catch {
    return null;
  }
}

export function parseGlobalOptions(argv = []) {
  const options = {
    apiUrl: undefined,
    json: false,
    help: false,
  };

  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--json') {
      options.json = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    if (token === '--api-url') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new UsageError('Expected a value after --api-url.');
      }

      options.apiUrl = value;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function resolveRuntimeConfig({
  argv = [],
  env = process.env,
  experimentalRecipeExecution,
} = {}) {
  const { options, positionals } = parseGlobalOptions(argv);

  return {
    apiUrl: options.apiUrl ?? env.MODLY_API_URL ?? DEFAULT_API_URL,
    json: options.json,
    help: options.help,
    argv,
    positionals,
    experimentalRecipeExecution:
      experimentalRecipeExecution ?? resolveExperimentalRecipeExecutionFlag(env.MODLY_EXPERIMENTAL_RECIPE_EXECUTE),
    recipeWorkflowCatalogDir: resolveRecipeWorkflowCatalogDir({
      catalogDir: env.MODLY_RECIPE_WORKFLOW_CATALOG_DIR,
    }),
  };
}
