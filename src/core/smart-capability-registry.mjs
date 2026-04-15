function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return value;
}

export const KNOWN_CAPABILITIES = deepFreeze([
  {
    key: 'triposg',
    labels: ['triposg', 'tripo sg', 'TripoSG'],
    target: {
      kind: 'model',
      surface: 'workflowRun.createFromImage',
      ids: ['triposg'],
      names: ['TripoSG'],
    },
    availability: 'discovery_based',
    safeParams: {
      canonicalIds: [
        'num_inference_steps',
        'guidance_scale',
        'foreground_ratio',
        'faces',
        'seed',
        'use_flash_decoder',
      ],
      aliases: {
        steps: 'num_inference_steps',
        inference_steps: 'num_inference_steps',
        guidance: 'guidance_scale',
        cfg: 'guidance_scale',
        fg_ratio: 'foreground_ratio',
        foreground_ratio: 'foreground_ratio',
        max_faces: 'faces',
        decoder: 'use_flash_decoder',
        seed: 'seed',
      },
    },
  },
  {
    key: 'hunyuan3d',
    labels: ['hunyuan3d', 'hunyuan 3d', 'Hunyuan3D', 'Hunyuan3D 2 Mini', 'hunyuan3d-mini'],
    target: {
      kind: 'model',
      surface: 'workflowRun.createFromImage',
      ids: ['hunyuan3d', 'hunyuan3d-mini'],
      names: ['Hunyuan3D', 'Hunyuan3D 2 Mini'],
    },
    availability: 'discovery_based',
    safeParams: {
      canonicalIds: [
        'num_inference_steps',
        'octree_resolution',
        'guidance_scale',
        'seed',
      ],
      aliases: {
        quality: 'num_inference_steps',
        steps: 'num_inference_steps',
        resolution: 'octree_resolution',
        octree: 'octree_resolution',
        guidance: 'guidance_scale',
        cfg: 'guidance_scale',
        seed: 'seed',
      },
    },
  },
  {
    key: 'unirig',
    labels: ['unirig', 'uni rig', 'UniRig', 'Rig Mesh', 'rig mesh'],
    target: {
      kind: 'process',
      surface: 'processRun.create',
      ids: ['unirig-process-extension/rig-mesh'],
      names: ['UniRig', 'Rig Mesh'],
    },
    availability: 'known_unavailable_mvp',
    safeParams: {
      canonicalIds: ['seed'],
      aliases: {
        seed: 'seed',
      },
    },
  },
]);

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
    : '';
}

export function findKnownCapability(requestedCapability) {
  const normalizedRequested = normalizeText(requestedCapability);

  if (normalizedRequested === '') {
    return null;
  }

  return KNOWN_CAPABILITIES.find((capability) => {
    if (normalizeText(capability.key) === normalizedRequested) {
      return true;
    }

    return capability.labels.some((label) => normalizeText(label) === normalizedRequested);
  }) ?? null;
}
