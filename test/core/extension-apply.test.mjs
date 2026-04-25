import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { ValidationError } from '../../src/core/errors.mjs';

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

test('applyStagedExtension rejects missing or non-absolute extensionsDir values before planning live paths', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => applyStagedExtension({ stagePath }),
    (error) => {
      assert.equal(error.code, 'EXTENSIONS_DIR_REQUIRED');
      assert.equal(error.details.apply.phase, 'resolve_extensions_dir');
      assert.equal(error.details.apply.stagePath, stagePath);
      return true;
    },
  );

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

test('repairStagedExtension reports no backup details when promote fails under the default no-backup policy', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const candidatePath = path.join(extensionsDir, 'octo.valid.candidate');
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
        path: null,
        expected: false,
        created: false,
        restored: null,
      });
      return true;
    },
  );

  assert.deepEqual(renameLog, [
    [candidatePath, destinationPath],
  ]);
  assert.equal(readJson(path.join(candidatePath, 'manifest.json')).id, 'octo.valid');
  assert.throws(() => readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), { code: 'ENOENT' });
  assert.throws(() => readFileSync(path.join(backupPath, 'legacy.txt'), 'utf8'), { code: 'ENOENT' });
});

test('repairStagedExtension reports no backup details when promote fails and no restore is attempted', async (t) => {
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

            return fs.rename(from, to);
          },
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.deepEqual(error.details.apply.backup, {
        path: null,
        expected: false,
        created: false,
        restored: null,
      });
      return true;
    },
  );

  assert.deepEqual(renameLog, [
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
  ]);
  assert.throws(() => readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), { code: 'ENOENT' });
  assert.throws(() => readFileSync(path.join(backupPath, 'legacy.txt'), 'utf8'), { code: 'ENOENT' });
});

test('repairStagedExtension reports repaired only when reload succeeds and matched runtime errors stay empty', async (t) => {
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
  const result = await repairStagedExtension(
    { stagePath, extensionsDir },
    {
      fs: {
        ...fs,
        async rename(from, to) {
          renameLog.push([from, to]);
          return fs.rename(from, to);
        },
      },
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
  assert.deepEqual(result.backup, {
    path: null,
    expected: false,
    created: false,
    restored: null,
  });
  assert.deepEqual(result.errors, {
    observed: true,
    matched: [],
  });
  assert.deepEqual(renameLog, [
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
  ]);
  assert.equal(readJson(path.join(destinationPath, 'manifest.json')).id, 'octo.valid');
  assert.throws(() => readFileSync(path.join(backupPath, 'legacy.txt'), 'utf8'), { code: 'ENOENT' });
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
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  const backupPath = path.join(extensionsDir, 'octo.valid.backup');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });

  const renameLog = [];
  const fs = await import('node:fs/promises');
  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    { stagePath, extensionsDir },
    {
      fs: {
        ...fs,
        async rename(from, to) {
          renameLog.push([from, to]);
          return fs.rename(from, to);
        },
      },
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
    path: destinationPath,
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
  assert.deepEqual(renameLog, [
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
  ]);
  assert.equal(readJson(path.join(destinationPath, 'manifest.json')).id, 'octo.valid');
  assert.throws(() => readFileSync(path.join(backupPath, 'manifest.json'), 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(result.candidate, {
    path: path.join(extensionsDir, 'octo.valid.candidate'),
  });
});

test('applyStagedExtension rejects invalid manifest ids before mutating paths outside extensionsDir', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const outsidePath = path.join(tempRoot, 'outside.txt');
  writeStageFixture(stagePath, { id: '../escape', name: 'Escape', version: '1.0.0' });
  writeFileSync(outsidePath, 'keep me');

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => applyStagedExtension({ stagePath, extensionsDir }),
    (error) => {
      assert.equal(error.code, 'APPLY_STAGE_INVALID');
      assert.equal(error.details.apply.stageInspection.code, 'MANIFEST_ID_INVALID');
      return true;
    },
  );

  assert.equal(readFileSync(outsidePath, 'utf8'), 'keep me');
  assert.throws(() => readFileSync(path.join(tempRoot, 'escape', 'manifest.json'), 'utf8'), { code: 'ENOENT' });
});

test('repairStagedExtension rejects invalid manifest ids before removing paths outside extensionsDir', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const outsideDir = path.join(tempRoot, 'outside-live');
  writeStageFixture(stagePath, { id: '../outside-live', name: 'Escape', version: '1.0.0' });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(outsideDir, 'legacy.txt'), 'keep me');

  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => repairStagedExtension({ stagePath, extensionsDir }),
    (error) => {
      assert.equal(error.code, 'APPLY_STAGE_INVALID');
      assert.equal(error.details.apply.stageInspection.code, 'MANIFEST_ID_INVALID');
      return true;
    },
  );

  assert.equal(readFileSync(path.join(outsideDir, 'legacy.txt'), 'utf8'), 'keep me');
});

