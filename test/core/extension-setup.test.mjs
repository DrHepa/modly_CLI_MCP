import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    child.pid = step.pid ?? 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    process.nextTick(() => {
      if (step.error) {
        child.emit('error', step.error);
        return;
      }

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

function createControlledSpawn(step) {
  const child = new EventEmitter();
  child.pid = step.pid ?? 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  return {
    child,
    spawnImpl(command, args, options) {
      assert.equal(command, step.command);
      assert.deepEqual(args, step.args);

      if (step.cwd !== undefined) {
        assert.equal(options.cwd, step.cwd);
      }

      return child;
    },
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
    args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
    setupContract: {
      kind: 'python-root-setup-py',
      entry: 'setup.py',
      catalogStatus: 'unknown',
      injectedInputs: ['python_exe', 'ext_dir'],
      requiredInputs: [],
      requiredPayloadInputs: [],
      optionalPayloadInputs: [],
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
  assert.equal(result.catalogStatus, null);
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

test('configureStagedExtension blocks known catalog setup before spawn when gpu_sm is missing from requiredPayloadInputs', async () => {
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
          catalogStatus: 'known',
          injectedInputs: ['python_exe', 'ext_dir'],
          requiredInputs: [],
          requiredPayloadInputs: ['gpu_sm'],
          optionalPayloadInputs: ['cuda_version'],
        },
      }),
      spawnImpl: () => {
        throw new Error('spawn should not execute when required payload inputs are missing');
      },
    },
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.catalogStatus, 'known');
  assert.deepEqual(result.plan, {
    consentGranted: true,
    cwd: stagePath,
    command: 'python3',
    args: ['setup.py', '{"python_exe":"python3","ext_dir":"/tmp/virtual-stage"}'],
    setupContract: {
      kind: 'python-root-setup-py',
      entry: 'setup.py',
      catalogStatus: 'known',
      injectedInputs: ['python_exe', 'ext_dir'],
      requiredInputs: [],
      requiredPayloadInputs: ['gpu_sm'],
      optionalPayloadInputs: ['cuda_version'],
    },
  });
  assert.deepEqual(result.blockers, [
    {
      code: 'SETUP_INPUT_REQUIRED',
      message: 'The staged setup contract requires explicit setup payload inputs before execution.',
      detail: ['gpu_sm'],
    },
  ]);
  assert.equal(result.execution, null);
});

test('configureStagedExtension does not require optional gpu_sm for tolerant catalog contracts and keeps catalogStatus observable', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const inspections = [
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'triposg',
        name: 'TripoSG',
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
        catalogStatus: 'known',
        injectedInputs: ['python_exe', 'ext_dir'],
        requiredInputs: [],
        requiredPayloadInputs: [],
        optionalPayloadInputs: ['gpu_sm', 'cuda_version'],
      },
    },
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'triposg',
        name: 'TripoSG',
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
        catalogStatus: 'known',
        injectedInputs: ['python_exe', 'ext_dir'],
        requiredInputs: [],
        requiredPayloadInputs: [],
        optionalPayloadInputs: ['gpu_sm', 'cuda_version'],
      },
    },
  ];

  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3.11',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => inspections.shift(),
      spawnImpl: createSpawnImpl([
        {
          command: 'python3.11',
          args: ['setup.py', '{"python_exe":"python3.11","ext_dir":"/tmp/virtual-stage"}'],
          cwd: stagePath,
          exitCode: 0,
        },
      ]),
      now: (() => {
        const values = [70, 85];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  assert.equal(result.status, 'configured');
  assert.equal(result.blocked, false);
  assert.equal(result.catalogStatus, 'known');
  assert.equal(result.plan.setupContract.catalogStatus, 'known');
  assert.deepEqual(result.plan.setupContract.requiredPayloadInputs, []);
  assert.deepEqual(result.plan.args, ['setup.py', '{"python_exe":"python3.11","ext_dir":"/tmp/virtual-stage"}']);
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
      args: ['setup.py', '{"token":"abc","python_exe":"python3","ext_dir":"/tmp/virtual-stage"}'],
      cwd: stagePath,
      stdout: 'configured ok\n',
      stderr: 'warning line\n',
      exitCode: 0,
    },
  ];
  let nowCall = 0;
  const nowValues = [1000, 1010, 1020, 1125];

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
    args: ['setup.py', '{"token":"abc","python_exe":"python3","ext_dir":"/tmp/virtual-stage"}'],
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

