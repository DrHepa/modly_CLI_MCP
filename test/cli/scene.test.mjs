import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { renderHelp, renderSceneHelp } from '../../src/cli/help.mjs';
import { main } from '../../src/cli/index.mjs';
import { runSceneCommand } from '../../src/cli/commands/scene.mjs';

function createTempWorkspace(t) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'modly-scene-cli-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function writeMesh(workspace, relativePath, contents = 'mesh') {
  const absolutePath = path.join(workspace, ...relativePath.split('/'));
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

function createWritableStreamCapture() {
  let output = '';

  return {
    stream: {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    },
    read() {
      return output;
    },
  };
}

test('scene help advertises import-mesh command and JSON automation contract', () => {
  const globalHelp = renderHelp();
  const sceneHelp = renderSceneHelp();

  assert.match(globalHelp, /scene <subcomando>\s+import-mesh/u);
  assert.match(sceneHelp, /modly scene/u);
  assert.match(sceneHelp, /import-mesh <mesh-path>/u);
  assert.match(sceneHelp, /--json/u);
  assert.match(sceneHelp, /Desktop bridge/u);
});

test('scene import-mesh checks health then capabilities then imports valid mesh', async (t) => {
  const workspace = createTempWorkspace(t);
  writeMesh(workspace, 'final.glb');
  const calls = [];

  const result = await runSceneCommand({
    args: ['import-mesh', 'final.glb'],
    cwd: workspace,
    client: {
      async health() {
        calls.push('health');
        return { status: 'ok' };
      },
      async getAutomationCapabilities() {
        calls.push('getAutomationCapabilities');
        return { scene: { import_mesh: { supported: true, extensions: ['.glb'] } } };
      },
      async importSceneMesh(payload) {
        calls.push(['importSceneMesh', payload]);
        return {
          status: 'imported',
          mesh_path: payload.mesh_path,
          scene_id: 'scene-1',
          object_id: 'object-9',
        };
      },
    },
  });

  assert.deepEqual(calls, [
    'health',
    'getAutomationCapabilities',
    ['importSceneMesh', { mesh_path: 'final.glb' }],
  ]);
  assert.deepEqual(result.data, {
    status: 'imported',
    meshPath: 'final.glb',
    sceneId: 'scene-1',
    objectId: 'object-9',
  });
  assert.match(result.humanMessage, /Scene import imported for final\.glb/u);
  assert.match(result.humanMessage, /sceneId=scene-1/u);
  assert.match(result.humanMessage, /objectId=object-9/u);
});

test('scene import-mesh returns concise unsupported error and never imports when bridge lacks support', async (t) => {
  const workspace = createTempWorkspace(t);
  writeMesh(workspace, 'final.glb');
  const calls = [];

  await assert.rejects(
    runSceneCommand({
      args: ['import-mesh', 'final.glb'],
      cwd: workspace,
      client: {
        async health() {
          calls.push('health');
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          calls.push('getAutomationCapabilities');
          return { scene: { import_mesh: { supported: false } } };
        },
        async importSceneMesh() {
          calls.push('importSceneMesh');
          throw new Error('import must not be called');
        },
      },
    }),
    {
      code: 'SCENE_IMPORT_UNSUPPORTED',
      message: 'Desktop bridge import mesh support is unavailable.',
    },
  );
  assert.deepEqual(calls, ['health', 'getAutomationCapabilities']);
});

test('scene import-mesh rejects invalid extension before bridge import', async (t) => {
  const workspace = createTempWorkspace(t);
  writeMesh(workspace, 'notes.txt');
  const calls = [];

  await assert.rejects(
    runSceneCommand({
      args: ['import-mesh', 'notes.txt'],
      cwd: workspace,
      client: {
        async health() {
          calls.push('health');
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          calls.push('getAutomationCapabilities');
          return { scene: { import_mesh: { supported: true, extensions: ['.glb'] } } };
        },
        async importSceneMesh() {
          calls.push('importSceneMesh');
          throw new Error('import must not be called');
        },
      },
    }),
    {
      code: 'VALIDATION_ERROR',
    },
  );
  assert.deepEqual(calls, ['health', 'getAutomationCapabilities']);
});

test('scene import-mesh emits existing JSON success and error envelopes through main', async (t) => {
  const workspace = createTempWorkspace(t);
  writeMesh(workspace, 'final.glb');
  const successStdout = createWritableStreamCapture();
  const successCode = await main(['--json', 'scene', 'import-mesh', 'final.glb'], {
    cwd: workspace,
    stdout: successStdout.stream,
    createClient() {
      return {
        async health() {
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          return { scene: { import_mesh: { supported: true } } };
        },
        async importSceneMesh(payload) {
          return { status: 'accepted', mesh_path: payload.mesh_path, run_id: 'run-1' };
        },
      };
    },
  });

  assert.equal(successCode, 0);
  assert.deepEqual(JSON.parse(successStdout.read()), {
    ok: true,
    data: { status: 'accepted', meshPath: 'final.glb', runId: 'run-1' },
    meta: { apiUrl: 'http://127.0.0.1:8765' },
  });

  const errorStdout = createWritableStreamCapture();
  const errorCode = await main(['--json', 'scene', 'import-mesh', 'missing.glb'], {
    cwd: workspace,
    stdout: errorStdout.stream,
    captureErrors: true,
    createClient() {
      return {
        async health() {
          return { status: 'ok' };
        },
        async getAutomationCapabilities() {
          return { scene: { import_mesh: { supported: true } } };
        },
        async importSceneMesh() {
          throw new Error('import must not be called');
        },
      };
    },
  });

  assert.equal(errorCode, 7);
  const errorPayload = JSON.parse(errorStdout.read());
  assert.equal(errorPayload.ok, false);
  assert.equal(errorPayload.error.code, 'VALIDATION_ERROR');
  assert.equal(errorPayload.error.details.field, 'meshPath');
  assert.equal(errorPayload.error.details.reason, 'missing_file');
});