test('applyStagedExtension invokes setup against the live destination path and returns setup evidence', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  writeFileSync(path.join(stagePath, 'setup.py'), 'print("setup")\n');

  const configureCalls = [];
  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    {
      stagePath,
      extensionsDir,
      pythonExe: 'python3.11',
      allowThirdParty: true,
      setupPayload: { gpu_sm: '89' },
    },
    {
      configureExtension: async (input) => {
        configureCalls.push(input);
        return {
          status: 'configured',
          blocked: false,
          extensionPath: input.extensionPath,
          plan: {
            cwd: input.extensionPath,
            args: ['setup.py', JSON.stringify({ gpu_sm: '89', python_exe: 'python3.11', ext_dir: input.extensionPath })],
          },
          blockers: [],
          execution: { exitCode: 0 },
          journal: { extensionPath: input.extensionPath, status: 'succeeded' },
          artifacts: {
            before: { status: 'prepared' },
            after: { status: 'prepared', warnings: [] },
          },
        };
      },
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.deepEqual(configureCalls, [
    {
      extensionPath: path.join(extensionsDir, 'octo.valid'),
      pythonExe: 'python3.11',
      allowThirdParty: true,
      setupPayload: { gpu_sm: '89' },
    },
  ]);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.setup, {
    status: 'configured',
    blocked: false,
    extensionPath: path.join(extensionsDir, 'octo.valid'),
    plan: {
      cwd: path.join(extensionsDir, 'octo.valid'),
      args: ['setup.py', JSON.stringify({ gpu_sm: '89', python_exe: 'python3.11', ext_dir: path.join(extensionsDir, 'octo.valid') })],
    },
    blockers: [],
    execution: { exitCode: 0 },
    journal: { extensionPath: path.join(extensionsDir, 'octo.valid'), status: 'succeeded' },
    artifacts: {
      before: { status: 'prepared' },
      after: { status: 'prepared', warnings: [] },
    },
  });
});

test('applyStagedExtension degrades when live-target setup reports a blocked result', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  writeFileSync(path.join(stagePath, 'setup.py'), 'print("setup")\n');

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    {
      stagePath,
      extensionsDir,
      pythonExe: 'python3.11',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      configureExtension: async (input) => ({
        status: 'blocked',
        blocked: true,
        extensionPath: input.extensionPath,
        blockers: [
          {
            code: 'SETUP_INPUT_REQUIRED',
            message: 'gpu_sm is required.',
            detail: ['gpu_sm'],
          },
        ],
        execution: null,
        journal: null,
        artifacts: {
          before: { status: 'prepared' },
          after: null,
        },
      }),
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.equal(result.status, 'applied_degraded');
  assert.deepEqual(result.setup, {
    status: 'blocked',
    blocked: true,
    extensionPath: path.join(extensionsDir, 'octo.valid'),
    blockers: [
      {
        code: 'SETUP_INPUT_REQUIRED',
        message: 'gpu_sm is required.',
        detail: ['gpu_sm'],
      },
    ],
    execution: null,
    journal: null,
    artifacts: {
      before: { status: 'prepared' },
      after: null,
    },
  });
  assert.deepEqual(result.warnings, [
    {
      code: 'MANUAL_DEPENDENCIES_REQUIRED',
      message: 'Dependency markers detected in the staged extension; install dependencies manually inside stagePath.',
      detail: ['setup.py'],
    },
    {
      code: 'MANIFEST_SOURCE_UNCHANGED',
      message: 'manifest.source was left unchanged because no trusted GitHub source metadata was supplied.',
    },
    {
      code: 'SETUP_DEGRADED',
      message: 'Live-target setup did not complete cleanly after promotion.',
      detail: {
        status: 'blocked',
        blocked: true,
        extensionPath: path.join(extensionsDir, 'octo.valid'),
        blockers: [
          {
            code: 'SETUP_INPUT_REQUIRED',
            message: 'gpu_sm is required.',
            detail: ['gpu_sm'],
          },
        ],
        execution: null,
        journal: null,
        artifacts: {
          before: { status: 'prepared' },
          after: null,
        },
      },
    },
  ]);
});

