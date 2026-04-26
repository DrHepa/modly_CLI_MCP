import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderHelp, renderCapabilitiesHelp } from '../../src/cli/help.mjs';
import { runCapabilitiesCommand } from '../../src/cli/commands/capabilities.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('help advertises capabilities in global and command-specific output', () => {
  assert.match(renderHelp(), /capabilities\s+Discovers automation capabilities/u);
  assert.match(renderCapabilitiesHelp(), /modly capabilities/u);
  assert.match(renderCapabilitiesHelp(), /without a separate \/health preflight/u);

  const result = spawnSync(process.execPath, ['src/cli/index.mjs', 'capabilities', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /modly capabilities/u);
  assert.match(result.stdout, /canonical payload inside data/u);
});

test('capabilities command returns canonical payload for JSON passthrough without preflight health', async () => {
  const calls = [];
  const payload = {
    backend_ready: true,
    source: 'automation-capabilities',
    errors: [],
    excluded: { ui_only_nodes: ['ui-preview'] },
    models: [{ id: 'model-a' }, { id: 'model-b' }],
    processes: [{ id: 'generate.from-image' }],
  };
  const result = await runCapabilitiesCommand({
    args: [],
    client: {
      async health() {
        calls.push('health');
        throw new Error('health should not be called');
      },
      async getAutomationCapabilities() {
        calls.push('getAutomationCapabilities');
        return payload;
      },
    },
  });

  assert.deepEqual(calls, ['getAutomationCapabilities']);
  assert.deepEqual(result.data, payload);
  assert.match(result.humanMessage, /Capabilities ready/u);
});

test('capabilities in human mode succeeds with backend_ready=false and reports partial readiness', async () => {
  const calls = [];
  const payload = {
    backend_ready: false,
    source: 'automation-capabilities',
    errors: [{ code: 'BACKEND_STARTING' }],
    excluded: { ui_only_nodes: ['node-a', 'node-b'] },
    models: [{ id: 'model-a' }],
    processes: [{ id: 'generate.from-image' }, { id: 'workflow-run.from-image' }],
  };
  const result = await runCapabilitiesCommand({
    args: [],
    client: {
      async getAutomationCapabilities() {
        calls.push('getAutomationCapabilities');
        return payload;
      },
    },
  });

  assert.deepEqual(calls, ['getAutomationCapabilities']);
  assert.deepEqual(result.data, payload);
  assert.match(result.humanMessage, /Capabilities partial/u);
  assert.match(result.humanMessage, /backend_ready=false/u);
  assert.match(result.humanMessage, /models=1/u);
  assert.match(result.humanMessage, /processes=2/u);
  assert.match(result.humanMessage, /errors=1/u);
  assert.match(result.humanMessage, /excluded_ui_only_nodes=2/u);
});
