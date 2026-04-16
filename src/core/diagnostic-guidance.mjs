function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function normalizeUpper(value) {
  return isNonEmptyString(value) ? value.trim().toUpperCase() : null;
}

function normalizeLower(value) {
  return isNonEmptyString(value) ? value.trim().toLowerCase() : null;
}

function includesKeyword(value, keywords) {
  const normalized = normalizeLower(value);
  return normalized !== null && keywords.some((keyword) => normalized.includes(keyword));
}

function createEvidenceCollector() {
  const items = [];
  const seen = new Set();

  function add(source, path, fact, value) {
    const key = JSON.stringify([source, path, fact, value]);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    items.push({ source, path, fact, value });
  }

  return {
    add,
    list() {
      return items;
    },
  };
}

function createSignal(rule, strength, source, path, fact, value) {
  return { rule, strength, evidence: { source, path, fact, value } };
}

function signalWeight(strength) {
  switch (strength) {
    case 'canonical':
      return 3;
    case 'secondary':
      return 2;
    case 'weak':
      return 1;
    default:
      return 0;
  }
}

function scoreSignals(signals) {
  const canonical = signals.filter((signal) => signal.strength === 'canonical').length;
  const secondary = signals.filter((signal) => signal.strength === 'secondary').length;
  const weak = signals.filter((signal) => signal.strength === 'weak').length;

  if (canonical >= 1 && secondary >= 1) {
    return 'high';
  }

  if (secondary >= 2 || (canonical >= 1 && weak >= 1)) {
    return 'medium';
  }

  if (signals.length >= 1) {
    return 'low';
  }

  return 'none';
}

function selectBestCandidate(candidates) {
  return candidates
    .filter((candidate) => candidate.signals.length > 0)
    .sort((left, right) => {
      const leftWeight = left.signals.reduce((total, signal) => total + signalWeight(signal.strength), 0);
      const rightWeight = right.signals.reduce((total, signal) => total + signalWeight(signal.strength), 0);

      if (leftWeight !== rightWeight) {
        return rightWeight - leftWeight;
      }

      return right.signals.length - left.signals.length;
    })[0] ?? null;
}

function normalizeEvidenceInput(input) {
  if (!isObject(input)) {
    return {
      surface: null,
      error: null,
      planner: null,
      run: null,
      capability: null,
      runtimeEvidence: null,
      liveContext: null,
      logsExcerpt: [],
    };
  }

  return {
    surface: normalizeString(input.surface),
    error: isObject(input.error) ? input.error : null,
    planner: isObject(input.planner) ? input.planner : null,
    run: isObject(input.run) ? input.run : null,
    capability: isObject(input.capability) ? input.capability : null,
    runtimeEvidence: isObject(input.runtimeEvidence) ? input.runtimeEvidence : null,
    liveContext: isObject(input.liveContext) ? input.liveContext : null,
    logsExcerpt: Array.isArray(input.logsExcerpt) ? input.logsExcerpt.filter((item) => typeof item === 'string') : [],
  };
}

function hasUsefulEvidence(input) {
  return isNonEmptyString(input?.error?.code)
    || isObject(input?.runtimeEvidence)
    || isObject(input?.run)
    || isObject(input?.planner)
    || isObject(input?.capability)
    || isObject(input?.liveContext)
    || (Array.isArray(input?.logsExcerpt) && input.logsExcerpt.some((entry) => isNonEmptyString(entry)));
}

function createEnvelope(overrides = {}) {
  return {
    status: 'unknown',
    category: 'unknown',
    layer: 'unknown',
    component: 'unknown',
    confidence: 'none',
    summary: 'Structured evidence did not match the closed diagnostic taxonomy.',
    evidence: [],
    limits: [],
    next_check: {
      target: 'planner_input',
      action: 'verify',
      reason: 'Gather structured evidence before inferring a cause.',
    },
    matched_rules: [],
    ...overrides,
  };
}

