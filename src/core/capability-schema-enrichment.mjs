const SAFE_PROVENANCE = new Set([
  'backend_enriched_schema',
  'verified_runtime_override',
  'verified_runtime_behavior',
]);

const DEFAULT_MESH_PATH_SAFETY = {
  rejectAbsolute: true,
  rejectTraversal: true,
  workspaceRelative: true,
};

const TRELLIS2_REFINE_MODEL_INPUT_SURFACES = ['backend-runtime.model'];
const TRELLIS2_REFINE_UNSUPPORTED_SURFACES = ['capability.execute', 'processRun.create'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function inputKey(input) {
  return `${input.location}`;
}

function normalizeCapabilityId(capability) {
  const extensionId = normalizeString(capability?.extension_id) ?? normalizeString(capability?.extensionId);
  const nodeId = normalizeString(capability?.node_id) ?? normalizeString(capability?.nodeId);

  if (extensionId !== undefined && nodeId !== undefined) {
    return `${extensionId}/${nodeId}`;
  }

  return normalizeString(capability?.id)
    ?? normalizeString(capability?.process_id)
    ?? normalizeString(capability?.processId)
    ?? normalizeString(capability?.model_id)
    ?? normalizeString(capability?.modelId);
}

function declaredInputFromProperty(name, schema, requiredNames) {
  return {
    name,
    location: `params.${name}`,
    type: normalizeString(schema?.type),
    format: normalizeString(schema?.format),
    required: requiredNames.has(name),
    source: 'params_schema',
    provenance: 'declared_schema',
    verified: true,
    available: true,
    safety: {},
    execution_surfaces: [],
    unsupported_surfaces: [],
  };
}

function declaredInputFromArrayEntry(entry) {
  const name = normalizeString(entry?.id) ?? normalizeString(entry?.name);

  if (name === undefined) {
    return null;
  }

  return {
    name,
    location: normalizeString(entry?.location) ?? `params.${name}`,
    type: normalizeString(entry?.type),
    format: normalizeString(entry?.format),
    required: normalizeBoolean(entry?.required, false),
    source: 'params_schema',
    provenance: 'declared_schema',
    verified: true,
    available: true,
    safety: {},
    execution_surfaces: [],
    unsupported_surfaces: [],
  };
}

export function extractDeclaredInputs(paramsSchema) {
  if (Array.isArray(paramsSchema)) {
    return paramsSchema.map(declaredInputFromArrayEntry).filter((entry) => entry !== null);
  }

  if (!isObject(paramsSchema?.properties)) {
    return [];
  }

  const requiredNames = new Set(asArray(paramsSchema.required).filter((name) => typeof name === 'string'));

  return Object.entries(paramsSchema.properties).map(([name, schema]) => (
    declaredInputFromProperty(name, schema, requiredNames)
  ));
}

export function createMeshPathSupplementalInput(overrides = {}) {
  return createWorkspacePathSupplementalInput('mesh_path', overrides);
}

export function createImagePathSupplementalInput(overrides = {}) {
  return createWorkspacePathSupplementalInput('image_path', overrides);
}

function createWorkspacePathSupplementalInput(name, overrides = {}) {
  return {
    name,
    location: `params.${name}`,
    type: 'string',
    format: 'workspace-relative-path',
    required: true,
    source: overrides.source ?? 'curated',
    provenance: overrides.provenance ?? 'verified_runtime_override',
    verified: overrides.verified ?? true,
    available: overrides.available ?? true,
    safety: { ...DEFAULT_MESH_PATH_SAFETY, ...(isObject(overrides.safety) ? overrides.safety : {}) },
    execution_surfaces: [...(overrides.execution_surfaces ?? ['processRun.create'])],
    unsupported_surfaces: [...(overrides.unsupported_surfaces ?? ['capability.execute'])],
    ...(isObject(overrides.applies_to) ? { applies_to: { ...overrides.applies_to } } : {}),
  };
}

const CURATED_SUPPLEMENTAL_INPUT_OVERRIDES = [
  createMeshPathSupplementalInput({
    source: 'curated_verified_runtime',
    provenance: 'verified_runtime_behavior',
    execution_surfaces: TRELLIS2_REFINE_MODEL_INPUT_SURFACES,
    unsupported_surfaces: TRELLIS2_REFINE_UNSUPPORTED_SURFACES,
    applies_to: { kind: 'model', ids: ['trellis2/refine'] },
  }),
  createImagePathSupplementalInput({
    source: 'curated_verified_runtime',
    provenance: 'verified_runtime_behavior',
    execution_surfaces: TRELLIS2_REFINE_MODEL_INPUT_SURFACES,
    unsupported_surfaces: TRELLIS2_REFINE_UNSUPPORTED_SURFACES,
    applies_to: { kind: 'model', ids: ['trellis2/refine'] },
  }),
];

function appliesToCapability(input, capability) {
  if (!isObject(input.applies_to)) {
    return true;
  }

  if (normalizeString(input.applies_to.kind) !== undefined && input.applies_to.kind !== capability?.kind) {
    return false;
  }

  const capabilityId = normalizeCapabilityId(capability);
  const ids = asArray(input.applies_to.ids);

  return ids.length === 0 || ids.includes(capabilityId);
}

function hasExplicitFieldContract(input) {
  return normalizeString(input?.name) !== undefined
    && normalizeString(input?.location) !== undefined
    && normalizeString(input?.type) !== undefined
    && isObject(input?.safety);
}

function normalizeSupplementalInput(input) {
  return {
    name: normalizeString(input.name),
    location: normalizeString(input.location),
    type: normalizeString(input.type),
    format: normalizeString(input.format),
    required: normalizeBoolean(input.required, false),
    source: normalizeString(input.source) ?? 'backend',
    provenance: normalizeString(input.provenance) ?? 'unknown',
    verified: normalizeBoolean(input.verified, false),
    available: normalizeBoolean(input.available, true),
    safety: { ...(isObject(input.safety) ? input.safety : {}) },
    execution_surfaces: [...asArray(input.execution_surfaces)],
    unsupported_surfaces: [...asArray(input.unsupported_surfaces)],
    ...(isObject(input.applies_to) ? { applies_to: { ...input.applies_to } } : {}),
  };
}

function collectSupplementalCandidates(capability, supplementalInputOverrides) {
  const backendInputs = asArray(capability?.enriched_schema?.supplemental_inputs);
  const matchingOverrides = [
    ...CURATED_SUPPLEMENTAL_INPUT_OVERRIDES,
    ...asArray(supplementalInputOverrides),
  ].filter((input) => appliesToCapability(input, capability));

  return [...backendInputs, ...matchingOverrides];
}

function isCompatibleSupplemental(declared, supplemental) {
  if (declared.type !== undefined && supplemental.type !== undefined && declared.type !== supplemental.type) {
    return false;
  }

  if (declared.required !== supplemental.required) {
    return false;
  }

  if (declared.format !== undefined && supplemental.format !== undefined && declared.format !== supplemental.format) {
    return false;
  }

  return true;
}

function appendWarning(input, warning) {
  return {
    ...input,
    available: false,
    warnings: [...asArray(input.warnings), warning],
  };
}

export function enrichCapabilitySchema(capability, options = {}) {
  const declaredInputs = extractDeclaredInputs(capability?.params_schema);
  const declaredByLocation = new Map(declaredInputs.map((input) => [inputKey(input), input]));
  const warnings = [];
  const supplementalInputs = [];

  for (const candidate of collectSupplementalCandidates(capability, options.supplementalInputOverrides)) {
    if (!hasExplicitFieldContract(candidate)) {
      if (candidate?.input === 'mesh') {
        warnings.push('ignored vague mesh metadata without explicit field contract');
      }
      continue;
    }

    const normalized = normalizeSupplementalInput(candidate);

    if (normalized.verified !== true) {
      warnings.push(`ignored unverified supplemental input ${normalized.location} from ${normalized.source}`);
      continue;
    }

    if (!SAFE_PROVENANCE.has(normalized.provenance)) {
      warnings.push(`ignored unsafe supplemental input ${normalized.location} with provenance ${normalized.provenance}`);
      continue;
    }

    const declared = declaredByLocation.get(inputKey(normalized));

    if (declared !== undefined && !isCompatibleSupplemental(declared, normalized)) {
      const warning = `conflicts with declared params_schema at ${normalized.location}; supplemental input unavailable`;
      warnings.push(warning);
      supplementalInputs.push(appendWarning(normalized, warning));
      continue;
    }

    supplementalInputs.push(normalized);
  }

  const enrichedInputs = [
    ...declaredInputs,
    ...supplementalInputs.filter((input) => input.available === true && !declaredByLocation.has(inputKey(input))),
  ];

  return {
    ...capability,
    declared_inputs: declaredInputs,
    supplemental_inputs: supplementalInputs,
    enriched_inputs: enrichedInputs,
    warnings,
  };
}