test('configureStagedExtension injects reserved python_exe and ext_dir into the final payload', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const inspections = [
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'triposg',
        name: 'TripoSG',
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
        catalogStatus: 'known',
        injectedInputs: ['python_exe', 'ext_dir'],
        requiredInputs: [],
        requiredPayloadInputs: [],
        optionalPayloadInputs: ['gpu_sm', 'cuda_version'],
      },
    },
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'triposg',
        name: 'TripoSG',
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
        catalogStatus: 'known',
        injectedInputs: ['python_exe', 'ext_dir'],
        requiredInputs: [],
        requiredPayloadInputs: [],
        optionalPayloadInputs: ['gpu_sm', 'cuda_version'],
      },
    },
  ];

  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3.11',
      allowThirdParty: true,
      setupPayload: { gpu_sm: '89' },
    },
    {
      inspectStage: async () => inspections.shift(),
      spawnImpl: createSpawnImpl([
        {
          command: 'python3.11',
          args: ['setup.py', '{"gpu_sm":"89","python_exe":"python3.11","ext_dir":"/tmp/virtual-stage"}'],
          cwd: stagePath,
          exitCode: 0,
        },
      ]),
      now: (() => {
        const values = [10, 25];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  assert.equal(result.status, 'configured');
  assert.deepEqual(result.plan.args, ['setup.py', '{"gpu_sm":"89","python_exe":"python3.11","ext_dir":"/tmp/virtual-stage"}']);
});

test('configureStagedExtension prevents setup payload from overriding reserved injected inputs', async () => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const stagePath = '/tmp/virtual-stage';
  const inspections = [
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'triposg',
        name: 'TripoSG',
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
        catalogStatus: 'known',
        injectedInputs: ['python_exe', 'ext_dir'],
        requiredInputs: [],
        requiredPayloadInputs: [],
        optionalPayloadInputs: ['gpu_sm', 'cuda_version'],
      },
    },
    {
      status: 'prepared',
      manifestSummary: {
        present: true,
        readable: true,
        id: 'triposg',
        name: 'TripoSG',
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
        catalogStatus: 'known',
        injectedInputs: ['python_exe', 'ext_dir'],
        requiredInputs: [],
        requiredPayloadInputs: [],
        optionalPayloadInputs: ['gpu_sm', 'cuda_version'],
      },
    },
  ];

  const result = await configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3.11',
      allowThirdParty: true,
      setupPayload: {
        gpu_sm: '89',
        python_exe: 'python-malicious',
        ext_dir: '/tmp/evil',
      },
    },
    {
      inspectStage: async () => inspections.shift(),
      spawnImpl: createSpawnImpl([
        {
          command: 'python3.11',
          args: ['setup.py', '{"gpu_sm":"89","python_exe":"python3.11","ext_dir":"/tmp/virtual-stage"}'],
          cwd: stagePath,
          exitCode: 0,
        },
      ]),
      now: (() => {
        const values = [30, 55];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  assert.equal(result.status, 'configured');
  assert.deepEqual(result.plan.args, ['setup.py', '{"gpu_sm":"89","python_exe":"python3.11","ext_dir":"/tmp/virtual-stage"}']);
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
          args: ['setup.py', '{"python_exe":"python3","ext_dir":"/tmp/virtual-stage"}'],
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
          args: ['setup.py', '{"python_exe":"python3","ext_dir":"/tmp/virtual-stage"}'],
          cwd: stagePath,
          stdout: 'starting\n',
          stderr: 'boom\n',
          exitCode: 9,
        },
      ]),
      now: (() => {
        const values = [3000, 3010, 3020, 3090];
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

test('configureStagedExtension creates and finalizes a stage-scoped journal on successful setup runs', async (t) => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
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
        catalogStatus: 'known',
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
        catalogStatus: 'known',
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
          pid: 9123,
          command: 'python3',
          args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
          cwd: stagePath,
          exitCode: 0,
        },
      ]),
      now: (() => {
        const values = [100, 150];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  const runsDir = path.join(stagePath, '.modly', 'setup-runs');
  const latestPath = path.join(runsDir, 'latest.json');
  const lockPath = path.join(runsDir, 'active.lock');
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));

  assert.equal(result.status, 'configured');
  assert.equal(result.journal.pid, 9123);
  assert.equal(result.journal.status, 'succeeded');
  assert.equal(latest.pid, 9123);
  assert.equal(latest.status, 'succeeded');
  assert.equal(latest.stagePath, stagePath);
  assert.equal(latest.contract.kind, 'python-root-setup-py');
  assert.equal(latest.contract.entry, 'setup.py');
  assert.equal(latest.contract.catalogStatus, 'known');
  assert.equal(typeof latest.runId, 'string');
  assert.equal(latest.logPath, path.join(runsDir, `${latest.runId}.log`));
  assert.equal(latest.startedAt, 100);
  assert.equal(latest.finishedAt, 150);
  assert.equal(existsSync(lockPath), false);
});

