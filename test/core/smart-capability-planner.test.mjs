import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapabilityGuidance, planSmartCapability } from '../../src/core/smart-capability-planner.mjs';

test('planner returns supported result with safe alias mapping and dropped unknown params', () => {
  const discovery = {
    models: [
      {
        id: 'triposg',
        name: 'TripoSG',
        params_schema: [
          { id: 'num_inference_steps' },
          { id: 'guidance_scale' },
        ],
      },
    ],
    processes: [],
  };

  const result = planSmartCapability({
    capability: 'TripoSG',
    params: {
      steps: 30,
      guidance: 7.5,
      unsupported_param: true,
    },
  }, discovery);

  assert.equal(result.status, 'supported');
  assert.equal(result.surface, 'workflowRun.createFromImage');
  assert.equal(result.score, 110);
  assert.deepEqual(result.cap, {
    key: 'triposg',
    requested: 'TripoSG',
    matchedId: 'triposg',
    matchedName: 'TripoSG',
  });
  assert.deepEqual(result.target, {
    kind: 'model',
    id: 'triposg',
    name: 'TripoSG',
  });
  assert.deepEqual(result.params, {
    num_inference_steps: 30,
    guidance_scale: 7.5,
  });
  assert.match(result.warnings[0], /unsupported_param/);
  assert.ok(result.reasons.some((reason) => reason.includes('Mapped alias "steps"')));
  assert.ok(result.reasons.some((reason) => reason.includes('Mapped alias "guidance"')));
});

test('planner returns supported for the allowlisted optimizer process only', () => {
  const discovery = {
    models: [],
    processes: [
      {
        id: 'mesh-optimizer/optimize',
        name: 'Optimize Mesh',
        params_schema: [
          { id: 'target_faces' },
        ],
      },
    ],
  };

  const result = planSmartCapability({
    capability: 'mesh optimizer',
    params: {
      targetFaces: 12000,
      ignored: true,
    },
  }, discovery);

  assert.equal(result.status, 'supported');
  assert.equal(result.surface, 'processRun.create');
  assert.equal(result.score, 105);
  assert.deepEqual(result.cap, {
    key: 'mesh-optimizer',
    requested: 'mesh optimizer',
    matchedId: 'mesh-optimizer/optimize',
    matchedName: 'Optimize Mesh',
  });
  assert.deepEqual(result.target, {
    kind: 'process',
    id: 'mesh-optimizer/optimize',
    name: 'Optimize Mesh',
  });
  assert.deepEqual(result.params, {
    target_faces: 12000,
  });
  assert.deepEqual(result.warnings, [
    'Discarded param "ignored": it is not an allowed canonical id or alias for "mesh-optimizer".',
  ]);
  assert.ok(result.reasons.some((reason) => reason.includes('Matched discovered id "mesh-optimizer/optimize" exactly.')));
  assert.ok(result.reasons.some((reason) => reason.includes('Mapped alias "targetFaces" to canonical param "target_faces"')));
});

test('planner returns supported for exporter only in the default-output safe slice', () => {
  const discovery = {
    models: [],
    processes: [
      {
        id: 'mesh-exporter/export',
        name: 'Mesh Exporter',
        params_schema: [
          { id: 'output_format' },
        ],
      },
    ],
  };

  const result = planSmartCapability({
    capability: 'mesh-exporter/export',
    params: { output_format: 'glb' },
  }, discovery);

  assert.deepEqual(result, {
    status: 'supported',
    cap: {
      key: 'mesh-exporter',
      requested: 'mesh-exporter/export',
      matchedId: 'mesh-exporter/export',
      matchedName: 'Mesh Exporter',
    },
    surface: 'processRun.create',
    target: {
      kind: 'process',
      id: 'mesh-exporter/export',
      name: 'Mesh Exporter',
    },
    score: 105,
    params: {
      output_format: 'glb',
    },
    warnings: [],
    reasons: [
      'Requested capability matched registry entry "mesh-exporter".',
      'Matched discovered id "mesh-exporter/export" exactly. Discovery confirms 1 requested canonical param(s).',
    ],
  });
});

