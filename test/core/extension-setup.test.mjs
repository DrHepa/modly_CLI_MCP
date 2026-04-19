import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-setup-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function writeStageFiles(stagePath, files) {
  mkdirSync(stagePath, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(stagePath, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
}

function createSpawnImpl(steps) {
  return (command, args, options) => {
    const step = steps.shift();

    if (!step) {
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    }

    assert.equal(command, step.command);
    assert.deepEqual(args, step.args);

    if (step.cwd !== undefined) {
      assert.equal(options.cwd, step.cwd);
    }

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    process.nextTick(() => {
      if (step.stdout) {
        child.stdout.emit('data', Buffer.from(step.stdout));
      }

      if (step.stderr) {
        child.stderr.emit('data', Buffer.from(step.stderr));
      }

      child.emit('close', step.exitCode ?? 0);
    });

    return child;
  };
}

test('configureStagedExtension blocks when third-party consent is missing even if setup.py is present', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFiles(stagePath, {
    'manifest.json': JSON.stringify({ id: 'octo.setup', name: 'Octo Setup', version: '1.0.0' }),
    'setup.py': 'print("setup")\n',
  });

  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const result = await configureStagedExtension({
    stagePath,
    pythonExe: 'python3',
    allowThirdParty: false,
    setupPayload: {},
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked, true);
  assert.deepEqual(result.plan, {
    consentGranted: false,
    cwd: stagePath,
    command: 'python3',
    args: ['setup.py', '{}'],
    setupContract: {
      kind: 'python-root-setup-py',
      entry: 'setup.py',
      requiredInputs: [],
    },
  });
  assert.equal(result.execution, null);
  assert.equal(result.artifacts.after, null);
  assert.deepEqual(result.blockers, [
    {
      code: 'THIRD_PARTY_CONSENT_REQUIRED',
      message: 'Explicit --allow-third-party consent is required before executing staged setup contracts.',
    },
  ]);
});

test('configureStagedExtension blocks when the stage has no supported explicit setup contract', async (t) => {
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
  writeStageFiles(stagePath, {
    'manifest.json': JSON.stringify({ id: 'octo.vague', name: 'Octo Vague', version: '1.0.0' }),
    'pyproject.toml': '[build-system]\nrequires = ["setuptools"]\n',
  });

  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const result = await configureStagedExtension({
    stagePath,
    pythonExe: 'python3',
    allowThirdParty: true,
    setupPayload: {},
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.plan, {
    consentGranted: true,
    cwd: stagePath,
    command: null,
    args: [],
    setupContract: null,
  });
  assert.equal(result.execution, null);
  assert.deepEqual(result.blockers, [
    {
      code: 'SETUP_CONTRACT_UNSUPPORTED',
      message: 'Only an explicit root setup.py contract is supported for staged extension setup in this version.',
    },
  ]);
  assert.equal(result.artifacts.before.setupContract, null);
});

test('configureStagedExtension blocks when a required explicit setup input is missing from the payload', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => ({
        status: 'prepared',
        manifestSummary: {
          present: true,
          readable: true,
          id: 'octo.contract',
          name: 'Octo Contract',
          version: '1.0.0',
          extensionType: 'python',
        },
        checks: [],
        warnings: [],
        nextManualActions: [],
        diagnostics: null,
        setupContract: {
          kind: 'python-root-setup-py',
          entry: 'setup.py',
          requiredInputs: ['token'],
        },
      }),
    },
  );

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.plan, {
    consentGranted: true,
    cwd: stagePath,
    command: 'python3',
    args: ['setup.py', '{}'],
    setupContract: {
      kind: 'python-root-setup-py',
      entry: 'setup.py',
      requiredInputs: ['token'],
    },
  });
  assert.deepEqual(result.blockers, [
    {
      code: 'SETUP_INPUT_REQUIRED',
      message: 'The staged setup contract requires explicit setup payload inputs before execution.',
      detail: ['token'],
    },
  ]);
  assert.equal(result.execution, null);
});

