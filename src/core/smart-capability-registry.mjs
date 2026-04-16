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
    capabilityExecuteSupported: true,
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
    capabilityExecuteSupported: true,
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
    key: 'mesh-optimizer',
    labels: ['mesh optimizer', 'optimize mesh', 'mesh optimize', 'mesh-optimizer/optimize'],
    target: {
      kind: 'process',
      surface: 'processRun.create',
      ids: ['mesh-optimizer/optimize'],
      names: ['Optimize Mesh', 'Mesh Optimizer'],
    },
    availability: 'discovery_based',
    capabilityExecuteSupported: true,
    safeParams: {
      canonicalIds: ['target_faces'],
      aliases: {
        targetFaces: 'target_faces',
      },
    },
  },
  {
    key: 'mesh-exporter',
    labels: ['mesh exporter', 'export mesh', 'mesh-exporter/export'],
    target: {
      kind: 'process',
      surface: 'processRun.create',
      ids: ['mesh-exporter/export'],
      names: ['Mesh Exporter'],
    },
    availability: 'discovery_based',
    capabilityExecuteSupported: true,
    safeExecution: {
      mode: 'default_output_only',
      blockedParamIds: ['output_path'],
    },
    safeParams: {
      canonicalIds: ['output_format'],
      aliases: {},
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
    capabilityExecuteSupported: false,
    safeParams: {
      canonicalIds: ['seed'],
      aliases: {
        seed: 'seed',
      },
    },
  },
]);

export const OBSERVABLE_MVP_SURFACES = deepFreeze({
  'workflowRun.createFromImage': 'workflowRun',
  'processRun.create': 'processRun',
});

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

export function getObservableMvpSurface(surface) {
  const normalizedSurface = typeof surface === 'string' ? surface.trim() : '';
  return OBSERVABLE_MVP_SURFACES[normalizedSurface] ?? 'none';
}

export function getCapabilityGuideMetadata(requestedCapability) {
  const capability = findKnownCapability(requestedCapability);

  if (capability === null) {
    return null;
  }

  return deepFreeze({
    key: capability.key,
    availability: capability.availability,
    capabilityExecuteSupported: capability.capabilityExecuteSupported === true,
    target: {
      kind: capability.target.kind,
      observableSurface: getObservableMvpSurface(capability.target.surface),
      ids: [...capability.target.ids],
      names: [...capability.target.names],
    },
    safeExecution: capability.safeExecution
      ? {
        mode: capability.safeExecution.mode,
        blockedParamIds: [...capability.safeExecution.blockedParamIds],
      }
      : null,
    safeParams: {
      canonicalIds: [...capability.safeParams.canonicalIds],
      aliases: { ...capability.safeParams.aliases },
    },
  });
}
