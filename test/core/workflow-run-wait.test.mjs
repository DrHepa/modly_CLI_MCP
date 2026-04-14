import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForWorkflowRun } from '../../src/core/workflow-run-wait.mjs';

test('waitForWorkflowRun completes on done and normalizes the terminal payload', async () => {
  const calls = [];
  const responses = [
    { status: 'queued', progress: 0 },
    { run: { status: 'running', progress: 45 } },
    { run_id: 'run-123', status: 'done', progress: 100, output_url: 'https://example.com/out.glb' },
  ];

  const result = await waitForWorkflowRun({
    client: {
      async getWorkflowRun(runId) {
        calls.push(runId);
        return responses.shift();
      },
    },
    runId: 'run-123',
    intervalMs: 1,
    timeoutMs: 50,
  });

  assert.deepEqual(calls, ['run-123', 'run-123', 'run-123']);
  assert.equal(result.runId, 'run-123');
  assert.equal(result.run.run_id, 'run-123');
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.outputUrl, 'https://example.com/out.glb');
});

test('waitForWorkflowRun returns terminal error payload instead of throwing a technical exception', async () => {
  const result = await waitForWorkflowRun({
    client: {
      async getWorkflowRun() {
        return { run_id: 'run-error', status: 'error', error: 'mesh failed' };
      },
    },
    runId: 'run-error',
    intervalMs: 1,
    timeoutMs: 20,
  });

  assert.equal(result.runId, 'run-error');
  assert.equal(result.run.status, 'error');
  assert.equal(result.run.error, 'mesh failed');
});

test('waitForWorkflowRun returns terminal cancelled payload instead of throwing', async () => {
  const result = await waitForWorkflowRun({
    client: {
      async getWorkflowRun() {
        return { run_id: 'run-cancelled', status: 'cancelled', progress: 12 };
      },
    },
    runId: 'run-cancelled',
    intervalMs: 1,
    timeoutMs: 20,
  });

  assert.equal(result.runId, 'run-cancelled');
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.run.progress, 12);
});

test('waitForWorkflowRun times out when the run never reaches a terminal state', async () => {
  await assert.rejects(
    waitForWorkflowRun({
      client: {
        async getWorkflowRun() {
          return { run_id: 'run-timeout', status: 'running', progress: 50 };
        },
      },
      runId: 'run-timeout',
      intervalMs: 1,
      timeoutMs: 5,
    }),
    {
      code: 'TIMEOUT',
      message: 'Polling timed out before reaching a terminal state.',
    },
  );
});