test('applyStagedExtension preserves observable setup guidance on degraded setup results', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  const destinationPath = path.join(extensionsDir, 'octo.valid');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  writeFileSync(path.join(stagePath, 'setup.py'), 'print("setup")\n');

  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    {
      stagePath,
      extensionsDir,
      pythonExe: 'python3.11',
      allowThirdParty: true,
    },
    {
      configureExtension: async (input) => ({
        status: 'interrupted',
        blocked: false,
        extensionPath: input.extensionPath,
        runId: 'run-live-123',
        logPath: path.join(input.extensionPath, '.modly', 'setup-runs', 'run-live-123.log'),
        statusCommand: `modly ext setup-status --extensions-dir "${extensionsDir}" --manifest-id "octo.valid"`,
        staleReason: 'pid_not_alive',
        execution: {
          exitCode: null,
          attempt: 2,
          maxAttempts: 3,
          failureClass: 'transient_network',
          retryable: false,
          attempts: [
            {
              attempt: 1,
              startedAt: '2026-04-20T18:00:00.000Z',
              finishedAt: '2026-04-20T18:00:03.000Z',
              exitCode: 1,
              failureClass: 'transient_network',
              retryable: true,
            },
            {
              attempt: 2,
              startedAt: '2026-04-20T18:00:04.000Z',
              finishedAt: '2026-04-20T18:00:05.000Z',
              exitCode: null,
              failureClass: 'transient_network',
              retryable: false,
            },
          ],
        },
        blockers: [],
        journal: {
          status: 'interrupted',
          runId: 'run-live-123',
          logPath: path.join(input.extensionPath, '.modly', 'setup-runs', 'run-live-123.log'),
          staleReason: 'pid_not_alive',
          attempt: 2,
          maxAttempts: 3,
          failureClass: 'transient_network',
          retryable: false,
          attempts: [
            {
              attempt: 1,
              startedAt: '2026-04-20T18:00:00.000Z',
              finishedAt: '2026-04-20T18:00:03.000Z',
              exitCode: 1,
              failureClass: 'transient_network',
              retryable: true,
            },
            {
              attempt: 2,
              startedAt: '2026-04-20T18:00:04.000Z',
              finishedAt: '2026-04-20T18:00:05.000Z',
              exitCode: null,
              failureClass: 'transient_network',
              retryable: false,
            },
          ],
        },
        artifacts: {
          before: { status: 'prepared' },
          after: null,
        },
      }),
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.equal(result.status, 'applied_degraded');
  assert.deepEqual(result.setupObservation, {
    status: 'interrupted',
    runId: 'run-live-123',
    logPath: path.join(destinationPath, '.modly', 'setup-runs', 'run-live-123.log'),
    statusCommand: `modly ext setup-status --extensions-dir "${extensionsDir}" --manifest-id "octo.valid"`,
    staleReason: 'pid_not_alive',
    attempt: 2,
    maxAttempts: 3,
    failureClass: 'transient_network',
    retryable: false,
    attempts: [
      {
        attempt: 1,
        startedAt: '2026-04-20T18:00:00.000Z',
        finishedAt: '2026-04-20T18:00:03.000Z',
        exitCode: 1,
        failureClass: 'transient_network',
        retryable: true,
      },
      {
        attempt: 2,
        startedAt: '2026-04-20T18:00:04.000Z',
        finishedAt: '2026-04-20T18:00:05.000Z',
        exitCode: null,
        failureClass: 'transient_network',
        retryable: false,
      },
    ],
  });
});

