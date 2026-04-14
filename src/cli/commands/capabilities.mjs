import { UsageError } from '../../core/errors.mjs';

const CAPABILITIES_USAGE = 'Usage: modly capabilities [--api-url <url>] [--json]';

function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

function summarizeCapabilities(capabilities) {
  const backendReady = capabilities?.backend_ready === true;
  const modelsCount = countItems(capabilities?.models);
  const processesCount = countItems(capabilities?.processes);
  const errorsCount = countItems(capabilities?.errors);
  const excludedUiOnlyNodesCount = countItems(capabilities?.excluded?.ui_only_nodes);

  const summary = [
    `backend_ready=${backendReady ? 'true' : 'false'}`,
    `models=${modelsCount}`,
    `processes=${processesCount}`,
    `errors=${errorsCount}`,
    `excluded_ui_only_nodes=${excludedUiOnlyNodesCount}`,
  ].join(', ');

  if (backendReady) {
    return `Capabilities ready (${summary}).`;
  }

  return `Capabilities partial (${summary}; upstream reported partial availability).`;
}

export async function runCapabilitiesCommand(context) {
  if (context.args.length !== 0) {
    throw new UsageError(CAPABILITIES_USAGE);
  }

  const capabilities = await context.client.getAutomationCapabilities();

  return {
    data: capabilities,
    humanMessage: summarizeCapabilities(capabilities),
  };
}
