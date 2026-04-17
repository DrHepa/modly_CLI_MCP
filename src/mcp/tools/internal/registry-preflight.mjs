import { BackendUnavailableError } from '../../../core/errors.mjs';

export const PREFLIGHT_EXEMPT_TOOLS = new Set([
  'modly.capabilities.get',
  'modly.capability.plan',
  'modly.capability.guide',
  'modly.diagnostic.guidance',
  'modly.capability.execute',
  'modly.health',
]);

export async function assertBackendReady({ client, toolName }) {
  try {
    await client.health();
  } catch (error) {
    throw new BackendUnavailableError('Modly backend is unavailable.', {
      cause: error,
      details: { tool: toolName, check: '/health' },
    });
  }
}
