import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMeshPathSupplementalInput,
  enrichCapabilitySchema,
} from '../../src/core/capability-schema-enrichment.mjs';

test('enrichCapabilitySchema separates declared params from verified supplemental inputs without mutating params_schema', () => {
  const paramsSchema = Object.freeze({
    type: 'object',
    required: ['image_path'],
    properties: Object.freeze({
      image_path: Object.freeze({ type: 'string', description: 'Input image' }),
    }),
  });
  const capability = Object.freeze({
    kind: 'process',
    id: 'fixture-trellis/refine',
    params_schema: paramsSchema,
    enriched_schema: Object.freeze({
      supplemental_inputs: Object.freeze([
        Object.freeze({
          name: 'mesh_path',
          location: 'params.mesh_path',
          type: 'string',
          format: 'workspace-relative-path',
          required: true,
          provenance: 'backend_enriched_schema',
          verified: true,
          source: 'backend',
          safety: Object.freeze({ rejectAbsolute: true, rejectTraversal: true, workspaceRelative: true }),
          execution_surfaces: Object.freeze(['processRun.create']),
          unsupported_surfaces: Object.freeze(['capability.execute']),
        }),
      ]),
    }),
  });

  const enriched = enrichCapabilitySchema(capability);

  assert.deepEqual(enriched.params_schema, paramsSchema);
  assert.deepEqual(enriched.declared_inputs, [
    {
      name: 'image_path',
      location: 'params.image_path',
      type: 'string',
      format: undefined,
      required: true,
      source: 'params_schema',
      provenance: 'declared_schema',
      verified: true,
      available: true,
      safety: {},
      execution_surfaces: [],
      unsupported_surfaces: [],
    },
  ]);
  assert.deepEqual(enriched.supplemental_inputs, [
    {
      name: 'mesh_path',
      location: 'params.mesh_path',
      type: 'string',
      format: 'workspace-relative-path',
      required: true,
      source: 'backend',
      provenance: 'backend_enriched_schema',
      verified: true,
      available: true,
      safety: { rejectAbsolute: true, rejectTraversal: true, workspaceRelative: true },
      execution_surfaces: ['processRun.create'],
      unsupported_surfaces: ['capability.execute'],
    },
  ]);
  assert.deepEqual(enriched.enriched_inputs.map((input) => input.location), ['params.image_path', 'params.mesh_path']);
  assert.deepEqual(capability.params_schema, paramsSchema);
});

test('enrichCapabilitySchema fails closed for unknown, stale, conflicting, or vague mesh metadata', () => {
  const capability = {
    kind: 'process',
    id: 'ambiguous-mesh/process',
    label: 'Refine mesh using hidden mesh input',
    params_schema: {
      type: 'object',
      required: ['mesh_path'],
      properties: {
        mesh_path: { type: 'number' },
      },
    },
    enriched_schema: {
      supplemental_inputs: [
        createMeshPathSupplementalInput({
          provenance: 'backend_enriched_schema',
          source: 'backend',
          verified: false,
        }),
        createMeshPathSupplementalInput({
          provenance: 'unknown',
          source: 'runtime_probe',
          verified: true,
        }),
        { input: 'mesh' },
        createMeshPathSupplementalInput({
          provenance: 'backend_enriched_schema',
          source: 'backend',
          verified: true,
        }),
      ],
    },
  };

  const enriched = enrichCapabilitySchema(capability);

  assert.deepEqual(enriched.supplemental_inputs, [
    {
      ...createMeshPathSupplementalInput({
        provenance: 'backend_enriched_schema',
        source: 'backend',
        verified: true,
      }),
      available: false,
      warnings: ['conflicts with declared params_schema at params.mesh_path; supplemental input unavailable'],
    },
  ]);
  assert.deepEqual(enriched.enriched_inputs.map((input) => input.location), ['params.mesh_path']);
  assert.deepEqual(enriched.warnings, [
    'ignored unverified supplemental input params.mesh_path from backend',
    'ignored unsafe supplemental input params.mesh_path with provenance unknown',
    'ignored vague mesh metadata without explicit field contract',
    'conflicts with declared params_schema at params.mesh_path; supplemental input unavailable',
  ]);
});

test('enrichCapabilitySchema applies explicit verified overrides by exact fixture identity only', () => {
  const override = createMeshPathSupplementalInput({
    source: 'curated',
    provenance: 'verified_runtime_override',
    applies_to: { kind: 'process', ids: ['fixture-trellis/refine'] },
  });

  const matched = enrichCapabilitySchema(
    { kind: 'process', id: 'fixture-trellis/refine', label: 'Trellis Refine', params_schema: { type: 'object', properties: {} } },
    { supplementalInputOverrides: [override] },
  );
  const labelOnly = enrichCapabilitySchema(
    { kind: 'process', id: 'other/refine', label: 'fixture-trellis/refine', params_schema: { type: 'object', properties: {} } },
    { supplementalInputOverrides: [override] },
  );

  assert.deepEqual(matched.supplemental_inputs, [override]);
  assert.deepEqual(matched.enriched_inputs.map((input) => input.location), ['params.mesh_path']);
  assert.deepEqual(labelOnly.supplemental_inputs, []);
  assert.deepEqual(labelOnly.enriched_inputs, []);
});