test('configureStagedExtension finalizes the journal as failed for non-zero exits and releases the stage lock', async (t) => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
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
      catalogStatus: 'known',
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
          pid: 8123,
          command: 'python3',
          args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
          cwd: stagePath,
          exitCode: 9,
        },
      ]),
      now: (() => {
        const values = [200, 260];
        let index = 0;
        return () => values[index++];
      })(),
    },
  );

  const runsDir = path.join(stagePath, '.modly', 'setup-runs');
  const latest = JSON.parse(readFileSync(path.join(runsDir, 'latest.json'), 'utf8'));

  assert.equal(result.status, 'blocked');
  assert.equal(result.journal.status, 'failed');
  assert.equal(latest.status, 'failed');
  assert.equal(latest.exitCode, 9);
  assert.equal(latest.finishedAt, 260);
  assert.equal(existsSync(path.join(runsDir, 'active.lock')), false);
});

test('configureStagedExtension finalizes the journal as interrupted when spawn emits an error before close', async (t) => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
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
      catalogStatus: 'known',
    },
  };

  await assert.rejects(
    () => configureStagedExtension(
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
            pid: 7123,
            command: 'python3',
            args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
            cwd: stagePath,
            error: new Error('spawn exploded'),
          },
        ]),
        now: (() => {
          const values = [300, 375];
          let index = 0;
          return () => values[index++];
        })(),
      },
    ),
    /spawn exploded/,
  );

  const runsDir = path.join(stagePath, '.modly', 'setup-runs');
  const latest = JSON.parse(readFileSync(path.join(runsDir, 'latest.json'), 'utf8'));

  assert.equal(latest.pid, 7123);
  assert.equal(latest.status, 'interrupted');
  assert.equal(latest.finishedAt, 375);
  assert.equal(latest.staleReason, 'spawn_error');
  assert.equal(existsSync(path.join(runsDir, 'active.lock')), false);
});

test('configureStagedExtension appends stdout/stderr incrementally and updates the journal before close', async (t) => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
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
      catalogStatus: 'known',
    },
  };
  const controlled = createControlledSpawn({
    pid: 6123,
    command: 'python3',
    args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
    cwd: stagePath,
  });
  const nowValues = [400, 425, 450, 500];
  let nowIndex = 0;

  const resultPromise = configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => inspection,
      spawnImpl: controlled.spawnImpl,
      now: () => nowValues[nowIndex++],
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  controlled.child.stdout.emit('data', Buffer.from('alpha\n'));
  controlled.child.stderr.emit('data', Buffer.from('beta\n'));
  await new Promise((resolve) => setImmediate(resolve));

  const runsDir = path.join(stagePath, '.modly', 'setup-runs');
  const latestDuringRun = JSON.parse(readFileSync(path.join(runsDir, 'latest.json'), 'utf8'));
  assert.equal(latestDuringRun.status, 'running');
  assert.equal(latestDuringRun.pid, 6123);
  assert.equal(latestDuringRun.lastOutputAt, 450);
  assert.equal(latestDuringRun.stdoutBytes, Buffer.byteLength('alpha\n'));
  assert.equal(latestDuringRun.stderrBytes, Buffer.byteLength('beta\n'));
  assert.equal(latestDuringRun.totalBytes, Buffer.byteLength('alpha\n') + Buffer.byteLength('beta\n'));
  assert.equal(readFileSync(latestDuringRun.logPath, 'utf8'), 'alpha\nbeta\n');

  controlled.child.emit('close', 0);
  const result = await resultPromise;

  const latest = JSON.parse(readFileSync(path.join(runsDir, 'latest.json'), 'utf8'));
  assert.equal(result.journal.status, 'succeeded');
  assert.equal(result.journal.lastOutputAt, 450);
  assert.equal(result.journal.stdoutBytes, Buffer.byteLength('alpha\n'));
  assert.equal(result.journal.stderrBytes, Buffer.byteLength('beta\n'));
  assert.equal(result.journal.totalBytes, Buffer.byteLength('alpha\n') + Buffer.byteLength('beta\n'));
  assert.equal(latest.finishedAt, 500);
  assert.equal(existsSync(path.join(runsDir, 'active.lock')), false);
});