test('configureStagedExtension executes the explicit setup contract with observable plan and execution evidence', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const inspections = [
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'octo.contract',
        name: 'Octo Contract',
        version: '1.0.0',
        extensionType: 'python',
      },
      checks: [],
      warnings: [],
      nextManualActions: [],
      diagnostics: null,
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        requiredInputs: ['token'],
      },
    },
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'octo.contract',
        name: 'Octo Contract',
        version: '1.0.0',
        extensionType: 'python',
      },
      checks: [],
      warnings: [],
      nextManualActions: [],
      diagnostics: null,
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        requiredInputs: ['token'],
      },
    },
  ];
  const spawnSteps = [
    {
      command: 'python3',
      args: ['setup.py', '{"token":"abc"}'],
      cwd: stagePath,
      stdout: 'configured ok\n',
      stderr: 'warning line\n',
      exitCode: 0,
    },
  ];
  let nowCall = 0;
  const nowValues = [1000, 1125];

  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: { token: 'abc' },
    },
    {
      inspectStage: async () => inspections.shift(),
      spawnImpl: createSpawnImpl(spawnSteps),
      now: () => nowValues[nowCall++],
    },
  );

  assert.equal(result.status, 'configured');
  assert.equal(result.blocked, false);
  assert.deepEqual(result.plan, {
    consentGranted: true,
    cwd: stagePath,
    command: 'python3',
    args: ['setup.py', '{"token":"abc"}'],
    setupContract: {
      kind: 'python-root-setup-py',
      entry: 'setup.py',
      requiredInputs: ['token'],
    },
  });
  assert.deepEqual(result.execution, {
    startedAt: 1000,
    finishedAt: 1125,
    durationMs: 125,
    exitCode: 0,
    stdout: 'configured ok',
    stderr: 'warning line',
  });
  assert.equal(result.artifacts.before.status, 'prepared');
  assert.equal(result.artifacts.after.status, 'prepared');
});

test('configureStagedExtension reports configured_degraded when setup exits successfully but post-setup inspection degrades', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const inspections = [
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'octo.contract',
        name: 'Octo Contract',
        version: '1.0.0',
        extensionType: 'python',
      },
      checks: [],
      warnings: [],
      nextManualActions: [],
      diagnostics: null,
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        requiredInputs: [],
      },
    },
    {
      status: 'failed',
      manifestSummary: {
        present: false,
        readable: false,
        id: null,
        name: null,
        version: null,
        extensionType: 'python',
      },
      checks: [{ id: 'manifest.present', status: 'fail' }],
      warnings: [
        {
          code: 'POST_SETUP_ARTIFACT_MISSING',
          message: 'Expected generated artifact is still missing after setup.',
          detail: ['manifest.json'],
        },
      ],
      nextManualActions: [],
      diagnostics: {
        phase: 'inspect',
        code: 'MANIFEST_MISSING',
        detail: 'manifest.json was not found in the staged extension snapshot.',
      },
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        requiredInputs: [],
      },
    },
  ];

  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => inspections.shift(),
      spawnImpl: createSpawnImpl([
        {
          command: 'python3',
          args: ['setup.py', '{}'],
          cwd: stagePath,
          exitCode: 0,
        },
      ]),
      now: (() => {
        const values = [200, 260];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  assert.equal(result.status, 'configured_degraded');
  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.artifacts.after.status, 'failed');
  assert.deepEqual(result.artifacts.after.warnings, [
    {
      code: 'POST_SETUP_ARTIFACT_MISSING',
      message: 'Expected generated artifact is still missing after setup.',
      detail: ['manifest.json'],
    },
  ]);
});

test('configureStagedExtension blocks with execution evidence when the explicit setup command fails', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const inspection = {
    status: 'prepared',
    manifestSummary: {
      present: true,
      readable: true,
      id: 'octo.contract',
      name: 'Octo Contract',
      version: '1.0.0',
      extensionType: 'python',
    },
    checks: [],
    warnings: [],
    nextManualActions: [],
    diagnostics: null,
    setupContract: {
      kind: 'python-root-setup-py',
      entry: 'setup.py',
      requiredInputs: [],
    },
  };

  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => inspection,
      spawnImpl: createSpawnImpl([
        {
          command: 'python3',
          args: ['setup.py', '{}'],
          cwd: stagePath,
          stdout: 'starting\n',
          stderr: 'boom\n',
          exitCode: 9,
        },
      ]),
      now: (() => {
        const values = [3000, 3090];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers, [
    {
      code: 'SETUP_EXECUTION_FAILED',
      message: 'The staged setup contract exited with a non-zero code.',
      detail: {
        exitCode: 9,
      },
    },
  ]);
  assert.deepEqual(result.execution, {
    startedAt: 3000,
    finishedAt: 3090,
    durationMs: 90,
    exitCode: 9,
    stdout: 'starting',
    stderr: 'boom',
  });
  assert.equal(result.artifacts.after, null);
});
