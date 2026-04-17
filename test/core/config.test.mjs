import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAutomationCapabilitiesUrl,
  resolveProcessRunsUrl,
  resolveRuntimeConfig,
} from '../../src/core/config.mjs';

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

test('resolveProcessRunsUrl gives precedence to explicit processUrl over MODLY_PROCESS_URL', () => {
  const originalProcessUrl = process.env.MODLY_PROCESS_URL;
  process.env.MODLY_PROCESS_URL = 'https://env-bridge.modly.dev:9777/from-env?source=env#hash';

  try {
    const result = resolveProcessRunsUrl({
      apiUrl: 'http://127.0.0.1:8765/api',
      processUrl: 'https://explicit-bridge.modly.dev:9555/custom/base?source=explicit#bridge',
    });

    assert.equal(result, 'https://explicit-bridge.modly.dev:9555/');
  } finally {
    if (originalProcessUrl === undefined) {
      delete process.env.MODLY_PROCESS_URL;
    } else {
      process.env.MODLY_PROCESS_URL = originalProcessUrl;
    }
  }
});

test('resolveProcessRunsUrl falls back to MODLY_PROCESS_URL before deriving from apiUrl', () => {
  const originalProcessUrl = process.env.MODLY_PROCESS_URL;
  process.env.MODLY_PROCESS_URL = 'https://bridge.modly.dev:9443/custom/base?source=env#bridge';

  try {
    const result = resolveProcessRunsUrl({
      apiUrl: 'http://127.0.0.1:8765/api',
    });

    assert.equal(result, 'https://bridge.modly.dev:9443/');
  } finally {
    if (originalProcessUrl === undefined) {
      delete process.env.MODLY_PROCESS_URL;
    } else {
      process.env.MODLY_PROCESS_URL = originalProcessUrl;
    }
  }
});

test('resolveProcessRunsUrl derives the bridge origin from apiUrl and ignores extra path segments', () => {
  const originalProcessUrl = process.env.MODLY_PROCESS_URL;
  delete process.env.MODLY_PROCESS_URL;

  try {
    const result = resolveProcessRunsUrl({
      apiUrl: 'https://modly.internal:8765/nested/base/path/?via=api#runtime',
    });

    assert.equal(result, 'https://modly.internal:8766/');
  } finally {
    if (originalProcessUrl === undefined) {
      delete process.env.MODLY_PROCESS_URL;
    } else {
      process.env.MODLY_PROCESS_URL = originalProcessUrl;
    }
  }
});

test('resolveRuntimeConfig defaults experimentalRecipeExecution to false', () => {
  const config = resolveRuntimeConfig({ argv: [], env: {} });

  assert.equal(config.experimentalRecipeExecution, false);
});

test('resolveRuntimeConfig enables experimentalRecipeExecution from env opt-in', () => {
  const config = resolveRuntimeConfig({
    argv: [],
    env: { MODLY_EXPERIMENTAL_RECIPE_EXECUTE: 'true' },
  });

  assert.equal(config.experimentalRecipeExecution, true);
});

test('resolveRuntimeConfig gives explicit experimentalRecipeExecution override precedence over env', () => {
  const config = resolveRuntimeConfig({
    argv: [],
    env: { MODLY_EXPERIMENTAL_RECIPE_EXECUTE: 'false' },
    experimentalRecipeExecution: true,
  });

  assert.equal(config.experimentalRecipeExecution, true);
});
