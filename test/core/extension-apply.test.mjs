import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-apply-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function writeStageFixture(stagePath, manifest) {
  mkdirSync(stagePath, { recursive: true });
  writeFileSync(path.join(stagePath, 'manifest.json'), JSON.stringify(manifest));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('inspectStagedExtension exposes reusable prepared-stage inspection for valid manifests', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { inspectStagedExtension } = await import('../../src/core/github-extension-staging.mjs');
  const result = await inspectStagedExtension(stagePath);

  assert.equal(result.status, 'prepared');
  assert.equal(result.manifestSummary.id, 'octo.valid');
  assert.equal(result.diagnostics, null);
});

test('inspectStagedExtension exposes reusable failed inspection for invalid manifests', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFixture(stagePath, { name: 'Octo Invalid', version: '1.0.0' });

  const { inspectStagedExtension } = await import('../../src/core/github-extension-staging.mjs');
  const result = await inspectStagedExtension(stagePath);

  assert.equal(result.status, 'failed');
  assert.equal(result.manifestSummary.id, null);
  assert.deepEqual(result.diagnostics, {
    phase: 'inspect',
    code: 'MANIFEST_ID_MISSING',
    detail: 'manifest.json must include a non-empty manifest.id value.',
  });
});

test('applyStagedExtension rejects non-absolute extensionsDir values before planning live paths', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => applyStagedExtension({ stagePath, extensionsDir: 'relative/extensions' }),
    (error) => {
      assert.equal(error.code, 'EXTENSIONS_DIR_UNRESOLVABLE');
      assert.equal(error.details.apply.phase, 'resolve_extensions_dir');
      assert.equal(error.details.apply.stagePath, stagePath);
      return true;
    },
  );
});

test('applyStagedExtension revalidates the prepared stage before returning a plan', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  mkdirSync(stagePath, { recursive: true });
  writeFileSync(path.join(stagePath, 'package.json'), JSON.stringify({ name: 'octo-invalid' }));
  const extensionsDir = path.join(tempRoot, 'extensions');

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => applyStagedExtension({ stagePath, extensionsDir }),
    (error) => {
      assert.equal(error.code, 'APPLY_STAGE_INVALID');
      assert.equal(error.details.apply.phase, 'preflight');
      assert.equal(error.details.apply.stagePath, stagePath);
      assert.equal(error.details.apply.stageInspection.code, 'MANIFEST_MISSING');
      return true;
    },
  );
});

test('repairStagedExtension rejects non-absolute extensionsDir values before planning live paths', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => repairStagedExtension({ stagePath, extensionsDir: 'relative/extensions' }),
    (error) => {
      assert.equal(error.code, 'EXTENSIONS_DIR_UNRESOLVABLE');
      assert.equal(error.details.apply.phase, 'resolve_extensions_dir');
      assert.equal(error.details.apply.stagePath, stagePath);
      return true;
    },
  );
});

test('repairStagedExtension revalidates the prepared stage before mutating the live destination', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  mkdirSync(stagePath, { recursive: true });
  writeFileSync(path.join(stagePath, 'package.json'), JSON.stringify({ name: 'octo-invalid' }));
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => repairStagedExtension({ stagePath, extensionsDir }),
    (error) => {
      assert.equal(error.code, 'APPLY_STAGE_INVALID');
      assert.equal(error.details.apply.phase, 'preflight');
      assert.equal(error.details.apply.stagePath, stagePath);
      assert.equal(error.details.apply.stageInspection.code, 'MANIFEST_MISSING');
      return true;
    },
  );

  assert.equal(readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), 'legacy destination');
});

test('repairStagedExtension reports observable backup restoration details when promote fails after backup creation', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  const renameLog = [];
  const fs = await import('node:fs/promises');
  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => repairStagedExtension(
      { stagePath, extensionsDir },
      {
        fs: {
          ...fs,
          async rename(from, to) {
            renameLog.push([from, to]);

            if (to === destinationPath && from.endsWith('.candidate')) {
              const error = new Error('candidate promote failed');
              error.code = 'EACCES';
              throw error;
            }

            return fs.rename(from, to);
          },
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.equal(error.details.apply.phase, 'promote');
      assert.equal(error.details.apply.stagePath, stagePath);
      assert.deepEqual(error.details.apply.backup, {
        path: path.join(extensionsDir, 'octo.valid.backup'),
        expected: true,
        created: true,
        restored: true,
      });
      return true;
    },
  );

  assert.deepEqual(renameLog, [
    [destinationPath, path.join(extensionsDir, 'octo.valid.backup')],
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
    [path.join(extensionsDir, 'octo.valid.backup'), destinationPath],
  ]);
  assert.equal(readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), 'legacy destination');
});

