function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function detectBucket(manifest) {
  if (manifest?.process && typeof manifest.process === 'object') {
    return 'process-extension';
  }

  if (manifest?.setup && typeof manifest.setup === 'object') {
    return 'model-managed-setup';
  }

  return 'model-simple';
}

function buildMetadata(bucket, manifest) {
  const setupContract = normalizeString(manifest?.setup?.kind);

  if (bucket === 'process-extension') {
    return {
      resolution: 'local-manifest-analysis',
      implementation_profile: 'process-entrypoint',
      setup_contract: 'electron-workflow-required',
      support_state: 'planner-only',
      surface_owner: 'electron',
      headless_eligible: false,
      linux_arm64_risk: 'elevated',
    };
  }

  if (bucket === 'model-managed-setup') {
    return {
      resolution: 'local-manifest-analysis',
      implementation_profile: 'managed-setup',
      setup_contract: setupContract ?? 'declared-setup-contract',
      support_state: 'planner-only',
      surface_owner: 'electron',
      headless_eligible: false,
      linux_arm64_risk: 'unknown',
    };
  }

  return {
    resolution: 'local-manifest-analysis',
    implementation_profile: 'simple-manifest',
    setup_contract: 'none',
    support_state: 'planner-only',
    surface_owner: 'fastapi',
    headless_eligible: true,
    linux_arm64_risk: 'unknown',
  };
}

function buildIdentity(manifest) {
  return {
    planned: {
      manifest_id: normalizeString(manifest?.id),
      display_name: normalizeString(manifest?.name),
      version: normalizeString(manifest?.version),
      source: 'manifest.json',
    },
    live: {
      manifest_id: null,
      confirmed: false,
      source: 'unavailable',
    },
  };
}

export function classifyExtDevWorkspace(workspace) {
  const bucket = detectBucket(workspace?.manifest ?? {});

  return {
    bucket,
    metadata: buildMetadata(bucket, workspace?.manifest ?? {}),
    identity: buildIdentity(workspace?.manifest ?? {}),
  };
}