test('configureStagedExtension keeps persisted output metadata when setup finishes as failed', async (t) => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
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
      catalogStatus: 'known',
    },
  };
  const controlled = createControlledSpawn({
    pid: 6223,
    command: 'python3',
    args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
    cwd: stagePath,
  });
  const nowValues = [520, 560, 610];
  let nowIndex = 0;

  const resultPromise = configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => inspection,
      spawnImpl: controlled.spawnImpl,
      now: () => nowValues[nowIndex++],
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  controlled.child.stderr.emit('data', Buffer.from('fatal\n'));
  controlled.child.emit('close', 9);
  const result = await resultPromise;

  const runsDir = path.join(stagePath, '.modly', 'setup-runs');
  const latest = JSON.parse(readFileSync(path.join(runsDir, 'latest.json'), 'utf8'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.journal.status, 'failed');
  assert.equal(result.journal.lastOutputAt, 560);
  assert.equal(result.journal.stdoutBytes, 0);
  assert.equal(result.journal.stderrBytes, Buffer.byteLength('fatal\n'));
  assert.equal(result.journal.totalBytes, Buffer.byteLength('fatal\n'));
  assert.equal(latest.exitCode, 9);
  assert.equal(readFileSync(latest.logPath, 'utf8'), 'fatal\n');
});

test('configureStagedExtension rejects reentry for the same stage with setup-status guidance and without spawning', async (t) => {
  const { configureStagedExtension } = await import('../../src/core/extension-setup.mjs');
  const tempRoot = createTempRoot(t);
  const stagePath = path.join(tempRoot, 'stage');
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
      catalogStatus: 'known',
    },
  };
  const controlled = createControlledSpawn({
    pid: 5123,
    command: 'python3',
    args: ['setup.py', `{"python_exe":"python3","ext_dir":"${stagePath}"}`],
    cwd: stagePath,
  });
  const firstRun = configureStagedExtension(
    {
      stagePath,
      pythonExe: 'python3',
      allowThirdParty: true,
      setupPayload: {},
    },
    {
      inspectStage: async () => inspection,
      spawnImpl: controlled.spawnImpl,
      now: (() => {
        const values = [600, 650, 700];
        let index = 0;
        return () => values[index++];
      })(),
      isProcessAlive: (pid) => pid === 5123,
    },
  );

  await new Promise((resolve) => process.nextTick(resolve));

  let secondSpawnCalled = false;
  await assert.rejects(
    () => configureStagedExtension(
      {
        stagePath,
        pythonExe: 'python3',
        allowThirdParty: true,
        setupPayload: {},
      },
      {
        inspectStage: async () => inspection,
        spawnImpl: () => {
          secondSpawnCalled = true;
          throw new Error('second spawn should not happen');
        },
        now: () => 800,
        isProcessAlive: (pid) => pid === 5123,
      },
    ),
    (error) => {
      assert.equal(error?.code, 'SETUP_ALREADY_RUNNING');
      assert.match(error.message, /setup-status --stage-path/);
      assert.equal(error.details?.setup?.stagePath, stagePath);
      assert.equal(error.details?.setup?.pid, 5123);
      assert.match(error.details?.setup?.logPath ?? '', /\.log$/);
      return true;
    },
  );

  assert.equal(secondSpawnCalled, false);
  controlled.child.emit('close', 0);
  await firstRun;
});
