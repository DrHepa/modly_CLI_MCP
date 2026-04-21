import { classifyExtDevWorkspace } from './classification.mjs';
import { buildExtDevEvidence } from './evidence.mjs';
import { resolveExtDevWorkspace } from './workspace.mjs';

const FASTAPI_EVIDENCE_COMMANDS = new Set(['preflight']);
const BRIDGE_CONFIRMATION_COMMANDS = new Set(['audit']);

function createPlanStep(order, id, title, owner, reason) {
  return {
    order,
    id,
    title,
    owner,
    executable: false,
    ...(reason ? { reason } : {}),
  };
}

function buildGaps(identity) {
  const gaps = [];

  if (!identity.live.confirmed) {
    gaps.push('live-identity-unconfirmed');
  }

  if (identity.live.collision === true) {
    gaps.push('live-identity-collision');
  }

  return gaps;
}

function buildRisks(bucket, metadata, identity) {
  const risks = [];

  if (metadata.surface_owner === 'electron') {
    risks.push('electron-owned-surface');
  }

  if (bucket === 'process-extension' || metadata.linux_arm64_risk === 'elevated') {
    risks.push('linux-arm64-compatibility');
  }

  if (identity.live.collision === true) {
    risks.push('live-identity-collision');
  }

  return risks;
}

function buildNextSteps(metadata, identity) {
  const nextSteps = [];

  if (!identity.live.confirmed) {
    nextSteps.push('Confirm live identity through bridge/Electron only when available.');
  }

  if (identity.live.collision === true) {
    nextSteps.push('Resolve the bridge-reported identity collision before any runtime execution.');
  }

  if (metadata.surface_owner === 'electron') {
    nextSteps.push('Review Electron-owned setup/workflow implications before execution.');
  }

  return nextSteps;
}

function buildScaffoldPlan(bucket, _metadata) {
  if (bucket === 'process-extension') {
    return {
      kind: 'non-executable-implementation-plan',
      executable: false,
      summary: 'Ordered scaffold plan for an Electron-owned process extension without executing setup, build, or release.',
      steps: [
        createPlanStep(1, 'validate-manifest-contract', 'Validate manifest metadata and bucket assumptions.', 'local'),
        createPlanStep(2, 'document-electron-workflow', 'Document the Electron-owned workflow hand-off required before runtime execution.', 'electron', 'Surface remains electron-owned and non-headless.'),
        createPlanStep(3, 'record-local-test-seams', 'Record local test seams and evidence gaps before implementation.', 'local'),
      ],
    };
  }

  if (bucket === 'model-managed-setup') {
    return {
      kind: 'non-executable-implementation-plan',
      executable: false,
      summary: 'Ordered scaffold plan for a managed-setup extension without executing setup or install flows.',
      steps: [
        createPlanStep(1, 'validate-manifest-contract', 'Validate manifest metadata and declared setup contract.', 'local'),
        createPlanStep(2, 'document-electron-setup-contract', 'Document the Electron-owned setup contract and manual hand-off points.', 'electron', 'Managed setup remains Electron-owned in V1.'),
        createPlanStep(3, 'record-local-test-seams', 'Record local test seams and evidence gaps before implementation.', 'local'),
      ],
    };
  }

  return {
    kind: 'non-executable-implementation-plan',
    executable: false,
    summary: 'Ordered scaffold plan for a simple extension without executing build, install, or release steps.',
    steps: [
      createPlanStep(1, 'validate-manifest-contract', 'Validate manifest metadata and bucket assumptions.', 'local'),
      createPlanStep(2, 'draft-fastapi-surface', 'Draft the FastAPI-owned interface and payload boundaries implied by the manifest.', 'fastapi'),
      createPlanStep(3, 'record-local-test-seams', 'Record local test seams and evidence gaps before implementation.', 'local'),
    ],
  };
}

function buildReleasePlan(bucket) {
  if (bucket === 'process-extension') {
    return {
      kind: 'ordered-release-checklist',
      executable: false,
      summary: 'An ordered release checklist for documentation and hand-off only; no publish, install, or repair actions are executed.',
      checklist: [
        createPlanStep(1, 'freeze-manifest-contract', 'Freeze manifest identifiers, version, and bucket evidence for the release draft.', 'local'),
        createPlanStep(2, 'prepare-release-notes', 'Prepare release notes capturing bucket, risks, and remaining evidence gaps.', 'local'),
        createPlanStep(3, 'document-electron-workflow-hand-off', 'Document the Electron workflow hand-off required before any real runtime execution.', 'electron', 'Process extensions stay Electron-owned in V1.'),
      ],
    };
  }

  if (bucket === 'model-managed-setup') {
    return {
      kind: 'ordered-release-checklist',
      executable: false,
      summary: 'An ordered release checklist for documentation and hand-off only; no publish, install, or repair actions are executed.',
      checklist: [
        createPlanStep(1, 'freeze-manifest-contract', 'Freeze manifest identifiers, version, and bucket evidence for the release draft.', 'local'),
        createPlanStep(2, 'prepare-release-notes', 'Prepare release notes capturing bucket, risks, and remaining evidence gaps.', 'local'),
        createPlanStep(3, 'document-electron-setup-hand-off', 'Document the Electron-managed setup hand-off required before runtime execution.', 'electron', 'Managed setup stays Electron-owned in V1.'),
      ],
    };
  }

  return {
    kind: 'ordered-release-checklist',
    executable: false,
    summary: 'An ordered release checklist for documentation and hand-off only; no publish, install, or repair actions are executed.',
    checklist: [
      createPlanStep(1, 'freeze-manifest-contract', 'Freeze manifest identifiers, version, and bucket evidence for the release draft.', 'local'),
      createPlanStep(2, 'prepare-release-notes', 'Prepare release notes capturing bucket, risks, and remaining evidence gaps.', 'local'),
      createPlanStep(3, 'record-runtime-hand-off', 'Record the FastAPI runtime hand-off boundaries without executing any runtime action.', 'fastapi'),
    ],
  };
}

