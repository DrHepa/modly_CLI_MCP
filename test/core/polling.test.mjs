import test from 'node:test';
import assert from 'node:assert/strict';
import { pollUntilTerminal } from '../../src/core/polling.mjs';

test('pollUntilTerminal returns the observed terminal payload and reports progress', async () => {
  const seen = [];
  const states = [{ status: 'queued' }, { status: 'running' }, { status: 'done', progress: 100 }];

  const result = await pollUntilTerminal({
    intervalMs: 1,
    timeoutMs: 50,
    load: async () => states.shift(),
    isTerminal: (payload) => payload?.status === 'done',
    onProgress: (payload) => seen.push(payload.status),
  });

  assert.deepEqual(seen, ['queued', 'running', 'done']);
  assert.deepEqual(result.payload, { status: 'done', progress: 100 });
  assert.equal(result.polling.intervalMs, 1);
  assert.equal(result.polling.timeoutMs, 50);
  assert.equal(result.polling.attempts, 3);
  assert.equal(typeof result.polling.elapsedMs, 'number');
  assert.ok(result.polling.elapsedMs >= 0);
  assert.deepEqual(Object.keys(result.polling).sort(), ['attempts', 'elapsedMs', 'intervalMs', 'timeoutMs']);
});

test('pollUntilTerminal validates positive integer timing options and times out predictably', async () => {
  await assert.rejects(
    pollUntilTerminal({
      intervalMs: 0,
      timeoutMs: 10,
      load: async () => ({ status: 'running' }),
      isTerminal: () => false,
    }),
    {
      code: 'VALIDATION_ERROR',
      message: 'intervalMs must be a positive safe integer.',
    },
  );

  await assert.rejects(
    pollUntilTerminal({
      intervalMs: 1,
      timeoutMs: 5,
      load: async () => ({ status: 'running' }),
      isTerminal: () => false,
    }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.message, 'Polling timed out before reaching a terminal state.');
      assert.equal(error.details.intervalMs, 1);
      assert.equal(error.details.timeoutMs, 5);
      assert.equal(typeof error.details.elapsedMs, 'number');
      assert.ok(error.details.elapsedMs >= 0);
      assert.ok(error.details.attempts >= 1);
      assert.deepEqual(error.details.lastObservedRun, { status: 'running' });
      assert.equal(typeof error.details.startedAt, 'number');
      return true;
    },
  );
});
