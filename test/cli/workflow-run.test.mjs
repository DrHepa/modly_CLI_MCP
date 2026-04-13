import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { renderHelp, renderWorkflowRunHelp } from '../../src/cli/help.mjs';
import { runWorkflowRunCommand } from '../../src/cli/commands/workflow-run.mjs';
import { NotFoundError } from '../../src/core/errors.mjs';

async function withTempImage(t, fileName = 'input.png') {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'modly-cli-workflow-run-'));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const imagePath = path.join(tempDir, fileName);
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return imagePath;
}

test('global and workflow-run help advertise only MVP workflow-run commands', () => {
  const globalHelp = renderHelp();
  const groupHelp = renderWorkflowRunHelp();

  assert.match(globalHelp, /workflow-run <subcomando> from-image \| status \| cancel/u);
  assert.match(groupHelp, /modly workflow-run/u);
  assert.match(groupHelp, /from-image/u);
  assert.match(groupHelp, /status <run-id>/u);
  assert.match(groupHelp, /cancel <run-id>/u);
  assert.doesNotMatch(groupHelp, /wait/u);
});

test('workflow-run from-image validates --params-json as an object', async (t) => {
  const imagePath = await withTempImage(t);

  await assert.rejects(
    runWorkflowRunCommand({
      args: ['from-image', '--image', imagePath, '--model', 'model-a', '--params-json', '[]'],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '--params-json must parse to a JSON object.',
    },
  );
});

test('workflow-run from-image checks health then canonical model id and returns stable run payload', async (t) => {
  const imagePath = await withTempImage(t, 'scene.webp');
  const calls = [];

  const result = await runWorkflowRunCommand({
    args: ['from-image', '--image', imagePath, '--model', 'canonical-model', '--params-json', '{"steps":8}'],
    client: {
      async health() {
        calls.push('health');
        return { status: 'ok' };
      },
      async listModels() {
        calls.push('listModels');
        return { models: [{ id: 'canonical-model' }] };
      },
      async createWorkflowRunFromImage(input) {
        calls.push(['createWorkflowRunFromImage', input]);
        return {
          run_id: 'run-123',
          status: 'accepted',
          progress: 0,
          scene_candidate: { mesh_path: 'meshes/out.glb' },
        };
      },
    },
  });

  assert.deepEqual(calls, [
    'health',
    'listModels',
    [
      'createWorkflowRunFromImage',
      {
        imagePath,
        modelId: 'canonical-model',
        paramsJson: { steps: 8 },
      },
    ],
  ]);
  assert.equal(result.data.run.run_id, 'run-123');
  assert.equal(result.data.run.status, 'accepted');
  assert.equal(result.data.run.progress, 0);
  assert.deepEqual(result.data.run.scene_candidate, { mesh_path: 'meshes/out.glb' });
});

test('workflow-run from-image rejects non-canonical model ids before creating the run', async (t) => {
  const imagePath = await withTempImage(t);
  let createCalled = false;

  await assert.rejects(
    runWorkflowRunCommand({
      args: ['from-image', '--image', imagePath, '--model', 'pretty-name'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async listModels() {
          return { models: [{ id: 'canonical-model', name: 'Pretty Name' }] };
        },
        async createWorkflowRunFromImage() {
          createCalled = true;
          return { run_id: 'run-123', status: 'accepted' };
        },
      },
    }),
    {
      code: 'VALIDATION_ERROR',
      message: 'Unknown canonical modelId: pretty-name.',
    },
  );

  assert.equal(createCalled, false);
});

test('workflow-run status and cancel validate runId and normalize stable payloads', async () => {
  await assert.rejects(
    runWorkflowRunCommand({
      args: ['status', '   '],
      client: {},
    }),
    {
      code: 'VALIDATION_ERROR',
      message: '<run-id> must be a non-empty string.',
    },
  );

  const statusResult = await runWorkflowRunCommand({
    args: ['status', 'run-42'],
    client: {
      async health() {
        return { status: 'ok' };
      },
      async getWorkflowRun(runId) {
        return { status: 'running', progress: 55 };
      },
    },
  });
  assert.equal(statusResult.data.run.run_id, 'run-42');
  assert.equal(statusResult.data.run.runId, 'run-42');
  assert.equal(statusResult.data.run.status, 'running');
  assert.equal(statusResult.data.run.progress, 55);

  const cancelResult = await runWorkflowRunCommand({
    args: ['cancel', 'run-42'],
    client: {
      async health() {
        return { status: 'ok' };
      },
      async cancelWorkflowRun(runId) {
        return { run_id: runId, status: 'cancelled' };
      },
    },
  });
  assert.equal(cancelResult.data.run.run_id, 'run-42');
  assert.equal(cancelResult.data.run.runId, 'run-42');
  assert.equal(cancelResult.data.run.status, 'cancelled');
});

test('workflow-run status surfaces NOT_FOUND for unknown run id', async () => {
  await assert.rejects(
    runWorkflowRunCommand({
      args: ['status', 'missing-run'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async getWorkflowRun() {
          throw new NotFoundError('404 Not Found for /workflow-runs/missing-run');
        },
      },
    }),
    {
      code: 'NOT_FOUND',
      message: '404 Not Found for /workflow-runs/missing-run',
    },
  );
});

test('workflow-run cancel surfaces NOT_FOUND for unknown run id', async () => {
  await assert.rejects(
    runWorkflowRunCommand({
      args: ['cancel', 'missing-run'],
      client: {
        async health() {
          return { status: 'ok' };
        },
        async cancelWorkflowRun() {
          throw new NotFoundError('404 Not Found for /workflow-runs/missing-run/cancel');
        },
      },
    }),
    {
      code: 'NOT_FOUND',
      message: '404 Not Found for /workflow-runs/missing-run/cancel',
    },
  );
});

test('workflow-run command rejects unknown subcommands', async () => {
  await assert.rejects(
    runWorkflowRunCommand({
      args: ['wait', 'run-42'],
      client: {},
    }),
    {
      code: 'INVALID_USAGE',
      message: 'Unknown workflow-run subcommand: wait. Available: from-image, status, cancel.',
    },
  );
});

test('cli routing renders workflow-run help through the real entrypoint', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const result = spawnSync(process.execPath, ['src/cli/index.mjs', 'workflow-run', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /modly workflow-run/u);
  assert.doesNotMatch(result.stdout, /wait/u);
});
