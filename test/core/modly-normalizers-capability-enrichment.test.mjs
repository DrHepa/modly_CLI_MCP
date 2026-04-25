import test from 'node:test';
import assert from 'node:assert/strict';

import { toAutomationCapabilities } from '../../src/core/modly-normalizers.mjs';

test('toAutomationCapabilities attaches supplemental inputs without mutating process params_schema', () => {
  const paramsSchema = Object.freeze({
    type: 'object',
    required: Object.freeze(['seed']),
    properties: Object.freeze({
      seed: Object.freeze({ type: 'integer' }),
    }),
  });
  const payload = {
    backend_ready: true,
    source: 'desktop-bridge',
    errors: [],
    excluded: {},
    models: [],
    processes: [
      {
        id: 'fixture-trellis/refine',
        name: 'Fixture Trellis Refine',
        params_schema: paramsSchema,
        enriched_schema: {
          supplemental_inputs: [
            {
              name: 'mesh_path',
              location: 'params.mesh_path',
              type: 'string',
              format: 'workspace-relative-path',
              required: true,
              provenance: 'backend_enriched_schema',
              verified: true,
              source: 'fixture-backend',
              safety: { rejectAbsolute: true, rejectTraversal: true, workspaceRelative: true },
              execution_surfaces: ['processRun.create', 'cli.process-run'],
              unsupported_surfaces: ['capability.execute'],
            },
          ],
        },
      },
    ],
    scene: {},
  };

  const normalized = toAutomationCapabilities(payload);

  assert.equal(normalized.processes[0].params_schema, paramsSchema);
  assert.deepEqual(normalized.processes[0].declared_inputs.map((input) => input.location), ['params.seed']);
  assert.deepEqual(normalized.processes[0].supplemental_inputs, [
    {
      name: 'mesh_path',
      location: 'params.mesh_path',
      type: 'string',
      format: 'workspace-relative-path',
      required: true,
      source: 'fixture-backend',
      provenance: 'backend_enriched_schema',
      verified: true,
      available: true,
      safety: { rejectAbsolute: true, rejectTraversal: true, workspaceRelative: true },
      execution_surfaces: ['processRun.create', 'cli.process-run'],
      unsupported_surfaces: ['capability.execute'],
    },
  ]);
  assert.deepEqual(normalized.processes[0].enriched_inputs.map((input) => input.location), ['params.seed', 'params.mesh_path']);
});

test('toAutomationCapabilities keeps vague mesh labels and unsafe metadata out of supplemental inputs', () => {
  const normalized = toAutomationCapabilities({
    backend_ready: true,
    source: 'desktop-bridge',
    errors: [],
    excluded: {},
    models: [],
    processes: [
      {
        id: 'ambiguous/refine',
        name: 'Refine Mesh from hidden input',
        params_schema: { type: 'object', properties: {} },
        enriched_schema: {
          supplemental_inputs: [
            { input: 'mesh' },
            {
              name: 'mesh_path',
              location: 'params.mesh_path',
              type: 'string',
              provenance: 'unknown',
              verified: true,
              safety: { rejectAbsolute: true, rejectTraversal: true, workspaceRelative: true },
            },
          ],
        },
      },
    ],
  });

  assert.deepEqual(normalized.processes[0].supplemental_inputs, []);
  assert.deepEqual(normalized.processes[0].enriched_inputs, []);
  assert.deepEqual(normalized.processes[0].warnings, [
    'ignored vague mesh metadata without explicit field contract',
    'ignored unsafe supplemental input params.mesh_path with provenance unknown',
  ]);
});

test('toAutomationCapabilities adds curated Trellis2 refine model supplemental mesh and image inputs without mutating params_schema', () => {
  const paramsSchema = Object.freeze({
    type: 'object',
    properties: Object.freeze({
      seed: Object.freeze({ type: 'integer' }),
    }),
  });

  const normalized = toAutomationCapabilities({
    backend_ready: true,
    source: 'desktop-bridge',
    errors: [],
    excluded: {},
    models: [
      {
        id: 'trellis2/refine',
        name: 'Texture Mesh',
        kind: 'model',
        source: 'backend-runtime',
        version: '1.0.4',
        params_schema: paramsSchema,
      },
    ],
    processes: [],
  });

  assert.equal(normalized.models[0].params_schema, paramsSchema);
  assert.deepEqual(normalized.models[0].declared_inputs.map((input) => input.location), ['params.seed']);
  assert.deepEqual(normalized.models[0].supplemental_inputs.map((input) => ({
    name: input.name,
    location: input.location,
    type: input.type,
    format: input.format,
    provenance: input.provenance,
    source: input.source,
    execution_surfaces: input.execution_surfaces,
    unsupported_surfaces: input.unsupported_surfaces,
    applies_to: input.applies_to,
  })), [
    {
      name: 'mesh_path',
      location: 'params.mesh_path',
      type: 'string',
      format: 'workspace-relative-path',
      provenance: 'verified_runtime_behavior',
      source: 'curated_verified_runtime',
      execution_surfaces: ['backend-runtime.model'],
      unsupported_surfaces: ['capability.execute', 'processRun.create'],
      applies_to: { kind: 'model', ids: ['trellis2/refine'] },
    },
    {
      name: 'image_path',
      location: 'params.image_path',
      type: 'string',
      format: 'workspace-relative-path',
      provenance: 'verified_runtime_behavior',
      source: 'curated_verified_runtime',
      execution_surfaces: ['backend-runtime.model'],
      unsupported_surfaces: ['capability.execute', 'processRun.create'],
      applies_to: { kind: 'model', ids: ['trellis2/refine'] },
    },
  ]);
  assert.deepEqual(normalized.models[0].enriched_inputs.map((input) => input.location), [
    'params.seed',
    'params.mesh_path',
    'params.image_path',
  ]);
});
