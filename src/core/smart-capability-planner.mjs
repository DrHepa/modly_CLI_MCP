import { extractCanonicalParamIds } from './modly-normalizers.mjs';
import { findKnownCapability, getCapabilityGuideMetadata, getObservableMvpSurface, KNOWN_CAPABILITIES } from './smart-capability-registry.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
    : '';
}

function normalizeRequestedCapability(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInputParams(params) {
  return isObject(params) ? params : {};
}

function getDiscoveryCandidates(discovery, kind) {
  if (kind === 'model') {
    return Array.isArray(discovery?.models) ? discovery.models : [];
  }

  return Array.isArray(discovery?.processes) ? discovery.processes : [];
}

function getCandidateId(candidate, kind) {
  if (kind === 'process') {
    const extensionId = typeof candidate?.extension_id === 'string' ? candidate.extension_id.trim() : '';
    const nodeId = typeof candidate?.node_id === 'string' ? candidate.node_id.trim() : '';

    if (extensionId !== '' && nodeId !== '') {
      return `${extensionId}/${nodeId}`;
    }
  }

  const resolvedId = kind === 'process'
    ? candidate?.id ?? candidate?.process_id ?? candidate?.processId
    : candidate?.id ?? candidate?.model_id ?? candidate?.modelId;

  return typeof resolvedId === 'string' && resolvedId.trim() !== '' ? resolvedId.trim() : null;
}

function getCandidateName(candidate) {
  const resolvedName = candidate?.name ?? candidate?.label ?? candidate?.displayName;
  return typeof resolvedName === 'string' && resolvedName.trim() !== '' ? resolvedName.trim() : null;
}

function getCandidateParamsSchema(candidate) {
  return candidate?.params_schema ?? candidate?.paramsSchema;
}

function getMatchScore(capability, candidate) {
  const normalizedCandidateId = normalizeText(getCandidateId(candidate, capability.target.kind));
  const normalizedCandidateName = normalizeText(getCandidateName(candidate));
  const normalizedTargetIds = capability.target.ids.map(normalizeText).filter(Boolean);
  const normalizedTargetNames = capability.target.names.map(normalizeText).filter(Boolean);

  if (normalizedCandidateId !== '' && normalizedTargetIds.includes(normalizedCandidateId)) {
    return { baseScore: 100, reason: `Matched discovered id "${getCandidateId(candidate, capability.target.kind)}" exactly.` };
  }

  if (normalizedCandidateName !== '' && normalizedTargetNames.includes(normalizedCandidateName)) {
    return { baseScore: 90, reason: `Matched discovered name "${getCandidateName(candidate)}" exactly.` };
  }

  const familyMatched = [...normalizedTargetIds, ...normalizedTargetNames].some((targetValue) => (
    targetValue !== ''
    && (
      (normalizedCandidateId !== '' && (normalizedCandidateId.includes(targetValue) || targetValue.includes(normalizedCandidateId)))
      || (normalizedCandidateName !== '' && (normalizedCandidateName.includes(targetValue) || targetValue.includes(normalizedCandidateName)))
    )
  ));

  if (familyMatched) {
    return { baseScore: 70, reason: 'Matched discovered capability by closed family rule.' };
  }

  return null;
}

function compareCandidates(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const leftId = left.matchedId ?? '';
  const rightId = right.matchedId ?? '';

  if (leftId !== rightId) {
    return leftId.localeCompare(rightId);
  }

  return (left.matchedName ?? '').localeCompare(right.matchedName ?? '');
}

function compareDiscoveredExtras(left, right) {
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind);
  }

  const leftId = left.id ?? '';
  const rightId = right.id ?? '';

  if (leftId !== rightId) {
    return leftId.localeCompare(rightId);
  }

  return (left.name ?? '').localeCompare(right.name ?? '');
}

function filterAliasesByCanonicalIds(aliases, allowedCanonicalIds) {
  const filteredAliases = {};

  for (const alias of Object.keys(aliases).sort((left, right) => left.localeCompare(right))) {
    const canonicalId = aliases[alias];

    if (allowedCanonicalIds.has(canonicalId)) {
      filteredAliases[alias] = canonicalId;
    }
  }

  return filteredAliases;
}

function intersectParamIds(candidates) {
  if (candidates.length === 0) {
    return new Set();
  }

  const intersection = new Set(candidates[0].availableParamIds);

  for (const candidate of candidates.slice(1)) {
    for (const canonicalId of [...intersection]) {
      if (!candidate.availableParamIds.has(canonicalId)) {
        intersection.delete(canonicalId);
      }
    }
  }

  return intersection;
}

