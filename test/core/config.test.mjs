import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutomationCapabilitiesUrl } from '../../src/core/config.mjs';

test('resolveAutomationCapabilitiesUrl gives precedence to MODLY_AUTOMATION_URL', () => {
  const result = resolveAutomationCapabilitiesUrl({
    apiUrl: 'http://127.0.0.1:8765/api',
    automationUrl: 'https://bridge.modly.dev:9443/custom/base?source=env#bridge',
  });

  assert.equal(result, 'https://bridge.modly.dev:9443/automation/capabilities');
});

test('resolveAutomationCapabilitiesUrl falls back from MODLY_API_URL preserving protocol and hostname', () => {
  const result = resolveAutomationCapabilitiesUrl({
    apiUrl: 'https://modly.internal:8765/v1/runtime',
  });

  assert.equal(result, 'https://modly.internal:8766/automation/capabilities');
});

test('resolveAutomationCapabilitiesUrl ignores extra base path segments in fallback requests', () => {
  const result = resolveAutomationCapabilitiesUrl({
    apiUrl: 'http://example.local:8765/nested/base/path/',
  });

  assert.equal(result, 'http://example.local:8766/automation/capabilities');
});
