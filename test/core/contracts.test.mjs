import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_GROUPS,
  EXECUTION_SURFACE_TAXONOMY,
  MCP_TOOL_IDS,
  MODLY_API_CONTRACT,
  PRIVATE_EXTENSION_CLI_SEAMS,
  SCENE_MESH_IMPORT_CONTRACT,
} from '../../src/core/contracts.mjs';

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

test('scene mesh import contract names the CLI group, MCP tool, capability, and Desktop bridge route', () => {
  assert.equal(SCENE_MESH_IMPORT_CONTRACT.capability, 'scene-mesh-import');
  assert.equal(SCENE_MESH_IMPORT_CONTRACT.cliGroup, 'scene');
  assert.equal(SCENE_MESH_IMPORT_CONTRACT.cliCommand, 'import-mesh');
  assert.equal(SCENE_MESH_IMPORT_CONTRACT.mcpToolId, 'modly.scene.importMesh');
  assert.deepEqual(SCENE_MESH_IMPORT_CONTRACT.bridge, {
    method: 'POST',
    path: '/scene/import-mesh',
  });
  assert.deepEqual(SCENE_MESH_IMPORT_CONTRACT.extensions, ['.glb', '.obj', '.stl', '.ply']);
});

test('scene mesh import constants are exposed without classifying it as a canonical run primitive', () => {
  assert.equal(COMMAND_GROUPS.includes('scene'), true);
  assert.equal(MCP_TOOL_IDS.includes('modly.scene.importMesh'), true);
  assert.deepEqual(MODLY_API_CONTRACT.importSceneMesh, { method: 'POST', path: '/scene/import-mesh' });

  const canonicalToolIds = EXECUTION_SURFACE_TAXONOMY.canonical.mcpToolIds;
  assert.equal(canonicalToolIds.includes('modly.scene.importMesh'), false);
});