function buildCommandPlan(command, bucket, metadata) {
  if (command === 'scaffold') {
    return { scaffold_plan: buildScaffoldPlan(bucket, metadata) };
  }

  if (command === 'release-plan') {
    return { release_plan: buildReleasePlan(bucket, metadata) };
  }

  return {};
}

function createSkippedCheck(reason) {
  return {
    requested: false,
    available: false,
    reason,
  };
}

function mergeLiveIdentity(identity, bridge) {
  if (!bridge || bridge.confirmed !== true) {
    return identity;
  }

  return {
    ...identity,
    live: {
      manifest_id: typeof bridge.manifest_id === 'string' && bridge.manifest_id.trim() !== '' ? bridge.manifest_id : null,
      confirmed: true,
      source: typeof bridge.source === 'string' && bridge.source.trim() !== '' ? bridge.source : 'bridge',
      ...(bridge.collision === true ? { collision: true } : {}),
    },
  };
}

async function resolveFastapiCheck({ command, client }) {
  if (!FASTAPI_EVIDENCE_COMMANDS.has(command)) {
    return createSkippedCheck('not-required-for-command');
  }

  if (typeof client?.health !== 'function') {
    return {
      requested: true,
      available: false,
      ready: false,
      reason: 'health-unavailable',
    };
  }

  try {
    const health = await client.health();
    const ready = String(health?.status ?? health?.state ?? 'unknown').toLowerCase() === 'ok';

    return {
      requested: true,
      available: true,
      ready,
      health,
    };
  } catch (error) {
    return {
      requested: true,
      available: false,
      ready: false,
      reason: 'health-unavailable',
      error: {
        message: error?.message ?? 'Health check unavailable.',
      },
    };
  }
}

async function resolveBridgeCheck({ command, client, identity, metadata }) {
  if (!BRIDGE_CONFIRMATION_COMMANDS.has(command)) {
    return {
      ...createSkippedCheck('not-required-for-command'),
      confirmation_only: true,
    };
  }

  if (typeof client?.confirmExtDevBridge !== 'function') {
    return {
      requested: true,
      available: false,
      confirmed: false,
      confirmation_only: true,
      reason: 'bridge-unavailable',
    };
  }

  try {
    const bridge = await client.confirmExtDevBridge({
      identity: identity.planned,
      metadata,
      surface_owner: metadata.surface_owner,
    });

    return {
      requested: true,
      available: true,
      confirmed: bridge?.confirmed === true,
      confirmation_only: true,
      collision: bridge?.collision === true,
      bridge,
    };
  } catch (error) {
    return {
      requested: true,
      available: false,
      confirmed: false,
      confirmation_only: true,
      reason: 'bridge-unavailable',
      error: {
        message: error?.message ?? 'Bridge confirmation unavailable.',
      },
    };
  }
}

export async function planLocalExtDev({ cwd, workspace, command, fs, client } = {}) {
  const resolvedWorkspace = await resolveExtDevWorkspace({ cwd, workspace, fs });
  const classification = classifyExtDevWorkspace(resolvedWorkspace);
  const evidence = buildExtDevEvidence({ workspace: resolvedWorkspace, classification });
  const fastapi = await resolveFastapiCheck({ command, client });
  const bridge = await resolveBridgeCheck({
    command,
    client,
    identity: classification.identity,
    metadata: classification.metadata,
  });
  const identity = mergeLiveIdentity(classification.identity, bridge.bridge);
  const commandPlan = buildCommandPlan(command, classification.bucket, classification.metadata);

  return {
    command: command ?? 'preflight',
    workspace: {
      root: resolvedWorkspace.root,
      manifestPath: resolvedWorkspace.manifestPath,
      manifestFilename: resolvedWorkspace.manifestFilename,
    },
    bucket: classification.bucket,
    metadata: classification.metadata,
    identity,
    evidence,
    checks: {
      local: {
        ready: true,
        source: 'manifest.json',
      },
      fastapi,
      bridge: {
        requested: bridge.requested,
        available: bridge.available,
        confirmed: bridge.confirmed ?? false,
        confirmation_only: bridge.confirmation_only === true,
        ...(bridge.reason ? { reason: bridge.reason } : {}),
        ...(bridge.collision === true ? { collision: true } : {}),
      },
    },
    gaps: buildGaps(identity),
    risks: buildRisks(classification.bucket, classification.metadata, identity),
    next_steps: buildNextSteps(classification.metadata, identity),
    ...commandPlan,
    plan_only: true,
  };
}

export { BRIDGE_CONFIRMATION_COMMANDS, FASTAPI_EVIDENCE_COMMANDS };
