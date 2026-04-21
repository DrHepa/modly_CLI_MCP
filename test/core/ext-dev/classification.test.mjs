import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { classifyExtDevWorkspace } from '../../../src/core/ext-dev/classification.mjs';
import { planLocalExtDev } from '../../../src/core/ext-dev/planner.mjs';

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-dev-classification-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function writeWorkspace(root, relativePath, manifest) {
  const workspaceRoot = path.join(root, relativePath);
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'manifest.json'), JSON.stringify(manifest));
  return workspaceRoot;
}

function mandatoryMetadataKeys(metadata) {
  return Object.keys(metadata).sort();
}

test('classifyExtDevWorkspace deriva un único bucket model-simple con metadata obligatoria e identidad separada', () => {
  const workspace = {
    root: '/tmp/simple-ext',
    manifestPath: '/tmp/simple-ext/manifest.json',
    manifestFilename: 'manifest.json',
    manifest: { id: 'octo.simple', name: 'Octo Simple', version: '1.0.0' },
  };

  const result = classifyExtDevWorkspace(workspace);

  assert.equal(result.bucket, 'model-simple');
  assert.deepEqual(mandatoryMetadataKeys(result.metadata), [
    'headless_eligible',
    'implementation_profile',
    'linux_arm64_risk',
    'resolution',
    'setup_contract',
    'support_state',
    'surface_owner',
  ]);
  assert.deepEqual(result.identity.planned, {
    manifest_id: 'octo.simple',
    display_name: 'Octo Simple',
    version: '1.0.0',
    source: 'manifest.json',
  });
  assert.deepEqual(result.identity.live, {
    manifest_id: null,
    confirmed: false,
    source: 'unavailable',
  });
});

test('classifyExtDevWorkspace selecciona buckets mutuamente excluyentes para setup y process', () => {
  const managedSetup = classifyExtDevWorkspace({
    root: '/tmp/managed-ext',
    manifestPath: '/tmp/managed-ext/manifest.json',
    manifestFilename: 'manifest.json',
    manifest: {
      id: 'octo.setup',
      name: 'Octo Setup',
      version: '1.0.0',
      setup: { kind: 'python-root-setup-py' },
    },
  });

  const processExtension = classifyExtDevWorkspace({
    root: '/tmp/process-ext',
    manifestPath: '/tmp/process-ext/manifest.json',
    manifestFilename: 'manifest.json',
    manifest: {
      id: 'octo.process',
      name: 'Octo Process',
      version: '1.0.0',
      process: { entry: 'main.py' },
    },
  });

  assert.equal(managedSetup.bucket, 'model-managed-setup');
  assert.equal(managedSetup.metadata.setup_contract, 'python-root-setup-py');
  assert.equal(managedSetup.metadata.headless_eligible, false);
  assert.equal(processExtension.bucket, 'process-extension');
  assert.equal(processExtension.metadata.surface_owner, 'electron');
  assert.equal(processExtension.metadata.linux_arm64_risk, 'elevated');
});

test('planLocalExtDev compone workspace, clasificación y evidencia en shape plan-only compartido', async (t) => {
  const tempRoot = createTempRoot(t);
  writeWorkspace(tempRoot, 'fixtures/process-ext', {
    id: 'octo.process',
    name: 'Octo Process',
    version: '2.0.0',
    process: { entry: 'main.py' },
  });

  const result = await planLocalExtDev({
    cwd: tempRoot,
    workspace: 'fixtures/process-ext',
    command: 'audit',
  });

  assert.equal(result.command, 'audit');
  assert.equal(result.plan_only, true);
  assert.equal(result.bucket, 'process-extension');
  assert.equal(result.identity.planned.manifest_id, 'octo.process');
  assert.equal(result.identity.live.confirmed, false);
  assert.deepEqual(result.gaps, ['live-identity-unconfirmed']);
  assert.deepEqual(result.risks, ['electron-owned-surface', 'linux-arm64-compatibility']);
  assert.deepEqual(result.next_steps, [
    'Confirm live identity through bridge/Electron only when available.',
    'Review Electron-owned setup/workflow implications before execution.',
  ]);
  assert.equal(result.checks.local.ready, true);
  assert.equal(result.evidence.observed[0].key, 'workspace.root');
  assert.equal(result.evidence.derived[0].key, 'bucket');
  assert.equal(result.evidence.assumed[0].key, 'identity.live');
});
