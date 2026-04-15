import { extractCanonicalParamIds } from './modly-normalizers.mjs';
import { findKnownCapability } from './smart-capability-registry.mjs';

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
  return rankedCandidates[0] ?? null;
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

export function planSmartCapability({ capability, params } = {}, discovery) {
  const requested = normalizeRequestedCapability(capability);
  const normalizedParams = normalizeInputParams(params);
  const knownCapability = findKnownCapability(requested);

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
      score: null,
      params: {},
      warnings: Object.keys(normalizedParams).length > 0
        ? ['Ignored params because the requested capability is outside the closed MVP registry.']
        : [],
      reasons: ['Requested capability did not match the closed smart-capability registry.'],
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

  const selectedCandidate = selectCandidate(knownCapability, discovery, requestedCanonicalIds);
  const availableParamIds = selectedCandidate?.availableParamIds ?? new Set();
  const mappedParams = mapSafeParams(knownCapability, normalizedParams, availableParamIds);
  const isDiscoverySupported = knownCapability.availability === 'discovery_based' && selectedCandidate !== null;
  const status = isDiscoverySupported ? 'supported' : 'known_but_unavailable';
  const reasons = [
    `Requested capability matched registry entry "${knownCapability.key}".`,
  ];

  if (selectedCandidate !== null) {
    reasons.push(selectedCandidate.reason);
  } else {
    reasons.push('Discovery did not expose an executable candidate that matches the closed registry rules.');
  }

  if (knownCapability.availability === 'known_unavailable_mvp') {
    reasons.push('This capability is known but intentionally unavailable for the current MVP surface.');
  }

  return {
    status,
    cap: {
      key: knownCapability.key,
      requested,
      matchedId: selectedCandidate?.matchedId ?? null,
      matchedName: selectedCandidate?.matchedName ?? null,
    },
    surface: knownCapability.target.surface,
    score: selectedCandidate?.score ?? null,
    params: mappedParams.params,
    warnings: mappedParams.warnings,
    reasons: [...reasons, ...mappedParams.reasons],
  };
}
