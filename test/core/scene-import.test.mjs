import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';

import {
  importSceneMeshWithBridge,
  isSceneMeshImportSupported,
  toSceneMeshImportResult,
  validateSceneMeshImportPath,
} from '../../src/core/scene-import.mjs';
import { UnsupportedOperationError, ValidationError } from '../../src/core/errors.mjs';

async function withWorkspace(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'modly-scene-import-'));
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  return workspaceRoot;
}

async function writeWorkspaceFile(workspaceRoot, relativePath, body = 'mesh') {
  const absolutePath = path.join(workspaceRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body);
  return absolutePath;
}

test('isSceneMeshImportSupported accepts only explicit Desktop scene import capability', () => {
  assert.equal(isSceneMeshImportSupported({ scene: { import_mesh: { supported: true } } }), true);
  assert.equal(isSceneMeshImportSupported({ scene: { importMesh: { supported: true } } }), true);
  assert.equal(isSceneMeshImportSupported({ scene: { import_mesh: { supported: false } } }), false);
  assert.equal(isSceneMeshImportSupported({ processes: [{ id: 'mesh-exporter/export' }] }), false);
});

test('validateSceneMeshImportPath accepts existing workspace-relative mesh files and normalizes separators', async (t) => {
  const workspaceRoot = await withWorkspace(t);
  await writeWorkspaceFile(workspaceRoot, 'models/final.glb');
  await writeWorkspaceFile(workspaceRoot, 'models/asset.OBJ');

  assert.deepEqual(await validateSceneMeshImportPath({ workspaceRoot, meshPath: 'models/final.glb' }), {
    meshPath: 'models/final.glb',
    absolutePath: path.join(await realpath(workspaceRoot), 'models/final.glb'),
    extension: '.glb',
  });
  assert.equal(
    (await validateSceneMeshImportPath({ workspaceRoot, meshPath: 'models\\asset.OBJ' })).meshPath,
    'models/asset.OBJ',
  );
});

test('validateSceneMeshImportPath rejects unsupported extensions, absolute paths, and traversal before filesystem success', async (t) => {
  const workspaceRoot = await withWorkspace(t);
  await writeWorkspaceFile(workspaceRoot, 'models/final.txt');

  await assert.rejects(
    () => validateSceneMeshImportPath({ workspaceRoot, meshPath: 'models/final.txt' }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details.reason, 'unsupported_extension');
      assert.deepEqual(error.details.allowedExtensions, ['.glb', '.obj', '.stl', '.ply']);
      return true;
    },
  );
  await assert.rejects(
    () => validateSceneMeshImportPath({ workspaceRoot, meshPath: path.join(workspaceRoot, 'models/final.glb') }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details.reason, 'absolute_path');
      return true;
    },
  );
  await assert.rejects(
    () => validateSceneMeshImportPath({ workspaceRoot, meshPath: '../outside.glb' }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details.reason, 'path_traversal');
      return true;
    },
  );
});

test('validateSceneMeshImportPath rejects missing paths and directories as validation errors', async (t) => {
  const workspaceRoot = await withWorkspace(t);
  await mkdir(path.join(workspaceRoot, 'models', 'directory.glb'), { recursive: true });

  await assert.rejects(
    () => validateSceneMeshImportPath({ workspaceRoot, meshPath: 'models/missing.glb' }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details.reason, 'missing_file');
      return true;
    },
  );
  await assert.rejects(
    () => validateSceneMeshImportPath({ workspaceRoot, meshPath: 'models/directory.glb' }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details.reason, 'not_a_file');
      return true;
    },
  );
});

test('validateSceneMeshImportPath can leave runtime workspace existence to Desktop bridge', async (t) => {
  const workspaceRoot = await withWorkspace(t);

  assert.deepEqual(await validateSceneMeshImportPath({
    workspaceRoot,
    meshPath: 'Default/runtime-only.glb',
    requireExistingFile: false,
  }), {
    meshPath: 'Default/runtime-only.glb',
    absolutePath: path.join(await realpath(workspaceRoot), 'Default/runtime-only.glb'),
    extension: '.glb',
  });
});

