import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForProcessRun } from '../../src/core/process-run-wait.mjs';

test('waitForProcessRun completes on succeeded and normalizes the terminal payload', async () => {
  const calls = [];
  const responses = [
    { status: 'accepted' },
    { run: { status: 'running', process_id: 'mesh-simplify' } },
    {
      run_id: 'process-run-123',
      process_id: 'mesh-simplify',
      status: 'succeeded',
      output_url: 'https://example.com/out.glb',
    },
  ];

  const result = await waitForProcessRun({
    client: {
      async getProcessRun(runId) {
        calls.push(runId);
        return responses.shift();
      },
    },
    runId: 'process-run-123',
    intervalMs: 1,
    timeoutMs: 50,
  });

  assert.deepEqual(calls, ['process-run-123', 'process-run-123', 'process-run-123']);
  assert.equal(result.runId, 'process-run-123');
  assert.equal(result.run.run_id, 'process-run-123');
  assert.equal(result.run.process_id, 'mesh-simplify');
  assert.equal(result.run.status, 'succeeded');
  assert.equal(result.run.outputUrl, 'https://example.com/out.glb');
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 50);
  assert.equal(result.polling.attempts, 3);
  assert.ok(result.polling.elapsedMs >= 0);
  assert.deepEqual(Object.keys(result.polling).sort(), ['attempts', 'elapsedMs', 'intervalMs', 'timeoutMs']);
});

test('waitForProcessRun returns terminal failed payload instead of throwing a technical exception', async () => {
  const result = await waitForProcessRun({
    client: {
      async getProcessRun() {
        return {
          run_id: 'process-run-failed',
          process_id: 'mesh-simplify',
          status: 'failed',
          error: 'mesh failed',
        };
      },
    },
    runId: 'process-run-failed',
    intervalMs: 1,
    timeoutMs: 20,
  });

  assert.equal(result.runId, 'process-run-failed');
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.error, 'mesh failed');
  assert.equal(result.polling.attempts, 1);
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 20);
  assert.ok(result.polling.elapsedMs >= 0);
});

test('waitForProcessRun returns terminal canceled payload instead of throwing', async () => {
  const result = await waitForProcessRun({
    client: {
      async getProcessRun() {
        return {
          run_id: 'process-run-canceled',
          process_id: 'mesh-simplify',
          status: 'canceled',
          params: { mesh_path: 'meshes/in.glb' },
        };
      },
    },
    runId: 'process-run-canceled',
    intervalMs: 1,
    timeoutMs: 20,
  });

  assert.equal(result.runId, 'process-run-canceled');
  assert.equal(result.run.status, 'canceled');
  assert.deepEqual(result.run.params, { mesh_path: 'meshes/in.glb' });
  assert.equal(result.polling.attempts, 1);
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 20);
  assert.ok(result.polling.elapsedMs >= 0);
});

test('waitForProcessRun times out when the run never reaches a terminal state', async () => {
  await assert.rejects(
    waitForProcessRun({
      client: {
        async getProcessRun() {
          return { run_id: 'process-run-timeout', process_id: 'mesh-simplify', status: 'running' };
        },
      },
      runId: 'process-run-timeout',
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
        run_id: 'process-run-timeout',
        runId: 'process-run-timeout',
        process_id: 'mesh-simplify',
        processId: 'mesh-simplify',
        status: 'running',
        params: undefined,
        workspacePath: undefined,
        outputUrl: undefined,
        error: undefined,
      });
      assert.equal(typeof error.details.startedAt, 'number');
      return true;
    },
  );
});
