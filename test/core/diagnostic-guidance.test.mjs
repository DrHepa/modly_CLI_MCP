import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiagnosticGuidance } from '../../src/core/diagnostic-guidance.mjs';

test('classifies backend_unavailable with high confidence from canonical and convergent evidence', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'backend_api',
    error: {
      message: 'Backend request failed.',
      code: 'BACKEND_UNAVAILABLE',
    },
    runtimeEvidence: {
      requestedUrl: 'http://127.0.0.1:8765/health',
      cause: { code: 'ECONNREFUSED', message: 'Connection refused' },
    },
    liveContext: {
      health: { status: 'down' },
    },
  });

  assert.equal(result.status, 'hypothesis');
  assert.equal(result.category, 'backend_unavailable');
  assert.equal(result.layer, 'backend_api');
  assert.equal(result.confidence, 'high');
  assert.equal(result.next_check.target, 'health');
  assert.ok(result.matched_rules.includes('backend.error_code'));
  assert.ok(result.matched_rules.includes('backend.transport_failure'));
});

test('classifies extension_runtime with medium confidence from consistent secondary evidence', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'electron_ipc',
    error: {
      message: 'Extension runtime is not ready.',
    },
    planner: {
      reasons: ['Extension IPC handshake is not ready yet.'],
    },
    liveContext: {
      extensionErrors: [{ code: 'EXTENSION_BOOT_FAILED', message: 'Handshake timeout' }],
    },
  });

  assert.equal(result.status, 'hypothesis');
  assert.equal(result.category, 'extension_runtime');
  assert.equal(result.layer, 'electron_ipc');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.next_check.target, 'extension_errors');
});

test('classifies input_contract with high confidence from canonical validation metadata', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'mcp',
    error: {
      message: 'Model id must be canonical.',
      code: 'VALIDATION_ERROR',
      details: {
        reason: 'non_canonical_model_id',
      },
    },
    planner: {
      reasons: ['Input used a non canonical model identifier.'],
    },
  });

  assert.equal(result.status, 'hypothesis');
  assert.equal(result.category, 'input_contract');
  assert.equal(result.layer, 'mcp');
  assert.equal(result.confidence, 'high');
  assert.equal(result.next_check.target, 'planner_input');
});

test('classifies model_runtime with high confidence from canonical and discovery evidence', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'model_runtime',
    error: {
      message: 'Selected model is not ready.',
      code: 'MODEL_NOT_READY',
    },
    liveContext: {
      capabilities: {
        errors: [{ code: 'MODEL_NOT_READY', model: 'sdxl-turbo' }],
      },
      runtimePaths: {
        comfyui: '',
      },
    },
  });

  assert.equal(result.status, 'hypothesis');
  assert.equal(result.category, 'model_runtime');
  assert.equal(result.layer, 'model_runtime');
  assert.equal(result.confidence, 'high');
  assert.equal(result.next_check.target, 'model_list');
});

test('classifies routing_bridge with high confidence from planner surface mismatch', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'backend_api',
    error: {
      message: 'Planner routed the call to the wrong bridge.',
      code: 'UNSUPPORTED_OPERATION',
    },
    planner: {
      surface: 'electron_ipc',
      reasons: ['Unsupported bridge for this route.'],
    },
    run: {
      kind: 'workflowRun',
    },
  });

  assert.equal(result.status, 'hypothesis');
  assert.equal(result.category, 'routing_bridge');
  assert.equal(result.layer, 'planner');
  assert.equal(result.confidence, 'high');
  assert.equal(result.next_check.target, 'planner_input');
});

test('returns unknown when structured evidence does not match the closed taxonomy', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'backend_api',
    error: {
      message: 'An unexpected serialization branch failed.',
      code: 'SERIALIZER_EDGE_CASE',
    },
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 'none');
  assert.equal(result.matched_rules.length, 0);
});

test('returns insufficient_evidence when only a free-text error message is provided', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'backend_api',
    error: {
      message: 'Something failed.',
    },
  });

  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 'none');
  assert.equal(result.next_check.target, 'planner_input');
});

test('returns insufficient_evidence when canonical backend signal is contradicted by healthy live context', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'backend_api',
    error: {
      message: 'Backend unavailable.',
      code: 'BACKEND_UNAVAILABLE',
    },
    liveContext: {
      health: { status: 'ok' },
    },
  });

  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 'none');
  assert.ok(result.limits.some((entry) => entry.includes('backend status ok')));
});

test('returns insufficient_evidence when high-score backend evidence is contradicted by healthy live context', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'backend_api',
    error: {
      message: 'Backend unavailable.',
      code: 'BACKEND_UNAVAILABLE',
    },
    runtimeEvidence: {
      requestedUrl: 'http://127.0.0.1:8765/health',
      cause: { code: 'ECONNREFUSED', message: 'Connection refused' },
    },
    liveContext: {
      health: { status: 'ok' },
    },
  });

  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 'none');
  assert.ok(result.evidence.some((entry) => entry.path === 'runtimeEvidence.cause'));
  assert.ok(result.limits.some((entry) => entry.includes('Contradictory structured evidence')));
});

test('uses neutral limits wording for bounded hypotheses', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'electron_ipc',
    error: {
      message: 'Extension runtime is not ready.',
      code: 'IPC_UNAVAILABLE',
    },
    planner: {
      reasons: ['Extension IPC handshake is not ready yet.'],
    },
  });

  assert.equal(result.status, 'hypothesis');
  assert.ok(result.limits.includes('Only structured evidence available to this analysis was used; no fixes or hidden writes were executed.'));
});

test('keeps logsExcerpt as secondary-only evidence and never upgrades it to high confidence alone', () => {
  const result = analyzeDiagnosticGuidance({
    surface: 'extension',
    error: {
      message: 'Extension failed during startup.',
    },
    logsExcerpt: ['Extension IPC handshake not ready yet.'],
  });

  assert.equal(result.status, 'hypothesis');
  assert.equal(result.category, 'extension_runtime');
  assert.equal(result.confidence, 'low');
  assert.ok(result.evidence.some((entry) => entry.source === 'logsExcerpt'));
});