test('repairStagedExtension reports observable backup details when rollback cannot restore the previous destination', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  const backupPath = path.join(extensionsDir, 'octo.valid.backup');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  const renameLog = [];
  const fs = await import('node:fs/promises');
  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => repairStagedExtension(
      { stagePath, extensionsDir },
      {
        fs: {
          ...fs,
          async rename(from, to) {
            renameLog.push([from, to]);

            if (to === destinationPath && from.endsWith('.candidate')) {
              const error = new Error('candidate promote failed');
              error.code = 'EACCES';
              throw error;
            }

            if (from === backupPath && to === destinationPath) {
              const error = new Error('backup restore failed');
              error.code = 'EPERM';
              throw error;
            }

            return fs.rename(from, to);
          },
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.deepEqual(error.details.apply.backup, {
        path: backupPath,
        expected: true,
        created: true,
        restored: false,
      });
      return true;
    },
  );

  assert.deepEqual(renameLog, [
    [destinationPath, backupPath],
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
    [backupPath, destinationPath],
  ]);
  assert.equal(readFileSync(path.join(backupPath, 'legacy.txt'), 'utf8'), 'legacy destination');
});

test('repairStagedExtension reports repaired only when reload succeeds and matched runtime errors stay empty', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await repairStagedExtension(
    { stagePath, extensionsDir },
    {
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.equal(result.status, 'repaired');
  assert.equal(result.repaired, true);
  assert.deepEqual(result.reload, {
    requested: true,
    succeeded: true,
  });
  assert.deepEqual(result.errors, {
    observed: true,
    matched: [],
  });
});

test('repairStagedExtension reports repaired_degraded when extension errors cannot be observed honestly', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await repairStagedExtension(
    { stagePath, extensionsDir },
    {
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => 'not-a-real-errors-payload',
    },
  );

  assert.equal(result.status, 'repaired_degraded');
  assert.equal(result.repaired, true);
  assert.deepEqual(result.errors, {
    observed: false,
    matched: [],
    diagnostic: {
      code: 'ERRORS_UNOBSERVABLE',
      message: 'Extension error observation returned an unsupported payload.',
    },
  });
  assert.deepEqual(result.warnings, [
    {
      code: 'MANIFEST_SOURCE_UNCHANGED',
      message: 'manifest.source was left unchanged because no trusted GitHub source metadata was supplied.',
    },
    {
      code: 'ERRORS_UNOBSERVABLE',
      message: 'Extension error observation failed after promotion.',
      detail: {
        code: 'ERRORS_UNOBSERVABLE',
        message: 'Extension error observation returned an unsupported payload.',
      },
    },
  ]);
});

test('applyStagedExtension applies cleanly when no previous destination exists', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    { stagePath, extensionsDir },
    {
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.equal(result.status, 'applied');
  assert.equal(result.applied, true);
  assert.deepEqual(result.resolution, {
    extensionsDir,
    source: 'cli-flag',
    verified: true,
  });
  assert.deepEqual(result.destination, {
    path: path.join(extensionsDir, 'octo.valid'),
    exists: true,
  });
  assert.deepEqual(result.backup, {
    path: null,
    expected: false,
    created: false,
    restored: null,
  });
  assert.deepEqual(result.reload, {
    requested: true,
    succeeded: true,
  });
  assert.deepEqual(result.errors, {
    observed: true,
    matched: [],
  });
  assert.equal(readJson(path.join(extensionsDir, 'octo.valid', 'manifest.json')).id, 'octo.valid');
  assert.deepEqual(result.candidate, {
    path: path.join(extensionsDir, 'octo.valid.candidate'),
  });
});

test('applyStagedExtension keeps the backup artifact when a previous destination existed', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    { stagePath, extensionsDir },
    {
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.deepEqual(result.destination, {
    path: destinationPath,
    exists: true,
  });
  assert.deepEqual(result.backup, {
    path: path.join(extensionsDir, 'octo.valid.backup'),
    expected: true,
    created: true,
    restored: false,
  });
  assert.equal(readFileSync(path.join(result.backup.path, 'legacy.txt'), 'utf8'), 'legacy destination');
  assert.deepEqual(result.candidate, {
    path: path.join(extensionsDir, 'octo.valid.candidate'),
  });
});