test('planner keeps exporter outside support when params imply a custom output path', () => {
  const discovery = {
    models: [],
    processes: [
      {
        id: 'mesh-exporter/export',
        name: 'Mesh Exporter',
        params_schema: [
          { id: 'output_format' },
          { id: 'output_path' },
        ],
      },
    ],
  };

  const result = planSmartCapability({
    capability: 'mesh-exporter/export',
    params: {
      output_format: 'glb',
      output_path: 'exports/custom.glb',
    },
  }, discovery);

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.surface, 'processRun.create');
  assert.equal(result.score, 105);
  assert.equal(result.target, null);
  assert.deepEqual(result.cap, {
    key: 'mesh-exporter',
    requested: 'mesh-exporter/export',
    matchedId: 'mesh-exporter/export',
    matchedName: 'Mesh Exporter',
  });
  assert.deepEqual(result.params, {
    output_format: 'glb',
  });
  assert.ok(result.warnings.some((warning) => warning.includes('output_path')));
  assert.ok(result.reasons.some((reason) => reason.includes('default_output_only')));
});

test('planner keeps UniRig blocked even when discovery exposes a matching process', () => {
  const discovery = {
    models: [],
    processes: [
      {
        extension_id: 'unirig-process-extension',
        node_id: 'rig-mesh',
        name: 'Rig Mesh',
        params_schema: {
          seed: { type: 'int' },
        },
      },
    ],
  };

  const result = planSmartCapability({
    capability: 'UniRig',
    params: { seed: 12345 },
  }, discovery);

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.surface, 'processRun.create');
  assert.equal(result.target, null);
  assert.equal(result.score, 105);
  assert.deepEqual(result.cap, {
    key: 'unirig',
    requested: 'UniRig',
    matchedId: 'unirig-process-extension/rig-mesh',
    matchedName: 'Rig Mesh',
  });
  assert.deepEqual(result.params, { seed: 12345 });
  assert.ok(result.reasons.some((reason) => reason.includes('intentionally unavailable')));
  assert.ok(result.reasons.some((reason) => reason.includes('closed capability-execute allowlist')));
});

test('planner returns unknown for requests outside the closed registry', () => {
  const result = planSmartCapability({
    capability: 'mesh decimator pro',
    params: { seed: 7 },
  }, { models: [], processes: [] });

  assert.deepEqual(result, {
    status: 'unknown',
    cap: {
      key: null,
      requested: 'mesh decimator pro',
      matchedId: null,
      matchedName: null,
    },
    surface: null,
    target: null,
    score: null,
    params: {},
    warnings: ['Ignored params because the requested capability is outside the closed MVP registry.'],
    reasons: ['Requested capability did not match the closed smart-capability registry.'],
  });
});

test('planner ranks exact discovered matches above family matches deterministically', () => {
  const discovery = {
    models: [
      {
        id: 'community-hunyuan3d-fork',
        name: 'Community Hunyuan3D Fork',
        params_schema: [{ id: 'seed' }],
      },
      {
        id: 'hunyuan3d-mini',
        name: 'Hunyuan3D 2 Mini',
        params_schema: [{ id: 'seed' }],
      },
    ],
    processes: [],
  };

  const result = planSmartCapability({
    capability: 'hunyuan3d',
    params: { seed: 99 },
  }, discovery);

  assert.equal(result.status, 'supported');
  assert.equal(result.cap.matchedId, 'hunyuan3d-mini');
  assert.equal(result.cap.matchedName, 'Hunyuan3D 2 Mini');
  assert.deepEqual(result.target, {
    kind: 'model',
    id: 'hunyuan3d-mini',
    name: 'Hunyuan3D 2 Mini',
  });
  assert.equal(result.score, 105);
});

