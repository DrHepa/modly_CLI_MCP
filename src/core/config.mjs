import { DEFAULT_API_URL } from './contracts.mjs';
import { UsageError } from './errors.mjs';

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

export function resolveRuntimeConfig({ argv = [], env = process.env } = {}) {
  const { options, positionals } = parseGlobalOptions(argv);

  return {
    apiUrl: options.apiUrl ?? env.MODLY_API_URL ?? DEFAULT_API_URL,
    json: options.json,
    help: options.help,
    argv,
    positionals,
  };
}