test('applyStagedExtension promotes the staged snapshot, preserves a reversible backup, rewrites trusted source metadata, and reloads cleanly', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  writeFileSync(path.join(stagePath, 'README.md'), 'fresh staged content');
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  let reloadCalls = 0;
  let errorCalls = 0;
  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    {
      stagePath,
      extensionsDir,
      sourceRepo: 'octo/repo',
      sourceRef: 'main',
      sourceCommit: 'abc123',
    },
    {
      reloadExtensions: async () => {
        reloadCalls += 1;
        return { ok: true };
      },
      getExtensionErrors: async () => {
        errorCalls += 1;
        return [];
      },
    },
  );

  assert.equal(reloadCalls, 1);
  assert.equal(errorCalls, 1);
  assert.equal(result.status, 'applied');
  assert.equal(result.applied, true);
  assert.deepEqual(result.destination, {
    path: destinationPath,
    exists: true,
  });
  assert.deepEqual(result.backup, {
    path: path.join(extensionsDir, 'octo.valid.backup'),
    expected: true,
    created: true,
    restored: false,
  });
  assert.deepEqual(result.reload, {
    requested: true,
    succeeded: true,
  });
  assert.deepEqual(result.errors, {
    observed: true,
    matched: [],
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(readFileSync(path.join(destinationPath, 'README.md'), 'utf8'), 'fresh staged content');
  assert.equal(readFileSync(path.join(result.backup.path, 'legacy.txt'), 'utf8'), 'legacy destination');
  assert.deepEqual(readJson(path.join(destinationPath, 'manifest.json')).source, {
    kind: 'github',
    repo: 'octo/repo',
    ref: 'main',
    commit: 'abc123',
  });
});

test('applyStagedExtension reports applied_degraded when runtime errors are observed for the promoted extension', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    { stagePath, extensionsDir },
    {
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => ({
        errors: {
          'octo.valid': [
            {
              code: 'IMPORT_FAILED',
              message: 'Failed to load module.',
            },
          ],
          'other.extension': [{ code: 'IGNORED', message: 'Other extension.' }],
        },
      }),
    },
  );

  assert.equal(result.status, 'applied_degraded');
  assert.equal(result.applied, true);
  assert.deepEqual(result.destination, {
    path: destinationPath,
    exists: true,
  });
  assert.deepEqual(result.reload, {
    requested: true,
    succeeded: true,
  });
  assert.deepEqual(result.errors, {
    observed: true,
    matched: [
      {
        code: 'IMPORT_FAILED',
        message: 'Failed to load module.',
      },
    ],
  });
  assert.deepEqual(result.warnings, [
    {
      code: 'MANIFEST_SOURCE_UNCHANGED',
      message: 'manifest.source was left unchanged because no trusted GitHub source metadata was supplied.',
    },
    {
      code: 'EXTENSION_RUNTIME_ERRORS',
      message: 'Extension runtime errors were observed after reload for the promoted extension.',
      detail: [
        {
          code: 'IMPORT_FAILED',
          message: 'Failed to load module.',
        },
      ],
    },
  ]);
  assert.equal(readJson(path.join(destinationPath, 'manifest.json')).source, undefined);
});

test('applyStagedExtension restores the previous destination when promote fails after backup creation', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  const renameLog = [];
  const fs = await import('node:fs/promises');
  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => applyStagedExtension(
      { stagePath, extensionsDir },
      {
        fs: {
          ...fs,
          async rename(from, to) {
            renameLog.push([from, to]);

            if (to === destinationPath && from.endsWith('.candidate')) {
              const error = new Error('candidate promote failed');
              error.code = 'EACCES';
              throw error;
            }

            return fs.rename(from, to);
          },
        },
        reloadExtensions: async () => ({ ok: true }),
        getExtensionErrors: async () => [],
      },
    ),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.equal(error.details.apply.phase, 'promote');
      assert.equal(error.details.apply.stagePath, stagePath);
      assert.equal(error.details.apply.manifestId, 'octo.valid');
      return true;
    },
  );

  assert.deepEqual(renameLog, [
    [destinationPath, path.join(extensionsDir, 'octo.valid.backup')],
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
    [path.join(extensionsDir, 'octo.valid.backup'), destinationPath],
  ]);
  assert.equal(readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), 'legacy destination');
});

test('applyStagedExtension surfaces APPLY_COPY_FAILED before mutating the live destination', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  mkdirSync(destinationPath, { recursive: true });
  writeFileSync(path.join(destinationPath, 'legacy.txt'), 'legacy destination');

  const fs = await import('node:fs/promises');
  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => applyStagedExtension(
      { stagePath, extensionsDir },
      {
        fs: {
          ...fs,
          async cp() {
            const error = new Error('copy failed');
            error.code = 'EIO';
            throw error;
          },
        },
        reloadExtensions: async () => ({ ok: true }),
        getExtensionErrors: async () => [],
      },
    ),
    (error) => {
      assert.equal(error.code, 'APPLY_COPY_FAILED');
      assert.equal(error.details.apply.phase, 'copy_candidate');
      assert.equal(error.details.apply.stagePath, stagePath);
      assert.equal(error.details.apply.manifestId, 'octo.valid');
      return true;
    },
  );

  assert.equal(readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), 'legacy destination');
});