test('repairStagedExtension preserves observable setup guidance when live-target setup throws reentry details', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  const extensionsDir = path.join(tempRoot, 'extensions');
  writeStageFixture(stagePath, { id: 'octo.valid', name: 'Octo Valid', version: '1.0.0' });
  writeFileSync(path.join(stagePath, 'setup.py'), 'print("setup")\n');

  const { repairStagedExtension } = await import('../../src/core/extension-apply.mjs');

  await assert.rejects(
    () => repairStagedExtension(
      {
        stagePath,
        extensionsDir,
        pythonExe: 'python3.11',
        allowThirdParty: true,
      },
      {
        configureExtension: async (input) => {
          throw new ValidationError('Live-target setup is already running.', {
            code: 'SETUP_ALREADY_RUNNING',
            details: {
              setup: {
                status: 'running',
                runId: 'run-live-999',
                logPath: path.join(input.extensionPath, '.modly', 'setup-runs', 'run-live-999.log'),
                statusCommand: `modly ext setup-status --extensions-dir "${extensionsDir}" --manifest-id "octo.valid"`,
                attempt: 1,
                maxAttempts: 3,
                failureClass: 'structural',
                retryable: false,
                attempts: [
                  {
                    attempt: 1,
                    startedAt: '2026-04-20T18:10:00.000Z',
                    finishedAt: '2026-04-20T18:10:01.000Z',
                    exitCode: 1,
                    failureClass: 'structural',
                    retryable: false,
                  },
                ],
              },
            },
          });
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.deepEqual(error.details.apply.setupObservation, {
        status: 'running',
        runId: 'run-live-999',
        logPath: path.join(extensionsDir, 'octo.valid', '.modly', 'setup-runs', 'run-live-999.log'),
        statusCommand: `modly ext setup-status --extensions-dir "${extensionsDir}" --manifest-id "octo.valid"`,
        staleReason: null,
        attempt: 1,
        maxAttempts: 3,
        failureClass: 'structural',
        retryable: false,
        attempts: [
          {
            attempt: 1,
            startedAt: '2026-04-20T18:10:00.000Z',
            finishedAt: '2026-04-20T18:10:01.000Z',
            exitCode: 1,
            failureClass: 'structural',
            retryable: false,
          },
        ],
      });
      return true;
    },
  );
});

test('applyStagedExtension keeps the backup artifact when a previous destination existed', async (t) => {
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
  const { applyStagedExtension } = await import('../../src/core/extension-apply.mjs');
  const result = await applyStagedExtension(
    { stagePath, extensionsDir },
    {
      fs: {
        ...fs,
        async rename(from, to) {
          renameLog.push([from, to]);
          return fs.rename(from, to);
        },
      },
      reloadExtensions: async () => ({ ok: true }),
      getExtensionErrors: async () => [],
    },
  );

  assert.deepEqual(result.destination, {
    path: destinationPath,
    exists: true,
  });
  assert.deepEqual(result.backup, {
    path: backupPath,
    expected: true,
    created: true,
    restored: false,
  });
  assert.deepEqual(renameLog, [
    [destinationPath, backupPath],
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
  ]);
  assert.equal(readFileSync(path.join(result.backup.path, 'legacy.txt'), 'utf8'), 'legacy destination');
  assert.equal(readJson(path.join(destinationPath, 'manifest.json')).id, 'octo.valid');
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
  assert.equal(readJson(path.join(destinationPath, 'manifest.json')).source, 'https://github.com/octo/repo');
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
  const backupPath = path.join(extensionsDir, 'octo.valid.backup');
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
      assert.deepEqual(error.details.apply.backup, {
        path: backupPath,
        expected: true,
        created: true,
        restored: true,
      });
      return true;
    },
  );

  assert.deepEqual(renameLog, [
    [destinationPath, backupPath],
    [path.join(extensionsDir, 'octo.valid.candidate'), destinationPath],
    [backupPath, destinationPath],
  ]);
  assert.equal(readFileSync(path.join(destinationPath, 'legacy.txt'), 'utf8'), 'legacy destination');
  assert.throws(() => readFileSync(path.join(backupPath, 'legacy.txt'), 'utf8'), { code: 'ENOENT' });
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
