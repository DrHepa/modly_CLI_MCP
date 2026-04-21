import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { resolveExtDevWorkspace } from '../../../src/core/ext-dev/workspace.mjs';

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-dev-workspace-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function writeWorkspaceFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

test('resolveExtDevWorkspace acepta solo workspaces relativos y lee manifest.json', async (t) => {
  const tempRoot = createTempRoot(t);
  writeWorkspaceFile(
    tempRoot,
    'fixtures/simple-ext/manifest.json',
    JSON.stringify({ id: 'octo.simple', name: 'Octo Simple', version: '1.0.0' }),
  );

  const result = await resolveExtDevWorkspace({
    cwd: tempRoot,
    workspace: 'fixtures/simple-ext',
  });

  assert.equal(result.root, path.join(tempRoot, 'fixtures', 'simple-ext'));
  assert.equal(result.manifestPath, path.join(tempRoot, 'fixtures', 'simple-ext', 'manifest.json'));
  assert.equal(result.manifestFilename, 'manifest.json');
  assert.equal(result.manifest.id, 'octo.simple');
});

test('resolveExtDevWorkspace rechaza rutas absolutas y traversal fuera del cwd', async (t) => {
  const tempRoot = createTempRoot(t);

  await assert.rejects(
    () => resolveExtDevWorkspace({ cwd: tempRoot, workspace: path.join(tempRoot, 'fixtures', 'simple-ext') }),
    (error) => {
      assert.equal(error.code, 'EXT_DEV_WORKSPACE_ABSOLUTE');
      assert.equal(error.details.extDev.phase, 'resolve_workspace');
      return true;
    },
  );

  await assert.rejects(
    () => resolveExtDevWorkspace({ cwd: tempRoot, workspace: '../escape' }),
    (error) => {
      assert.equal(error.code, 'EXT_DEV_WORKSPACE_TRAVERSAL');
      assert.equal(error.details.extDev.phase, 'resolve_workspace');
      return true;
    },
  );
});

test('resolveExtDevWorkspace aplica manifest.json como único manifiesto soportado en V1', async (t) => {
  const tempRoot = createTempRoot(t);
  writeWorkspaceFile(tempRoot, 'fixtures/invalid-manifest/package.json', JSON.stringify({ name: 'octo.invalid' }));

  await assert.rejects(
    () => resolveExtDevWorkspace({ cwd: tempRoot, workspace: 'fixtures/invalid-manifest/package.json' }),
    (error) => {
      assert.equal(error.code, 'EXT_DEV_MANIFEST_FILENAME_UNSUPPORTED');
      assert.match(error.message, /manifest\.json/u);
      assert.deepEqual(error.details.extDev.supportedManifestFilenames, ['manifest.json']);
      return true;
    },
  );
});

test('resolveExtDevWorkspace falla de forma determinista cuando falta manifest.json', async (t) => {
  const tempRoot = createTempRoot(t);
  mkdirSync(path.join(tempRoot, 'fixtures', 'missing-manifest'), { recursive: true });
  writeWorkspaceFile(tempRoot, 'fixtures/missing-manifest/README.md', '# no manifest\n');

  await assert.rejects(
    () => resolveExtDevWorkspace({ cwd: tempRoot, workspace: 'fixtures/missing-manifest' }),
    (error) => {
      assert.equal(error.code, 'EXT_DEV_MANIFEST_MISSING');
      assert.equal(error.details.extDev.phase, 'read_manifest');
      assert.equal(error.details.extDev.manifestFilename, 'manifest.json');
      assert.match(error.message, /V1 only supports manifest\.json/u);
      return true;
    },
  );
});