test('planner keeps known capability unavailable when discovery lacks an executable candidate', () => {
  const result = planSmartCapability({
    capability: 'Hunyuan3D',
    params: { quality: 40 },
  }, {
    models: [
      {
        id: 'triposg',
        name: 'TripoSG',
        params_schema: [{ id: 'num_inference_steps' }],
      },
    ],
    processes: [],
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.cap.key, 'hunyuan3d');
  assert.equal(result.cap.matchedId, null);
  assert.equal(result.target, null);
  assert.equal(result.score, null);
  assert.deepEqual(result.params, {});
  assert.deepEqual(result.warnings, [
    'Discarded param "quality": canonical param "num_inference_steps" is not available in discovery params_schema.',
  ]);
  assert.ok(result.reasons.some((reason) => reason.includes('matched registry entry "hunyuan3d"')));
  assert.ok(result.reasons.some((reason) => reason.includes('Discovery did not expose an executable candidate')));
});

test('planner accepts canonical params directly and keeps alias mapping limited to allowed ids', () => {
  const discovery = {
    models: [
      {
        id: 'hunyuan3d',
        name: 'Hunyuan3D',
        params_schema: [
          { id: 'num_inference_steps' },
          { id: 'seed' },
        ],
      },
    ],
    processes: [],
  };

  const result = planSmartCapability({
    capability: 'Hunyuan3D',
    params: {
      num_inference_steps: 25,
      steps: 40,
      prompt: 'dragon',
      seed: 7,
    },
  }, discovery);

  assert.equal(result.status, 'supported');
  assert.deepEqual(result.target, {
    kind: 'model',
    id: 'hunyuan3d',
    name: 'Hunyuan3D',
  });
  assert.deepEqual(result.params, {
    num_inference_steps: 40,
    seed: 7,
  });
  assert.deepEqual(result.warnings, [
    'Discarded param "prompt": it is not an allowed canonical id or alias for "hunyuan3d".',
  ]);
  assert.ok(result.reasons.some((reason) => reason.includes('Mapped alias "steps" to canonical param "num_inference_steps"')));
  assert.equal(result.reasons.some((reason) => reason.includes('Mapped alias "prompt"')), false);
});

test('guidance returns supported_now with observable surface and live safe params', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'TripoSG',
    params: {
      steps: 30,
      guidance: 7.5,
      unsupported_param: true,
    },
  }, {
    models: [
      {
        id: 'triposg',
        name: 'TripoSG',
        params_schema: [
          { id: 'num_inference_steps' },
          { id: 'guidance_scale' },
        ],
      },
    ],
    processes: [],
  });

  assert.equal(result.status, 'supported_now');
  assert.equal(result.capability_key, 'triposg');
  assert.equal(result.surface, 'workflowRun');
  assert.deepEqual(result.target, {
    kind: 'model',
    id: 'triposg',
    name: 'TripoSG',
  });
  assert.deepEqual(result.available_safe_params, {
    allowed: {
      canonical_ids: ['num_inference_steps', 'guidance_scale', 'foreground_ratio', 'faces', 'seed', 'use_flash_decoder'],
      aliases: {
        cfg: 'guidance_scale',
        decoder: 'use_flash_decoder',
        fg_ratio: 'foreground_ratio',
        foreground_ratio: 'foreground_ratio',
        guidance: 'guidance_scale',
        inference_steps: 'num_inference_steps',
        max_faces: 'faces',
        seed: 'seed',
        steps: 'num_inference_steps',
      },
    },
    available_now: {
      canonical_ids: ['num_inference_steps', 'guidance_scale'],
      aliases: {
        cfg: 'guidance_scale',
        guidance: 'guidance_scale',
        inference_steps: 'num_inference_steps',
        steps: 'num_inference_steps',
      },
    },
  });
  assert.ok(result.warnings.some((warning) => warning.includes('unsupported_param')));
  assert.deepEqual(result.discovered_extras, []);
});

test('guidance returns known process capability with processRun surface', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'mesh optimizer',
  }, {
    models: [],
    processes: [
      {
        id: 'mesh-optimizer/optimize',
        name: 'Optimize Mesh',
        params_schema: [
          { id: 'target_faces' },
        ],
      },
    ],
  });

  assert.equal(result.status, 'supported_now');
  assert.equal(result.capability_key, 'mesh-optimizer');
  assert.equal(result.surface, 'processRun');
  assert.deepEqual(result.target, {
    kind: 'process',
    id: 'mesh-optimizer/optimize',
    name: 'Optimize Mesh',
  });
  assert.deepEqual(result.available_safe_params.available_now, {
    canonical_ids: ['target_faces'],
    aliases: {
      targetFaces: 'target_faces',
    },
  });
  assert.ok(result.reasons.some((reason) => reason.includes('mesh-optimizer/optimize')));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.discovered_extras, []);
});

