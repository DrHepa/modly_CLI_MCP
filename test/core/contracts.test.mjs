import test from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_SURFACE_TAXONOMY, PRIVATE_EXTENSION_CLI_SEAMS } from '../../src/core/contracts.mjs';

test('EXECUTION_SURFACE_TAXONOMY classifies visible execution surfaces into canonical, wrapper, and legacy buckets', () => {
  assert.deepEqual(EXECUTION_SURFACE_TAXONOMY, {
    canonical: {
      label: 'canonical run primitive',
      cliGroups: ['process-run', 'workflow-run'],
      mcpToolIds: [
        'modly.workflowRun.createFromImage',
        'modly.workflowRun.status',
        'modly.workflowRun.cancel',
        'modly.workflowRun.wait',
        'modly.processRun.create',
        'modly.processRun.status',
        'modly.processRun.wait',
        'modly.processRun.cancel',
      ],
    },
    wrapper: {
      label: 'orchestration wrapper',
      cliGroups: [],
      mcpToolIds: ['modly.capability.execute', 'modly.recipe.execute'],
    },
    legacy: {
      label: 'legacy compatibility',
      cliGroups: ['generate', 'job'],
      mcpToolIds: ['modly.job.status'],
    },
  });
});

test('EXECUTION_SURFACE_TAXONOMY keeps every visible execution surface in exactly one bucket and excludes read-only tools', () => {
  const allCliGroups = Object.values(EXECUTION_SURFACE_TAXONOMY).flatMap((entry) => entry.cliGroups);
  const allMcpToolIds = Object.values(EXECUTION_SURFACE_TAXONOMY).flatMap((entry) => entry.mcpToolIds);

  assert.equal(new Set(allCliGroups).size, allCliGroups.length);
  assert.equal(new Set(allMcpToolIds).size, allMcpToolIds.length);
  assert.equal(allMcpToolIds.includes('modly.capability.plan'), false);
  assert.equal(allMcpToolIds.includes('modly.capability.guide'), false);
  assert.equal(allMcpToolIds.includes('modly.diagnostic.guidance'), false);
  assert.equal(allMcpToolIds.includes('modly.recipe.catalog'), false);
});

test('PRIVATE_EXTENSION_CLI_SEAMS documents setup as CLI-only and absent from the stable public taxonomy', () => {
  assert.deepEqual(PRIVATE_EXTENSION_CLI_SEAMS, ['setup']);

  const allCliGroups = Object.values(EXECUTION_SURFACE_TAXONOMY).flatMap((entry) => entry.cliGroups);
  const allMcpToolIds = Object.values(EXECUTION_SURFACE_TAXONOMY).flatMap((entry) => entry.mcpToolIds);

  assert.equal(allCliGroups.includes('setup'), false);
  assert.equal(allMcpToolIds.includes('modly.ext.setup'), false);
});