function createInsufficientEvidenceEnvelope(reason, evidence = [], limits = []) {
  return createEnvelope({
    status: 'insufficient_evidence',
    summary: reason,
    evidence,
    limits: limits.length > 0 ? limits : ['The provided evidence is not enough to prove a closed-taxonomy hypothesis.'],
    next_check: {
      target: 'planner_input',
      action: 'verify',
      reason: 'Provide canonical error metadata, runtime evidence, planner context, or run metadata.',
    },
  });
}

function collectBackendUnavailable(input) {
  const signals = [];
  const contradictions = [];
  const code = normalizeUpper(input.error?.code);
  const runtimeStatus = input.runtimeEvidence?.response?.status;
  const healthStatus = normalizeLower(input.liveContext?.health?.status);
  const requestedUrl = normalizeString(input.runtimeEvidence?.requestedUrl);

  if (code === 'BACKEND_UNAVAILABLE') {
    signals.push(createSignal('backend.error_code', 'canonical', 'error', 'error.code', 'Canonical backend unavailable code was emitted.', input.error.code));
  }

  if (typeof runtimeStatus === 'number' && runtimeStatus >= 500) {
    signals.push(createSignal('backend.runtime_5xx', 'canonical', 'runtimeEvidence', 'runtimeEvidence.response.status', 'Runtime evidence captured a backend 5xx response.', runtimeStatus));
  }

  if (isObject(input.runtimeEvidence?.cause)) {
    const causeCode = normalizeUpper(input.runtimeEvidence.cause.code);
    const causeMessage = normalizeString(input.runtimeEvidence.cause.message);

    if (causeCode === 'ECONNREFUSED' || causeCode === 'ECONNRESET' || causeCode === 'ENOTFOUND' || includesKeyword(causeMessage, ['connection refused', 'fetch failed', 'network error', 'connect'])) {
      signals.push(createSignal('backend.transport_failure', 'canonical', 'runtimeEvidence', 'runtimeEvidence.cause', 'Runtime evidence captured a transport-level backend failure.', input.runtimeEvidence.cause));
    }
  }

  if (isNonEmptyString(requestedUrl) && requestedUrl.includes('/health')) {
    signals.push(createSignal('backend.health_route', 'secondary', 'runtimeEvidence', 'runtimeEvidence.requestedUrl', 'The observed request targeted the health endpoint.', requestedUrl));
  }

  if (healthStatus !== null && healthStatus !== 'ok') {
    signals.push(createSignal('backend.health_not_ok', 'secondary', 'liveContext', 'liveContext.health.status', 'Live health context reported a non-ok backend status.', input.liveContext.health.status));
  }

  if (healthStatus === 'ok') {
    contradictions.push('Live health context reports backend status ok.');
  }

  for (const [index, line] of input.logsExcerpt.entries()) {
    if (includesKeyword(line, ['backend unavailable', 'connection refused', 'fetch failed', 'service unavailable'])) {
      signals.push(createSignal('backend.logs_keyword', 'weak', 'logsExcerpt', `logsExcerpt[${index}]`, 'Log excerpt mentions backend unavailability keywords.', line));
    }
  }

  return {
    category: 'backend_unavailable',
    layer: 'backend_api',
    component: 'backend',
    next_check: {
      target: 'health',
      action: 'verify',
      reason: 'Confirm current backend readiness through GET /health before any business operation.',
    },
    signals,
    contradictions,
  };
}

