import test from 'node:test';
import assert from 'node:assert/strict';
import { planSmartCapability } from '../../src/core/smart-capability-planner.mjs';

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
  assert.deepEqual(result.params, {
    num_inference_steps: 30,
    guidance_scale: 7.5,
  });
  assert.match(result.warnings[0], /unsupported_param/);
  assert.ok(result.reasons.some((reason) => reason.includes('Mapped alias "steps"')));
  assert.ok(result.reasons.some((reason) => reason.includes('Mapped alias "guidance"')));
});

test('planner keeps UniRig as known_but_unavailable while reusing discovered params_schema object', () => {
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
  assert.equal(result.score, 105);
  assert.deepEqual(result.cap, {
    key: 'unirig',
    requested: 'UniRig',
    matchedId: 'unirig-process-extension/rig-mesh',
    matchedName: 'Rig Mesh',
  });
  assert.deepEqual(result.params, { seed: 12345 });
  assert.ok(result.reasons.some((reason) => reason.includes('intentionally unavailable')));
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
