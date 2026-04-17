export async function runHealthPreflight(modlyClient) {
  return modlyClient.health();
}

export async function loadAutomationCapabilities(modlyClient) {
  return modlyClient.getAutomationCapabilities();
}

export async function prepareAutomationContext(modlyClient) {
  const health = await runHealthPreflight(modlyClient);
  const capabilities = await loadAutomationCapabilities(modlyClient);
  return { health, capabilities };
}