test('importSceneMeshWithBridge fails closed when Desktop capability is unavailable', async () => {
  let calls = 0;

  await assert.rejects(
    () => importSceneMeshWithBridge({
      workspaceRoot: process.cwd(),
      meshPath: 'models/final.glb',
      capabilities: { scene: { import_mesh: { supported: false } } },
      importSceneMesh: async () => {
        calls += 1;
        return { status: 'imported' };
      },
    }),
    (error) => {
      assert.ok(error instanceof UnsupportedOperationError);
      assert.equal(error.code, 'SCENE_IMPORT_UNSUPPORTED');
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('importSceneMeshWithBridge validates before invoking bridge and normalizes successful responses without invented fields', async (t) => {
  const workspaceRoot = await withWorkspace(t);
  await writeWorkspaceFile(workspaceRoot, 'models/final.ply');
  const calls = [];

  await assert.rejects(
    () => importSceneMeshWithBridge({
      workspaceRoot,
      meshPath: 'models/missing.ply',
      capabilities: { scene: { import_mesh: { supported: true } } },
      importSceneMesh: async (payload) => {
        calls.push(payload);
        return { status: 'imported' };
      },
    }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details.reason, 'missing_file');
      return true;
    },
  );
  assert.deepEqual(calls, []);

  const result = await importSceneMeshWithBridge({
    workspaceRoot,
    meshPath: 'models/final.ply',
    capabilities: { scene: { import_mesh: { supported: true } } },
    importSceneMesh: async (payload) => {
      calls.push(payload);
      return { status: 'imported', mesh_path: payload.mesh_path, object_id: 'obj-9', ignored: 'desktop-owned' };
    },
  });

  assert.deepEqual(calls, [{ mesh_path: 'models/final.ply' }]);
  assert.deepEqual(result, {
    status: 'imported',
    meshPath: 'models/final.ply',
    objectId: 'obj-9',
  });
});

test('importSceneMeshWithBridge can delegate runtime workspace existence validation to Desktop bridge', async (t) => {
  const workspaceRoot = await withWorkspace(t);
  const calls = [];

  const result = await importSceneMeshWithBridge({
    workspaceRoot,
    meshPath: 'Default/runtime-only.glb',
    capabilities: { scene: { import_mesh: { supported: true, extensions: ['.glb'] } } },
    requireExistingFile: false,
    importSceneMesh: async (payload) => {
      calls.push(payload);
      return { meshPath: payload.mesh_path, url: '/optimize/serve-file?path=/workspace/Default/runtime-only.glb', displayName: 'runtime-only.glb' };
    },
  });

  assert.deepEqual(calls, [{ mesh_path: 'Default/runtime-only.glb' }]);
  assert.deepEqual(result, {
    status: 'imported',
    meshPath: 'Default/runtime-only.glb',
    url: '/optimize/serve-file?path=/workspace/Default/runtime-only.glb',
    displayName: 'runtime-only.glb',
  });
});

test('toSceneMeshImportResult preserves async recovery metadata only when Desktop returns it', () => {
  assert.deepEqual(
    toSceneMeshImportResult({ status: 'accepted', mesh_path: 'models/a.stl', run_id: 'run-1', status_url: '/scene/import-mesh/run-1' }, 'models/a.stl'),
    {
      status: 'accepted',
      meshPath: 'models/a.stl',
      runId: 'run-1',
      statusUrl: '/scene/import-mesh/run-1',
    },
  );
  assert.deepEqual(toSceneMeshImportResult({ status: 'imported' }, 'models/a.stl'), {
    status: 'imported',
    meshPath: 'models/a.stl',
  });
  assert.deepEqual(
    toSceneMeshImportResult({ meshPath: 'models/a.glb', url: '/optimize/serve-file?path=/workspace/models/a.glb', displayName: 'a.glb' }, 'models/a.glb'),
    {
      status: 'imported',
      meshPath: 'models/a.glb',
      url: '/optimize/serve-file?path=/workspace/models/a.glb',
      displayName: 'a.glb',
    },
  );
});