function buildAvailableSafeParams(capability, availableParamIds) {
  const allowedCanonicalIds = new Set(capability.safeParams.canonicalIds);
  const availableCanonicalIds = capability.safeParams.canonicalIds.filter((canonicalId) => availableParamIds.has(canonicalId));

  return {
    allowed: {
      canonical_ids: [...capability.safeParams.canonicalIds],
      aliases: filterAliasesByCanonicalIds(capability.safeParams.aliases, allowedCanonicalIds),
    },
    available_now: {
      canonical_ids: availableCanonicalIds,
      aliases: filterAliasesByCanonicalIds(capability.safeParams.aliases, new Set(availableCanonicalIds)),
    },
  };
}

function buildDiscoveredOnlyTarget(candidate, kind) {
  return {
    kind,
    id: getCandidateId(candidate, kind),
    name: getCandidateName(candidate),
    status: 'discovered_only',
    surface: 'none',
  };
}

function collectDiscoveredExtras(discovery) {
  const discoveredExtras = [];

  for (const kind of ['model', 'process']) {
    for (const candidate of getDiscoveryCandidates(discovery, kind)) {
      const isKnownCandidate = KNOWN_CAPABILITIES.some((knownCapability) => getMatchScore(knownCapability, candidate) !== null);

      if (isKnownCandidate) {
        continue;
      }

      discoveredExtras.push(buildDiscoveredOnlyTarget(candidate, kind));
    }
  }

  const dedupedExtras = [];
  const seen = new Set();

  for (const entry of discoveredExtras.sort(compareDiscoveredExtras)) {
    const dedupeKey = `${entry.kind}::${entry.id ?? ''}::${entry.name ?? ''}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    dedupedExtras.push(entry);
  }

  return dedupedExtras;
}

function getDiscoveryOnlyMatchScore(requestedCapability, candidate, kind) {
  const normalizedRequested = normalizeText(requestedCapability);

  if (normalizedRequested === '') {
    return null;
  }

  const normalizedCandidateId = normalizeText(getCandidateId(candidate, kind));
  const normalizedCandidateName = normalizeText(getCandidateName(candidate));

  if (normalizedCandidateId !== '' && normalizedCandidateId === normalizedRequested) {
    return { baseScore: 100, reason: `Discovery exposes id "${getCandidateId(candidate, kind)}", but it is outside the closed registry.` };
  }

  if (normalizedCandidateName !== '' && normalizedCandidateName === normalizedRequested) {
    return { baseScore: 90, reason: `Discovery exposes name "${getCandidateName(candidate)}", but it is outside the closed registry.` };
  }

  const familyMatched = (
    (normalizedCandidateId !== '' && (normalizedCandidateId.includes(normalizedRequested) || normalizedRequested.includes(normalizedCandidateId)))
    || (normalizedCandidateName !== '' && (normalizedCandidateName.includes(normalizedRequested) || normalizedRequested.includes(normalizedCandidateName)))
  );

  if (familyMatched) {
    return { baseScore: 70, reason: 'Discovery exposes a related model/process family, but it is outside the closed registry.' };
  }

  return null;
}

function selectCandidate(capability, discovery, requestedCanonicalIds) {
  const rankedCandidates = [];

  for (const candidate of getDiscoveryCandidates(discovery, capability.target.kind)) {
    const match = getMatchScore(capability, candidate);

    if (match === null) {
      continue;
    }

    const availableParamIds = extractCanonicalParamIds(getCandidateParamsSchema(candidate));
    let score = match.baseScore;
    let bonus = 0;

    for (const canonicalId of requestedCanonicalIds) {
      if (availableParamIds.has(canonicalId)) {
        bonus += 5;
      }
    }

    score += Math.min(bonus, 10);
    rankedCandidates.push({
      candidate,
      matchedId: getCandidateId(candidate, capability.target.kind),
      matchedName: getCandidateName(candidate),
      availableParamIds,
      score,
      reason: bonus > 0
        ? `${match.reason} Discovery confirms ${Math.min(bonus, 10) / 5} requested canonical param(s).`
        : match.reason,
    });
  }

  rankedCandidates.sort(compareCandidates);

  const topCandidate = rankedCandidates[0] ?? null;

  if (topCandidate === null) {
    return {
      selectedCandidate: null,
      tiedCandidates: [],
      rankedCandidates,
      tieDetected: false,
      availableParamIds: new Set(),
    };
  }

  const tiedCandidates = rankedCandidates.filter((candidate) => candidate.score === topCandidate.score);
  const tieDetected = tiedCandidates.length > 1;

  return {
    selectedCandidate: tieDetected ? null : topCandidate,
    tiedCandidates,
    rankedCandidates,
    tieDetected,
    availableParamIds: tieDetected
      ? intersectParamIds(tiedCandidates)
      : new Set(topCandidate.availableParamIds),
  };
}

function mapSafeParams(capability, rawParams, availableParamIds) {
  const params = {};
  const warnings = [];
  const reasons = [];
  const allowedCanonicalIds = new Set(capability.safeParams.canonicalIds);
  const aliasMappings = capability.safeParams.aliases;

  for (const [inputKey, value] of Object.entries(rawParams)) {
    const trimmedKey = typeof inputKey === 'string' ? inputKey.trim() : '';

    if (trimmedKey === '') {
      continue;
    }

    const canonicalId = allowedCanonicalIds.has(trimmedKey)
      ? trimmedKey
      : aliasMappings[trimmedKey];

    if (typeof canonicalId !== 'string') {
      warnings.push(`Discarded param "${trimmedKey}": it is not an allowed canonical id or alias for "${capability.key}".`);
      continue;
    }

    if (!availableParamIds.has(canonicalId)) {
      warnings.push(`Discarded param "${trimmedKey}": canonical param "${canonicalId}" is not available in discovery params_schema.`);
      continue;
    }

    params[canonicalId] = value;

    if (canonicalId !== trimmedKey) {
      reasons.push(`Mapped alias "${trimmedKey}" to canonical param "${canonicalId}".`);
    }
  }

  return { params, warnings, reasons };
}

function buildPlanTarget(capability, selectedCandidate) {
  if (selectedCandidate === null) {
    return null;
  }

  return {
    kind: capability.target.kind,
    id: selectedCandidate.matchedId,
    name: selectedCandidate.matchedName,
  };
}

function isCapabilityExecuteSupported(capability) {
  return capability?.capabilityExecuteSupported === true;
}

function selectDiscoveredOnlyCandidate(requestedCapability, discovery) {
  const rankedCandidates = [];

  for (const kind of ['model', 'process']) {
    for (const candidate of getDiscoveryCandidates(discovery, kind)) {
      const isKnownCandidate = KNOWN_CAPABILITIES.some((knownCapability) => getMatchScore(knownCapability, candidate) !== null);

      if (isKnownCandidate) {
        continue;
      }

      const match = getDiscoveryOnlyMatchScore(requestedCapability, candidate, kind);

      if (match === null) {
        continue;
      }

      rankedCandidates.push({
        candidate,
        kind,
        matchedId: getCandidateId(candidate, kind),
        matchedName: getCandidateName(candidate),
        score: match.baseScore,
        reason: match.reason,
      });
    }
  }

  rankedCandidates.sort(compareCandidates);
  const topCandidate = rankedCandidates[0] ?? null;

  if (topCandidate === null) {
    return {
      selectedCandidate: null,
      tiedCandidates: [],
      tieDetected: false,
    };
  }

  const tiedCandidates = rankedCandidates.filter((candidate) => candidate.score === topCandidate.score);

  return {
    selectedCandidate: tiedCandidates.length > 1 ? null : topCandidate,
    tiedCandidates,
    tieDetected: tiedCandidates.length > 1,
  };
}

function evaluateCapabilityMatch({ capability, params } = {}, discovery) {
  const requested = normalizeRequestedCapability(capability);
  const normalizedParams = normalizeInputParams(params);
  const knownCapability = findKnownCapability(requested);
  const discoveredExtras = collectDiscoveredExtras(discovery);

  if (knownCapability === null) {
    const discoveredOnlySelection = selectDiscoveredOnlyCandidate(requested, discovery);
    const warnings = [];
    const reasons = [];

    if (discoveredOnlySelection.tieDetected) {
      warnings.push('Discovery exposes multiple equivalent items outside the closed registry, so no recommendation can be selected safely.');
      reasons.push('Requested capability did not match the closed smart-capability registry.');
      reasons.push('Discovery exposes multiple equivalent items outside the closed registry.');
    } else if (discoveredOnlySelection.selectedCandidate !== null) {
      reasons.push('Requested capability did not match the closed smart-capability registry.');
      reasons.push(discoveredOnlySelection.selectedCandidate.reason);
    } else {
      reasons.push('Requested capability did not match the closed smart-capability registry.');
    }

    return {
      requested,
      normalizedParams,
      knownCapability: null,
      selectedCandidate: null,
      selectedScore: null,
      mappedParams: { params: {}, warnings: [], reasons: [] },
      discoveredExtras,
      status: 'discovered_only',
      surface: 'none',
      target: null,
      availableSafeParams: {
        allowed: { canonical_ids: [], aliases: {} },
        available_now: { canonical_ids: [], aliases: {} },
      },
      warnings,
      reasons,
    };
  }

  const requestedCanonicalIds = new Set();

  for (const rawInputKey of Object.keys(normalizedParams)) {
    const inputKey = rawInputKey.trim();
    const canonicalId = knownCapability.safeParams.canonicalIds.includes(inputKey)
      ? inputKey
      : knownCapability.safeParams.aliases[inputKey];

    if (typeof canonicalId === 'string') {
      requestedCanonicalIds.add(canonicalId);
    }
  }

  const capabilitySelection = selectCandidate(knownCapability, discovery, requestedCanonicalIds);
  const selectedCandidate = capabilitySelection.selectedCandidate;
  const mappedParams = mapSafeParams(knownCapability, normalizedParams, capabilitySelection.availableParamIds);
  const guideMetadata = getCapabilityGuideMetadata(knownCapability.key);
  const observableSurface = guideMetadata?.target.observableSurface ?? getObservableMvpSurface(knownCapability.target.surface);
  const reasons = [
    `Requested capability matched registry entry "${knownCapability.key}".`,
  ];
  const warnings = [];

  if (capabilitySelection.tieDetected) {
    warnings.push('Discovery returned multiple equivalent candidates, so no safe target was auto-selected.');
    reasons.push('Multiple discovered candidates remain tied under the current closed ranking rules.');
  } else if (selectedCandidate !== null) {
    reasons.push(selectedCandidate.reason);
  } else {
    reasons.push('Discovery did not expose an executable candidate that matches the closed registry rules.');
  }

  if (knownCapability.availability === 'known_unavailable_mvp') {
    reasons.push('This capability is known but intentionally unavailable for the current MVP surface.');
  }

  if ((selectedCandidate !== null || capabilitySelection.tieDetected) && !isCapabilityExecuteSupported(knownCapability)) {
    reasons.push('Discovery matched a candidate, but the closed capability-execute allowlist does not permit supported execution for this capability.');
  }

  const isExecutableNow = selectedCandidate !== null
    && knownCapability.availability === 'discovery_based'
    && isCapabilityExecuteSupported(knownCapability);
  const status = isExecutableNow ? 'supported_now' : 'known_but_unavailable';

  return {
    requested,
    normalizedParams,
    knownCapability,
    selectedCandidate,
    selectedScore: selectedCandidate?.score ?? (capabilitySelection.tieDetected ? capabilitySelection.tiedCandidates[0]?.score ?? null : null),
    mappedParams,
    discoveredExtras,
    status,
    surface: isExecutableNow ? observableSurface : 'none',
    target: isExecutableNow ? buildPlanTarget(knownCapability, selectedCandidate) : null,
    availableSafeParams: buildAvailableSafeParams(knownCapability, capabilitySelection.availableParamIds),
    warnings,
    reasons,
  };
}

export function evaluateCapabilityGuidance(request, discovery) {
  const evaluation = evaluateCapabilityMatch(request, discovery);

  return {
    requested: {
      capability: evaluation.requested,
      params: { ...evaluation.normalizedParams },
    },
    status: evaluation.status,
    capability_key: evaluation.knownCapability?.key ?? null,
    surface: evaluation.surface,
    target: evaluation.target,
    available_safe_params: evaluation.availableSafeParams,
    reasons: [...evaluation.reasons, ...evaluation.mappedParams.reasons],
    warnings: [...evaluation.warnings, ...evaluation.mappedParams.warnings],
    discovered_extras: evaluation.discoveredExtras,
  };
}

export function planSmartCapability({ capability, params } = {}, discovery) {
  const evaluation = evaluateCapabilityMatch({ capability, params }, discovery);
  const requested = evaluation.requested;
  const normalizedParams = evaluation.normalizedParams;
  const knownCapability = evaluation.knownCapability;

  if (knownCapability === null) {
    return {
      status: 'unknown',
      cap: {
        key: null,
        requested,
        matchedId: null,
        matchedName: null,
      },
      surface: null,
      target: null,
      score: null,
      params: {},
      warnings: Object.keys(normalizedParams).length > 0
        ? ['Ignored params because the requested capability is outside the closed MVP registry.']
        : [],
      reasons: ['Requested capability did not match the closed smart-capability registry.'],
    };
  }

  return {
    status: evaluation.status === 'supported_now' ? 'supported' : 'known_but_unavailable',
    cap: {
      key: knownCapability.key,
      requested,
      matchedId: evaluation.selectedCandidate?.matchedId ?? null,
      matchedName: evaluation.selectedCandidate?.matchedName ?? null,
    },
    surface: knownCapability.target.surface,
    target: evaluation.status === 'supported_now' ? evaluation.target : null,
    score: evaluation.selectedScore,
    params: evaluation.mappedParams.params,
    warnings: evaluation.mappedParams.warnings,
    reasons: [...evaluation.reasons, ...evaluation.mappedParams.reasons],
  };
}