function collectExtensionRuntime(input) {
  const signals = [];
  const code = normalizeUpper(input.error?.code);

  if (code !== null && ['EXTENSION_NOT_READY', 'EXTENSION_UNAVAILABLE', 'EXTENSION_RUNTIME_UNAVAILABLE', 'IPC_UNAVAILABLE'].includes(code)) {
    signals.push(createSignal('extension.error_code', 'canonical', 'error', 'error.code', 'Canonical extension runtime code was emitted.', input.error.code));
  }

  if (normalizeLower(input.surface) === 'electron_ipc' || normalizeLower(input.surface) === 'extension') {
    signals.push(createSignal('extension.surface', 'secondary', 'error', 'surface', 'The failing surface points to Electron IPC or extension runtime.', input.surface));
  }

  if (Array.isArray(input.liveContext?.extensionErrors) && input.liveContext.extensionErrors.length > 0) {
    signals.push(createSignal('extension.live_errors', 'secondary', 'liveContext', 'liveContext.extensionErrors', 'Live context contains extension runtime errors.', input.liveContext.extensionErrors));
  }

  for (const reason of Array.isArray(input.planner?.reasons) ? input.planner.reasons : []) {
    if (includesKeyword(reason, ['extension', 'ipc', 'not ready'])) {
      signals.push(createSignal('extension.planner_reason', 'secondary', 'planner', 'planner.reasons', 'Planner reasons mention extension runtime readiness.', reason));
    }
  }

  for (const [index, line] of input.logsExcerpt.entries()) {
    if (includesKeyword(line, ['extension', 'ipc', 'handshake', 'not ready'])) {
      signals.push(createSignal('extension.logs_keyword', 'weak', 'logsExcerpt', `logsExcerpt[${index}]`, 'Log excerpt mentions extension runtime keywords.', line));
    }
  }

  return {
    category: 'extension_runtime',
    layer: normalizeLower(input.surface) === 'electron_ipc' ? 'electron_ipc' : 'extension',
    component: 'extension',
    next_check: {
      target: 'extension_errors',
      action: 'verify',
      reason: 'Review read-only extension runtime errors or readiness state before retrying.',
    },
    signals,
    contradictions: [],
  };
}

function collectInputContract(input) {
  const signals = [];
  const code = normalizeUpper(input.error?.code);
  const reason = normalizeLower(input.error?.details?.reason);
  const knownReasons = new Set([
    'non_canonical_model_id',
    'invalid_model_id',
    'invalid_path',
    'absolute_path',
    'path_traversal',
    'invalid_input_shape',
    'invalid_process_input_kind',
    'schema_mismatch',
    'required',
    'conflicting_output_path',
  ]);

  if ((code !== null && ['VALIDATION_ERROR', 'INVALID_MODEL_ID', 'NON_CANONICAL_MODEL_ID', 'INVALID_USAGE'].includes(code)) || knownReasons.has(reason)) {
    signals.push(createSignal('input.error_contract', 'canonical', 'error', reason !== null ? 'error.details.reason' : 'error.code', 'Canonical input validation evidence was observed.', reason ?? input.error.code));
  }

  for (const plannerReason of Array.isArray(input.planner?.reasons) ? input.planner.reasons : []) {
    if (includesKeyword(plannerReason, ['non canonical', 'invalid model', 'schema', 'workspace-relative', 'path traversal', 'absolute path'])) {
      signals.push(createSignal('input.planner_reason', 'secondary', 'planner', 'planner.reasons', 'Planner reasons mention an input contract violation.', plannerReason));
    }
  }

  if (isNonEmptyString(input.capability?.requested) && includesKeyword(input.capability.requested, ['label:', 'display:', 'friendly'])) {
    signals.push(createSignal('input.requested_label', 'secondary', 'capability', 'capability.requested', 'Requested capability/model identifier looks non-canonical.', input.capability.requested));
  }

  for (const [index, line] of input.logsExcerpt.entries()) {
    if (includesKeyword(line, ['schema mismatch', 'invalid input', 'non canonical', 'path traversal', 'workspace-relative'])) {
      signals.push(createSignal('input.logs_keyword', 'weak', 'logsExcerpt', `logsExcerpt[${index}]`, 'Log excerpt mentions an input contract issue.', line));
    }
  }

  return {
    category: 'input_contract',
    layer: 'mcp',
    component: 'input_validation',
    next_check: {
      target: 'planner_input',
      action: 'verify',
      reason: 'Verify canonical model IDs and workspace-relative paths against the original request payload.',
    },
    signals,
    contradictions: [],
  };
}