test('guidance exposes scene mesh import as discovery-only Desktop bridge capability', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'scene-mesh-import',
  }, {
    scene: {
      import_mesh: {
        supported: true,
        endpoint: '/scene/import-mesh',
        method: 'POST',
        extensions: ['.glb', '.obj'],
      },
    },
  });

  assert.equal(result.status, 'supported_now');
  assert.equal(result.capability_key, 'scene-mesh-import');
  assert.equal(result.surface, 'desktopBridge');
  assert.deepEqual(result.target, {
    kind: 'scene',
    id: 'scene.import_mesh',
    name: 'Scene Mesh Import',
  });
  assert.deepEqual(result.available_safe_params, {
    allowed: { canonical_ids: [], aliases: {} },
    available_now: { canonical_ids: [], aliases: {} },
  });
  assert.ok(result.reasons.some((reason) => reason.includes('Desktop bridge advertises scene.import_mesh support')));
});

test('planner keeps scene mesh import outside capability.execute dispatch even when bridge advertises it', () => {
  const result = planSmartCapability({
    capability: 'import mesh to scene',
  }, {
    scene: {
      import_mesh: {
        supported: true,
        endpoint: '/scene/import-mesh',
        method: 'POST',
      },
    },
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.surface, 'desktopBridge.importSceneMesh');
  assert.equal(result.target, null);
  assert.deepEqual(result.cap, {
    key: 'scene-mesh-import',
    requested: 'import mesh to scene',
    matchedId: 'scene.import_mesh',
    matchedName: 'Scene Mesh Import',
  });
  assert.deepEqual(result.params, {});
  assert.ok(result.reasons.some((reason) => reason.includes('read-only guidance')));
  assert.ok(result.reasons.some((reason) => reason.includes('does not dispatch Desktop scene mutations')));
});

test('guidance classification stays explicit across supported_now, known_but_unavailable, and discovered_only', () => {
  const supportedNow = evaluateCapabilityGuidance({
    capability: 'TripoSG',
    params: { steps: 30, decoder: true },
  }, {
    models: [
      {
        id: 'triposg',
        name: 'TripoSG',
        params_schema: [
          { id: 'num_inference_steps' },
        ],
      },
    ],
    processes: [],
  });

  const knownButUnavailable = evaluateCapabilityGuidance({
    capability: 'Hunyuan3D',
    params: { quality: 40, steps: 12 },
  }, {
    models: [],
    processes: [],
  });

  const discoveredOnly = evaluateCapabilityGuidance({
    capability: 'mesh decimator pro',
  }, {
    models: [],
    processes: [
      {
        id: 'mesh-decimator/pro',
        name: 'Mesh Decimator Pro',
        params_schema: [{ id: 'target_faces' }],
      },
    ],
  });

  assert.equal(supportedNow.status, 'supported_now');
  assert.deepEqual(supportedNow.available_safe_params.available_now, {
    canonical_ids: ['num_inference_steps'],
    aliases: {
      inference_steps: 'num_inference_steps',
      steps: 'num_inference_steps',
    },
  });
  assert.deepEqual(supportedNow.target, {
    kind: 'model',
    id: 'triposg',
    name: 'TripoSG',
  });
  assert.ok(supportedNow.warnings.some((warning) => warning.includes('decoder')));

  assert.equal(knownButUnavailable.status, 'known_but_unavailable');
  assert.equal(knownButUnavailable.surface, 'none');
  assert.equal(knownButUnavailable.target, null);
  assert.deepEqual(knownButUnavailable.available_safe_params.available_now, {
    canonical_ids: [],
    aliases: {},
  });
  assert.ok(knownButUnavailable.warnings.some((warning) => warning.includes('num_inference_steps')));

  assert.equal(discoveredOnly.status, 'discovered_only');
  assert.equal(discoveredOnly.capability_key, null);
  assert.equal(discoveredOnly.surface, 'none');
  assert.equal(discoveredOnly.target, null);
});

test('guidance keeps UniRig as known_but_unavailable with surface none', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'UniRig',
    params: { seed: 12345 },
  }, {
    models: [],
    processes: [
      {
        extension_id: 'unirig-process-extension',
        node_id: 'rig-mesh',
        name: 'Rig Mesh',
        params_schema: {
          seed: { type: 'int' },
        },
      },
    ],
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.capability_key, 'unirig');
  assert.equal(result.surface, 'none');
  assert.equal(result.target, null);
  assert.deepEqual(result.available_safe_params.available_now, {
    canonical_ids: ['seed'],
    aliases: {
      seed: 'seed',
    },
  });
  assert.ok(result.reasons.some((reason) => reason.includes('intentionally unavailable')));
  assert.ok(result.reasons.some((reason) => reason.includes('closed capability-execute allowlist')));
});

