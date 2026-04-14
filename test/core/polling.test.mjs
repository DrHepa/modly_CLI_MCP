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
  assert.deepEqual(result, { status: 'done', progress: 100 });
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
    {
      code: 'TIMEOUT',
      message: 'Polling timed out before reaching a terminal state.',
    },
  );
});
