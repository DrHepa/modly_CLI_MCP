import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = [
  'modly.capabilities.get',
  'modly.capability.plan',
  'modly.capability.execute',
  'modly.health',
  'modly.model.list',
  'modly.model.current',
  'modly.model.params',
  'modly.ext.errors',
  'modly.config.paths.get',
  'modly.job.status',
  'modly.workflowRun.createFromImage',
  'modly.workflowRun.status',
  'modly.workflowRun.cancel',
  'modly.workflowRun.wait',
  'modly.processRun.create',
  'modly.processRun.status',
  'modly.processRun.wait',
  'modly.processRun.cancel',
];

test('stdio server advertises exactly the MVP tool catalog', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['./src/mcp/server.mjs'],
    cwd: process.cwd(),
    env: { MODLY_API_URL: 'http://127.0.0.1:8765' },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'modly-cli-mcp-tests', version: '0.1.0' });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    assert.deepEqual(names, EXPECTED_TOOLS);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