test('guidance keeps exporter known but unavailable when params request a custom output path', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'mesh-exporter/export',
    params: {
      output_format: 'glb',
      output_path: 'exports/custom.glb',
    },
  }, {
    models: [],
    processes: [
      {
        id: 'mesh-exporter/export',
        name: 'Mesh Exporter',
        params_schema: [
          { id: 'output_format' },
          { id: 'output_path' },
        ],
      },
    ],
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.capability_key, 'mesh-exporter');
  assert.equal(result.surface, 'none');
  assert.equal(result.target, null);
  assert.deepEqual(result.available_safe_params, {
    allowed: { canonical_ids: ['output_format'], aliases: {} },
    available_now: { canonical_ids: ['output_format'], aliases: {} },
  });
  assert.ok(result.reasons.some((reason) => reason.includes('default_output_only')));
  assert.ok(result.warnings.some((warning) => warning.includes('output_path')));
  assert.deepEqual(result.discovered_extras, []);
});

test('guidance does not auto-select tied candidates and keeps surface none', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'Hunyuan3D',
    params: { seed: 99 },
  }, {
    models: [
      {
        id: 'community-hunyuan3d-mini-a',
        name: 'Community Hunyuan3D Mini A',
        params_schema: [{ id: 'seed' }],
      },
      {
        id: 'community-hunyuan3d-mini-b',
        name: 'Community Hunyuan3D Mini B',
        params_schema: [{ id: 'seed' }],
      },
    ],
    processes: [],
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.capability_key, 'hunyuan3d');
  assert.equal(result.surface, 'none');
  assert.equal(result.target, null);
  assert.deepEqual(result.available_safe_params.available_now, {
    canonical_ids: ['seed'],
    aliases: {
      seed: 'seed',
    },
  });
  assert.ok(result.warnings.some((warning) => warning.includes('multiple equivalent candidates')));
  assert.ok(result.reasons.some((reason) => reason.includes('remain tied')));
});

test('guidance exposes discovered supplemental mesh inputs as process-run-only guidance', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'fixture-trellis/refine',
    params: { mesh_path: 'meshes/source.glb' },
  }, {
    models: [],
    processes: [
      {
        id: 'fixture-trellis/refine',
        name: 'Fixture Trellis Refine',
        params_schema: { type: 'object', properties: {} },
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
  });

  assert.equal(result.status, 'discovered_only');
  assert.equal(result.surface, 'processRun');
  assert.deepEqual(result.target, {
    kind: 'process',
    id: 'fixture-trellis/refine',
    name: 'Fixture Trellis Refine',
  });
  assert.deepEqual(result.supplemental_inputs.map((input) => ({
    location: input.location,
    provenance: input.provenance,
    execution_surfaces: input.execution_surfaces,
    unsupported_surfaces: input.unsupported_surfaces,
    safety: input.safety,
  })), [
    {
      location: 'params.mesh_path',
      provenance: 'backend_enriched_schema',
      execution_surfaces: ['processRun.create', 'cli.process-run'],
      unsupported_surfaces: ['capability.execute'],
      safety: { rejectAbsolute: true, rejectTraversal: true, workspaceRelative: true },
    },
  ]);
  assert.ok(result.warnings.some((warning) => warning.includes('capability.execute is not supported')));
  assert.ok(result.reasons.some((reason) => reason.includes('processRun.create')));
});