function collectModelRuntime(input) {
  const signals = [];
  const code = normalizeUpper(input.error?.code);

  if (code !== null && ['MODEL_NOT_READY', 'MODEL_NOT_FOUND', 'MODEL_RUNTIME_UNAVAILABLE', 'RUNTIME_PATH_UNAVAILABLE'].includes(code)) {
    signals.push(createSignal('model.error_code', 'canonical', 'error', 'error.code', 'Canonical model/runtime code was emitted.', input.error.code));
  }

  const capabilityErrors = Array.isArray(input.liveContext?.capabilities?.errors) ? input.liveContext.capabilities.errors : [];
  for (const entry of capabilityErrors) {
    const entryCode = normalizeUpper(entry?.code);

    if (entryCode !== null && ['MODEL_NOT_READY', 'MODEL_NOT_FOUND', 'RUNTIME_PATH_UNAVAILABLE'].includes(entryCode)) {
      signals.push(createSignal('model.capabilities_error', 'secondary', 'liveContext', 'liveContext.capabilities.errors', 'Capability discovery reported model/runtime readiness issues.', entry));
    }
  }

  if (normalizeLower(input.surface) === 'model_runtime') {
    signals.push(createSignal('model.surface', 'secondary', 'error', 'surface', 'The failing surface is the model runtime.', input.surface));
  }

  if (isObject(input.liveContext?.runtimePaths) && Object.values(input.liveContext.runtimePaths).some((value) => value === null || value === '' || value === false)) {
    signals.push(createSignal('model.runtime_paths', 'secondary', 'liveContext', 'liveContext.runtimePaths', 'Runtime paths context shows unavailable model/runtime paths.', input.liveContext.runtimePaths));
  }

  for (const reason of Array.isArray(input.planner?.reasons) ? input.planner.reasons : []) {
    if (includesKeyword(reason, ['model not ready', 'model missing', 'runtime path'])) {
      signals.push(createSignal('model.planner_reason', 'secondary', 'planner', 'planner.reasons', 'Planner reasons mention model/runtime readiness.', reason));
    }
  }

  for (const [index, line] of input.logsExcerpt.entries()) {
    if (includesKeyword(line, ['model not ready', 'model missing', 'runtime path'])) {
      signals.push(createSignal('model.logs_keyword', 'weak', 'logsExcerpt', `logsExcerpt[${index}]`, 'Log excerpt mentions model/runtime availability.', line));
    }
  }

  return {
    category: 'model_runtime',
    layer: 'model_runtime',
    component: 'model_runtime',
    next_check: {
      target: 'model_list',
      action: 'verify',
      reason: 'Verify canonical models from /model/all and confirm runtime paths only through read-only surfaces.',
    },
    signals,
    contradictions: [],
  };
}

function collectRoutingBridge(input) {
  const signals = [];
  const code = normalizeUpper(input.error?.code);
  const plannerSurface = normalizeLower(input.planner?.surface);
  const observedSurface = normalizeLower(input.surface);

  if (plannerSurface !== null && observedSurface !== null && plannerSurface !== observedSurface) {
    signals.push(createSignal('routing.surface_mismatch', 'canonical', 'planner', 'planner.surface', 'Planner surface does not match the observed failing surface.', {
      planner: input.planner.surface,
      observed: input.surface,
    }));
  }

  if (code !== null && ['ROUTE_MISMATCH', 'UNSUPPORTED_BRIDGE', 'UNSUPPORTED_OPERATION'].includes(code)) {
    signals.push(createSignal('routing.error_code', 'secondary', 'error', 'error.code', 'Observed error code is consistent with routing or bridge mismatch.', input.error.code));
  }

  for (const reason of Array.isArray(input.planner?.reasons) ? input.planner.reasons : []) {
    if (includesKeyword(reason, ['route mismatch', 'unsupported bridge', 'planner surface', 'bridge mismatch'])) {
      signals.push(createSignal('routing.planner_reason', 'secondary', 'planner', 'planner.reasons', 'Planner reasons mention routing or bridge mismatch.', reason));
    }
  }

  if (isNonEmptyString(input.run?.kind) && plannerSurface !== null && ((input.run.kind === 'workflowRun' && plannerSurface === 'electron_ipc') || (input.run.kind === 'processRun' && plannerSurface === 'backend_api'))) {
    signals.push(createSignal('routing.run_kind_mismatch', 'secondary', 'run', 'run.kind', 'Observed run kind is inconsistent with planner surface selection.', input.run.kind));
  }

  for (const [index, line] of input.logsExcerpt.entries()) {
    if (includesKeyword(line, ['unsupported bridge', 'route mismatch', 'wrong route'])) {
      signals.push(createSignal('routing.logs_keyword', 'weak', 'logsExcerpt', `logsExcerpt[${index}]`, 'Log excerpt mentions route or bridge mismatch.', line));
    }
  }

  return {
    category: 'routing_bridge',
    layer: 'planner',
    component: 'bridge_router',
    next_check: {
      target: 'planner_input',
      action: 'verify',
      reason: 'Verify planner-selected surface and route against the observed failing surface before changing execution.',
    },
    signals,
    contradictions: [],
  };
}

