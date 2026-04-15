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
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 50);
  assert.equal(result.polling.attempts, 3);
  assert.ok(result.polling.elapsedMs >= 0);
  assert.deepEqual(Object.keys(result.polling).sort(), ['attempts', 'elapsedMs', 'intervalMs', 'timeoutMs']);
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
  assert.equal(result.polling.attempts, 1);
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 20);
  assert.ok(result.polling.elapsedMs >= 0);
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
  assert.equal(result.polling.attempts, 1);
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 20);
  assert.ok(result.polling.elapsedMs >= 0);
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
    (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.message, 'Polling timed out before reaching a terminal state.');
      assert.equal(error.details.intervalMs, 1);
      assert.equal(error.details.timeoutMs, 5);
      assert.equal(typeof error.details.elapsedMs, 'number');
      assert.ok(error.details.elapsedMs >= 0);
      assert.ok(error.details.attempts >= 1);
      assert.deepEqual(error.details.lastObservedRun, {
        run_id: 'run-timeout',
        runId: 'run-timeout',
        status: 'running',
        progress: 50,
        step: undefined,
        outputUrl: undefined,
        error: undefined,
        sceneCandidate: undefined,
      });
      assert.equal(typeof error.details.startedAt, 'number');
      return true;
    },
  );
});