test('planner reports discovered supplemental mesh inputs without marking capability.execute supported', () => {
  const result = planSmartCapability({
    capability: 'fixture-trellis/refine',
    params: { mesh_path: 'meshes/source.glb' },
  }, {
    models: [],
    processes: [
      {
        extension_id: 'fixture-trellis',
        node_id: 'refine',
        name: 'Fixture Trellis Refine',
        params_schema: { type: 'object', properties: {} },
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
              execution_surfaces: ['processRun.create'],
              unsupported_surfaces: ['capability.execute'],
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.surface, 'processRun.create');
  assert.deepEqual(result.target, {
    kind: 'process',
    id: 'fixture-trellis/refine',
    name: 'Fixture Trellis Refine',
  });
  assert.deepEqual(result.params, { mesh_path: 'meshes/source.glb' });
  assert.deepEqual(result.supplemental_inputs.map((input) => input.location), ['params.mesh_path']);
  assert.ok(result.warnings.some((warning) => warning.includes('capability.execute is not supported')));
  assert.equal(result.reasons.some((reason) => reason.includes('supported')), false);
});

test('guidance exposes Trellis2 refine as a backend-runtime model with curated supplemental mesh and image inputs', () => {
  const result = evaluateCapabilityGuidance({
    capability: 'trellis2/refine',
    params: { mesh_path: 'meshes/source.glb', image_path: 'images/albedo.png' },
  }, {
    models: [
      {
        id: 'trellis2/refine',
        name: 'Texture Mesh',
        kind: 'model',
        source: 'backend-runtime',
        version: '1.0.4',
        params_schema: { type: 'object', properties: {} },
      },
    ],
    processes: [],
  });

  assert.equal(result.status, 'discovered_only');
  assert.equal(result.surface, 'none');
  assert.deepEqual(result.target, {
    kind: 'model',
    id: 'trellis2/refine',
    name: 'Texture Mesh',
  });
  assert.deepEqual(result.supplemental_inputs.map((input) => ({
    location: input.location,
    provenance: input.provenance,
    source: input.source,
    execution_surfaces: input.execution_surfaces,
    unsupported_surfaces: input.unsupported_surfaces,
  })), [
    {
      location: 'params.mesh_path',
      provenance: 'verified_runtime_behavior',
      source: 'curated_verified_runtime',
      execution_surfaces: ['backend-runtime.model'],
      unsupported_surfaces: ['capability.execute', 'processRun.create'],
    },
    {
      location: 'params.image_path',
      provenance: 'verified_runtime_behavior',
      source: 'curated_verified_runtime',
      execution_surfaces: ['backend-runtime.model'],
      unsupported_surfaces: ['capability.execute', 'processRun.create'],
    },
  ]);
  assert.ok(result.reasons.some((reason) => reason.includes('backend-runtime model')));
  assert.equal(result.reasons.some((reason) => reason.includes('processRun.create')), false);
  assert.ok(result.warnings.some((warning) => warning.includes('capability.execute is not supported')));
});

test('planner keeps Trellis2 refine conservative and unavailable for capability.execute', () => {
  const result = planSmartCapability({
    capability: 'trellis2/refine',
    params: { mesh_path: 'meshes/source.glb', image_path: 'images/albedo.png' },
  }, {
    models: [
      {
        id: 'trellis2/refine',
        name: 'Texture Mesh',
        kind: 'model',
        source: 'backend-runtime',
        version: '1.0.4',
        params_schema: { type: 'object', properties: {} },
      },
    ],
    processes: [],
  });

  assert.equal(result.status, 'known_but_unavailable');
  assert.equal(result.surface, 'none');
  assert.deepEqual(result.target, {
    kind: 'model',
    id: 'trellis2/refine',
    name: 'Texture Mesh',
  });
  assert.deepEqual(result.params, {
    mesh_path: 'meshes/source.glb',
    image_path: 'images/albedo.png',
  });
  assert.deepEqual(result.supplemental_inputs.map((input) => input.location), ['params.mesh_path', 'params.image_path']);
  assert.equal(result.reasons.some((reason) => reason.includes('processRun')), false);
  assert.ok(result.warnings.some((warning) => warning.includes('capability.execute is not supported')));
});