function buildEvidence(signals, evidenceCollector) {
  for (const signal of signals) {
    evidenceCollector.add(
      signal.evidence.source,
      signal.evidence.path,
      signal.evidence.fact,
      signal.evidence.value,
    );
  }
}

export function analyzeDiagnosticGuidance(input) {
  const normalizedInput = normalizeEvidenceInput(input);

  if (!isNonEmptyString(normalizedInput.surface) || !isNonEmptyString(normalizedInput.error?.message)) {
    return createInsufficientEvidenceEnvelope(
      'Diagnostic guidance requires surface, error.message, and at least one structured evidence block.',
    );
  }

  if (!hasUsefulEvidence(normalizedInput)) {
    return createInsufficientEvidenceEnvelope(
      'Only a free-text failure message was provided; structured evidence is still missing.',
      [{ source: 'error', path: 'error.message', fact: 'Observed free-text failure message.', value: normalizedInput.error.message }],
      ['A free-text message alone cannot prove any closed-taxonomy branch.'],
    );
  }

  const candidates = [
    collectBackendUnavailable(normalizedInput),
    collectExtensionRuntime(normalizedInput),
    collectInputContract(normalizedInput),
    collectModelRuntime(normalizedInput),
    collectRoutingBridge(normalizedInput),
  ];
  const matchedCandidate = selectBestCandidate(candidates);

  if (matchedCandidate === null) {
    const evidenceCollector = createEvidenceCollector();
    evidenceCollector.add('error', 'error.message', 'Observed failure message does not map to a closed taxonomy branch.', normalizedInput.error.message);

    return createEnvelope({
      status: 'unknown',
      summary: 'Structured evidence exists, but it does not fit the closed diagnostic taxonomy.',
      evidence: evidenceCollector.list(),
      limits: ['No closed-category rule matched the observed evidence.', 'The tool does not infer root cause beyond the closed taxonomy.'],
      next_check: {
        target: 'planner_input',
        action: 'verify',
        reason: 'Compare structured evidence with planner input and existing read-only snapshots to gather a canonical signal.',
      },
      matched_rules: [],
    });
  }

  const evidenceCollector = createEvidenceCollector();
  buildEvidence(matchedCandidate.signals, evidenceCollector);
  evidenceCollector.add('error', 'error.message', 'Observed failure message.', normalizedInput.error.message);

  const confidence = scoreSignals(matchedCandidate.signals);

  if (matchedCandidate.contradictions.length > 0) {
    return createInsufficientEvidenceEnvelope(
      `Observed evidence for ${matchedCandidate.category} is contradicted by other structured context.`,
      evidenceCollector.list(),
      [
        ...matchedCandidate.contradictions,
        'Contradictory structured evidence prevents a bounded hypothesis in this batch.',
      ],
    );
  }

  return createEnvelope({
    status: confidence === 'none' ? 'unknown' : 'hypothesis',
    category: matchedCandidate.category,
    layer: matchedCandidate.layer,
    component: matchedCandidate.component,
    confidence,
    summary: `Most likely ${matchedCandidate.category} issue based on observed structured evidence.`,
    evidence: evidenceCollector.list(),
    limits: [
      'This result is a bounded hypothesis, not a proven root cause.',
      'Only structured evidence available to this analysis was used; no fixes or hidden writes were executed.',
    ],
    next_check: matchedCandidate.next_check,
    matched_rules: matchedCandidate.signals.map((signal) => signal.rule),
  });
}
