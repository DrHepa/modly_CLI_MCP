import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { main } from '../../src/cli/index.mjs';
import { UnsupportedOperationError, UsageError, ValidationError } from '../../src/core/errors.mjs';
import { runExtCommand } from '../../src/cli/commands/ext.mjs';
import { renderExtHelp, renderHelp } from '../../src/cli/help.mjs';

function createTempStage(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-cli-ext-test-'));
  const stagePath = path.join(tempRoot, 'stage');
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return stagePath;
}

function writeManifest(stagePath, manifest) {
  mkdirSync(stagePath, { recursive: true });
  writeFileSync(path.join(stagePath, 'manifest.json'), JSON.stringify(manifest));
}

async function captureStderr(fn) {
  const writes = [];
  const originalWrite = process.stderr.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    writes.push(String(chunk));

    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }

    return true;
  });

  try {
    const result = await fn();
    return { result, stderr: writes.join('') };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function createPreparedStagingResult(overrides = {}) {
  return {
    status: 'prepared',
    source: { kind: 'github', repo: 'octo/tools', ref: 'main', resolvedRef: 'abc123' },
    stagePath: '/tmp/modly-ext-stage-123',
    manifestSummary: {
      present: true,
      readable: true,
      id: 'octo.tools',
      name: 'Octo Tools',
      version: '1.0.0',
      extensionType: 'node',
    },
    checks: [
      { id: 'manifest.present', status: 'pass' },
      { id: 'manifest.readable', status: 'pass' },
      { id: 'manifest.id', status: 'pass' },
      { id: 'extension.type', status: 'pass', detail: 'node' },
      { id: 'dependency.markers', status: 'warn', detail: ['package.json'] },
      { id: 'build.markers', status: 'warn', detail: ['tsconfig.json'] },
    ],
    warnings: [{ code: 'MANUAL_DEPENDENCIES_REQUIRED', message: 'manual deps' }],
    nextManualActions: [{ id: 'install-deps', message: 'run install manually' }],
    diagnostics: null,
    ...overrides,
  };
}

function createApplyResult(overrides = {}) {
  return {
    status: 'applied',
    applied: true,
    stagePath: '/tmp/modly-ext-stage-123',
    manifest: {
      id: 'octo.tools',
      name: 'Octo Tools',
      version: '1.0.0',
      extensionType: 'node',
    },
    resolution: {
      extensionsDir: '/opt/modly/extensions',
      source: 'cli-flag',
      verified: true,
    },
    destination: {
      path: '/opt/modly/extensions/octo.tools',
      exists: true,
    },
    backup: {
      path: '/opt/modly/extensions/octo.tools.backup',
      expected: true,
      created: true,
      restored: null,
    },
    reload: {
      requested: true,
      succeeded: true,
    },
    errors: {
      observed: true,
      matched: [],
    },
    warnings: [],
    ...overrides,
  };
}

function createRepairResult(overrides = {}) {
  return {
    status: 'repaired',
    repaired: true,
    stagePath: '/tmp/modly-ext-stage-123',
    manifest: {
      id: 'octo.tools',
      name: 'Octo Tools',
      version: '1.0.0',
      extensionType: 'node',
    },
    resolution: {
      extensionsDir: '/opt/modly/extensions',
      source: 'cli-flag',
      verified: true,
    },
    destination: {
      path: '/opt/modly/extensions/octo.tools',
      exists: true,
    },
    backup: {
      path: null,
      expected: false,
      created: false,
      restored: null,
    },
    reload: {
      requested: true,
      succeeded: true,
    },
    errors: {
      observed: true,
      matched: [],
    },
    warnings: [],
    ...overrides,
  };
}

function createSetupResult(overrides = {}) {
  return {
    status: 'configured',
    blocked: false,
    catalogStatus: 'known',
    stagePath: '/tmp/modly-ext-stage-123',
    plan: {
      consentGranted: true,
      cwd: '/tmp/modly-ext-stage-123',
      command: 'python3',
      args: ['setup.py', '{"apiBaseUrl":"https://api.example.test"}'],
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        catalogStatus: 'known',
        requiredPayloadInputs: ['apiBaseUrl'],
        injectedInputs: ['python_exe', 'ext_dir'],
      },
    },
    blockers: [],
    execution: {
      startedAt: 100,
      finishedAt: 150,
      durationMs: 50,
      exitCode: 0,
      stdout: 'configured',
      stderr: '',
    },
    artifacts: {
      before: {
        status: 'prepared',
        warnings: [],
        manifestSummary: { id: 'octo.tools' },
        setupContract: {
          kind: 'python-root-setup-py',
          entry: 'setup.py',
          catalogStatus: 'known',
          requiredPayloadInputs: ['apiBaseUrl'],
          injectedInputs: ['python_exe', 'ext_dir'],
        },
      },
      after: {
        status: 'prepared',
        warnings: [],
        manifestSummary: { id: 'octo.tools' },
        setupContract: {
          kind: 'python-root-setup-py',
          entry: 'setup.py',
          catalogStatus: 'known',
          requiredPayloadInputs: ['apiBaseUrl'],
          injectedInputs: ['python_exe', 'ext_dir'],
        },
      },
    },
    ...overrides,
  };
}

test('runExtCommand surfaces catalog status and missing required inputs honestly for blocked setup', async () => {
  const setup = createSetupResult({
    status: 'blocked',
    blocked: true,
    blockers: [
      {
        code: 'SETUP_INPUT_REQUIRED',
        message: 'The staged setup contract requires explicit setup payload inputs before execution.',
        detail: ['gpu_sm'],
      },
    ],
    execution: null,
    plan: {
      consentGranted: true,
      cwd: '/tmp/modly-ext-stage-123',
      command: 'python3',
      args: ['setup.py', '{}'],
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        catalogStatus: 'known',
        requiredPayloadInputs: ['gpu_sm'],
        injectedInputs: ['python_exe', 'ext_dir'],
      },
    },
  });

  const result = await runExtCommand({
    args: ['setup', '--stage-path', 'tmp/stage/hunyuan3d-mini', '--python-exe', 'python3', '--allow-third-party'],
    config: {},
    client: {},
    async configureStagedExtension() {
      return setup;
    },
  });

  assert.equal(result.data.setup.catalogStatus, 'known');
  assert.match(result.humanMessage, /catalog support: known/u);
  assert.match(result.humanMessage, /missing setup inputs: gpu_sm/u);
  assert.match(result.humanMessage, /blockers: 1/u);
});

test('runExtCommand marks unknown setup contracts as limited support instead of universal support', async () => {
  const setup = createSetupResult({
    catalogStatus: 'unknown',
    plan: {
      consentGranted: true,
      cwd: '/tmp/modly-ext-stage-123',
      command: 'python3',
      args: ['setup.py', '{}'],
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        catalogStatus: 'unknown',
        requiredPayloadInputs: [],
        injectedInputs: ['python_exe', 'ext_dir'],
      },
    },
  });

  const result = await runExtCommand({
    args: ['setup', '--stage-path', 'tmp/stage/random.setup', '--python-exe', 'python3', '--allow-third-party'],
    config: {},
    client: {},
    async configureStagedExtension() {
      return setup;
    },
  });

  assert.equal(result.data.setup.catalogStatus, 'unknown');
  assert.match(result.humanMessage, /catalog support: unknown/u);
  assert.match(result.humanMessage, /limited catalog support; not universal setup compatibility/u);
  assert.doesNotMatch(result.humanMessage, /compatible with any extension|universal support/u);
});

test('runExtCommand states pip-based network resilience can be partial when setup manages downloads itself', async () => {
  const setup = createSetupResult();

  const result = await runExtCommand({
    args: ['setup', '--stage-path', 'tmp/stage/octo.tools', '--python-exe', 'python3', '--allow-third-party'],
    config: {},
    client: {},
    async configureStagedExtension() {
      return setup;
    },
  });

  assert.match(result.humanMessage, /PIP_\* runner policy may help only partially—or not at all—if setup\.py ignores those variables or performs its own downloads/u);
});

test('help advertises ext stage github as preflight only, ext apply as live-target, and ext setup-status as target-scoped', () => {
  const globalHelp = renderHelp();
  const extHelp = renderExtHelp();

  assert.match(globalHelp, /ext <subcomando>\s+reload \| errors \| stage github \| apply \| setup \| setup-status \| repair/u);
  assert.match(globalHelp, /stage github\s+Stage\/preflight only desde GitHub; prepara e inspecciona, NO instala ni aplica en vivo/u);
  assert.match(globalHelp, /apply\s+Instala un stage YA preparado sobre el target vivo; requiere --extensions-dir explícito y puede disparar setup live-target si el stage lo exige/u);
  assert.match(globalHelp, /setup\s+Ejecuta SOLO un contrato explícito/u);
  assert.match(globalHelp, /setup-status\s+Lee SOLO el journal del target instalado del último setup observable/u);
  assert.match(globalHelp, /repair\s+Reaplica un stage YA preparado; puede disparar setup live-target si el stage lo exige/u);
  assert.doesNotMatch(globalHelp, /install headless|live install|auto-reload|repair automático|setup automático/u);

  assert.match(extHelp, /modly ext stage github --repo <owner\/name>/u);
  assert.match(extHelp, /modly ext apply --stage-path <path> --extensions-dir <abs-path> \[--source-repo <owner\/name> --source-ref <ref> --source-commit <sha>\] \[--python-exe <exe>\] \[--allow-third-party\] \[--setup-payload-json '\{\.\.\.\}'\]/u);
  assert.match(extHelp, /modly ext setup --stage-path <path> --python-exe <exe> --allow-third-party/u);
  assert.match(extHelp, /modly ext setup-status --extensions-dir <abs-path> \(--manifest-id <id> \| --stage-path <path>\) \[--wait\] \[--follow\] \[--interval-ms <n>\] \[--timeout-ms <n>\]/u);
  assert.match(extHelp, /modly ext repair --stage-path <path> --extensions-dir <abs-path> \[--source-repo <owner\/name> --source-ref <ref> --source-commit <sha>\] \[--python-exe <exe>\] \[--allow-third-party\] \[--setup-payload-json '\{\.\.\.\}'\]/u);
  assert.match(extHelp, /instala un stage ya preparado sobre el target vivo/u);
  assert.match(extHelp, /puede disparar setup live-target si el contrato del stage lo requiere/u);
  assert.match(extHelp, /acepta --python-exe, --allow-third-party y --setup-payload-json para reenviarlos al setup live-target/u);
  assert.match(extHelp, /setup CLI-only sobre un stage ya preparado/u);
  assert.match(extHelp, /setup-status\s+lee SOLO el journal live-target del target instalado/u);
  assert.match(extHelp, /requiere --extensions-dir explícito y \(--manifest-id o --stage-path solo para resolver manifest\.id\)/u);
  assert.match(extHelp, /NO reatacha, NO cancela y NO es un job manager general/u);
  assert.match(extHelp, /--wait espera localmente hasta un estado terminal observable del journal/u);
  assert.match(extHelp, /--follow sigue localmente el logPath del run observable más reciente/u);
  assert.match(extHelp, /--timeout-ms solo corta la espera\/follow de la CLI; NO mata ni cancela el setup subyacente/u);
  assert.match(extHelp, /sin background manager, reattach ni resume generalista/u);
  assert.match(extHelp, /soporte catalogado y limitado; no promete compatibilidad universal/u);
  assert.match(extHelp, /la resiliencia de red basada en PIP_\* puede dar beneficio parcial o nulo si setup\.py ignora esas variables o hace sus propias descargas/u);
  assert.match(extHelp, /python_exe y ext_dir se auto-inyectan desde la CLI y el stage/u);
  assert.match(extHelp, /requiere consentimiento explícito porque ejecuta código de terceros/u);
  assert.match(extHelp, /repair como reapply CLI-only sobre un stage ya preparado/u);
  assert.match(extHelp, /ext repair acepta --python-exe, --allow-third-party y --setup-payload-json para reenviarlos al setup live-target cuando el stage lo requiera/u);
  assert.match(extHelp, /puede disparar setup live-target si el stage lo exige/u);
  assert.match(extHelp, /NO hace fetch GitHub, install, build ni health-fix general/u);
  assert.doesNotMatch(extHelp, /repair puede.*nunca|repair.*NO hace.*setup implícito/u);
  assert.match(extHelp, /staging\/preflight only/u);
  assert.match(extHelp, /No expone capability MCP estable/u);
  assert.match(extHelp, /NO instala ni aplica en vivo/u);
});

test('runExtCommand renders live-target setup-status from --extensions-dir and --manifest-id', async () => {
  const extensionsDir = '/opt/modly/extensions';
  const targetPath = `${extensionsDir}/octo.tools`;
  const setupStatus = {
    status: 'running',
    scope: 'live-target-journal',
    runId: 'run-123',
    manifestId: 'octo.tools',
    targetPath,
    pid: 4312,
    logPath: `${targetPath}/.modly/setup-runs/run-123.log`,
    startedAt: '2026-04-19T16:40:00.000Z',
    lastOutputAt: '2026-04-19T16:40:05.000Z',
    finishedAt: null,
    exitCode: null,
    signal: null,
    attempt: 2,
    maxAttempts: 3,
    failureClass: 'transient_network',
    retryable: true,
    attempts: [
      {
        attempt: 1,
        startedAt: '2026-04-19T16:40:00.000Z',
        finishedAt: '2026-04-19T16:40:02.000Z',
        exitCode: 1,
        failureClass: 'transient_network',
        retryable: true,
      },
      {
        attempt: 2,
        startedAt: '2026-04-19T16:40:03.000Z',
        finishedAt: null,
        exitCode: null,
        failureClass: 'transient_network',
        retryable: true,
      },
    ],
  };

  const result = await runExtCommand({
    args: ['setup-status', '--extensions-dir', extensionsDir, '--manifest-id', 'octo.tools'],
    config: {},
    client: {},
    reconcileLatestSetupRun(inputTargetPath) {
      assert.equal(inputTargetPath, targetPath);
      return setupStatus;
    },
  });

  assert.deepEqual(result.data, { setupStatus });
  assert.match(result.humanMessage, /Live target setup status: running/u);
  assert.match(result.humanMessage, /scope: live-target-journal/u);
  assert.match(result.humanMessage, /manifestId: octo.tools/u);
  assert.match(result.humanMessage, /targetPath: \/opt\/modly\/extensions\/octo\.tools/u);
  assert.match(result.humanMessage, /pid: 4312/u);
  assert.match(result.humanMessage, /logPath: .*run-123\.log/u);
  assert.match(result.humanMessage, /attempt: 2\/3/u);
  assert.match(result.humanMessage, /failureClass: transient_network/u);
  assert.match(result.humanMessage, /retryable: yes/u);
  assert.match(result.humanMessage, /No reattach, cancel, ni job control general is available from this command/u);
});

test('runExtCommand resolves --stage-path only to manifest id and still reads the installed target journal', async (t) => {
  const stagePath = createTempStage(t);
  const extensionsDir = path.join(path.dirname(stagePath), 'extensions');
  const targetPath = path.join(extensionsDir, 'octo.tools');
  writeManifest(stagePath, { id: 'octo.tools', name: 'Octo Tools', version: '1.0.0' });

  const result = await runExtCommand({
    args: ['setup-status', '--stage-path', stagePath, '--extensions-dir', extensionsDir],
    config: {},
    client: {},
    reconcileLatestSetupRun(inputTargetPath) {
      assert.equal(inputTargetPath, targetPath);
      return {
        status: 'succeeded',
        scope: 'live-target-journal',
        manifestId: 'octo.tools',
        targetPath,
        runId: 'run-789',
        pid: 789,
        logPath: `${targetPath}/.modly/setup-runs/run-789.log`,
        startedAt: '2026-04-19T16:41:00.000Z',
        lastOutputAt: '2026-04-19T16:41:10.000Z',
        finishedAt: '2026-04-19T16:41:20.000Z',
        exitCode: 0,
        signal: null,
      };
    },
  });

  assert.equal(result.data.setupStatus.status, 'succeeded');
  assert.equal(result.data.setupStatus.scope, 'live-target-journal');
  assert.equal(result.data.setupStatus.manifestId, 'octo.tools');
  assert.equal(result.data.setupStatus.targetPath, targetPath);
  assert.match(result.humanMessage, /Live target setup status: succeeded/u);
  assert.match(result.humanMessage, /targetPath: .*extensions\/octo\.tools/u);
  assert.doesNotMatch(result.humanMessage, /stage-scoped|local stage/u);
});

test('runExtCommand reports unknown setup-status when no live-target journal exists yet', async () => {
  const extensionsDir = '/opt/modly/extensions';
  const targetPath = `${extensionsDir}/octo.tools`;

  const result = await runExtCommand({
    args: ['setup-status', '--extensions-dir', extensionsDir, '--manifest-id', 'octo.tools'],
    config: {},
    client: {},
  });

  assert.equal(result.data.setupStatus.status, 'unknown');
  assert.equal(result.data.setupStatus.scope, 'live-target-journal');
  assert.equal(result.data.setupStatus.manifestId, 'octo.tools');
  assert.equal(result.data.setupStatus.targetPath, targetPath);
  assert.equal(result.data.setupStatus.runId, null);
  assert.equal(result.data.setupStatus.logPath, null);
  assert.match(result.humanMessage, /Live target setup status: unknown/u);
  assert.match(result.humanMessage, /No observable setup journal was found for this live target yet/u);
  assert.doesNotMatch(result.humanMessage, /stage-scoped|local stage|fallback/u);
});

test('main emits JSON envelope with data.setupStatus for ext setup-status', async () => {
  const writes = [];
  const setupStatus = {
    status: 'failed',
    scope: 'live-target-journal',
    runId: 'run-999',
    manifestId: 'octo.tools',
    targetPath: '/opt/modly/extensions/octo.tools',
    pid: 999,
    logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-999.log',
    startedAt: '2026-04-19T16:50:00.000Z',
    lastOutputAt: '2026-04-19T16:50:10.000Z',
    finishedAt: '2026-04-19T16:50:30.000Z',
    exitCode: 9,
    signal: null,
    attempt: 3,
    maxAttempts: 3,
    failureClass: 'transient_network',
    retryable: false,
    attempts: [
      { attempt: 1, startedAt: '2026-04-19T16:50:00.000Z', finishedAt: '2026-04-19T16:50:05.000Z', exitCode: 1, failureClass: 'transient_network', retryable: true },
      { attempt: 2, startedAt: '2026-04-19T16:50:06.000Z', finishedAt: '2026-04-19T16:50:10.000Z', exitCode: 1, failureClass: 'transient_network', retryable: true },
      { attempt: 3, startedAt: '2026-04-19T16:50:11.000Z', finishedAt: '2026-04-19T16:50:30.000Z', exitCode: 9, failureClass: 'transient_network', retryable: false },
    ],
  };

  const exitCode = await main(['--json', 'ext', 'setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools'], {
    stdout: { write(chunk) { writes.push(chunk); } },
    stderr: { write() {} },
    env: {},
    cwd: '/workspace/modly_CLI_MCP',
    platform: 'linux',
    createClient() {
      return {};
    },
    reconcileLatestSetupRun() {
      return setupStatus;
    },
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.setupStatus.status, 'failed');
  assert.equal(payload.data.setupStatus.scope, 'live-target-journal');
  assert.equal(payload.data.setupStatus.targetPath, '/opt/modly/extensions/octo.tools');
  assert.equal(payload.data.setupStatus.exitCode, 9);
  assert.equal(payload.data.setupStatus.attempt, 3);
  assert.equal(payload.data.setupStatus.maxAttempts, 3);
  assert.equal(payload.data.setupStatus.failureClass, 'transient_network');
  assert.equal(payload.data.setupStatus.retryable, false);
  assert.equal(payload.data.setupStatus.attempts.length, 3);
});

test('runExtCommand rejects setup-status polling timing flags without a continuous mode', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--interval-ms', '250'],
      config: {},
      client: {},
    }),
    (error) => {
      assert.equal(error?.code, 'VALIDATION_ERROR');
      assert.equal(error?.message, '--interval-ms requires --wait or --follow.');
      return true;
    },
  );

  await assert.rejects(
    runExtCommand({
      args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--timeout-ms', '1000'],
      config: {},
      client: {},
    }),
    (error) => {
      assert.equal(error?.code, 'VALIDATION_ERROR');
      assert.equal(error?.message, '--timeout-ms requires --wait or --follow.');
      return true;
    },
  );
});

test('runExtCommand accepts setup-status continuous flags and validates positive integers before execution', async () => {
  const calls = [];
  const snapshots = [
    {
      status: 'running',
      runId: 'run-123',
      pid: 1234,
      logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-123.log',
      startedAt: '2026-04-20T01:00:00.000Z',
      lastOutputAt: '2026-04-20T01:00:01.000Z',
      finishedAt: null,
      exitCode: null,
      signal: null,
    },
    {
      status: 'succeeded',
      runId: 'run-123',
      pid: 1234,
      logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-123.log',
      startedAt: '2026-04-20T01:00:00.000Z',
      lastOutputAt: '2026-04-20T01:00:02.000Z',
      finishedAt: '2026-04-20T01:00:03.000Z',
      exitCode: 0,
      signal: null,
    },
  ];

  const result = await runExtCommand({
    args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--wait', '--follow', '--interval-ms', '250', '--timeout-ms', '1000'],
    config: {},
    client: {},
    reconcileLatestSetupRun(targetPath) {
      calls.push(targetPath);
      return snapshots.shift() ?? snapshots.at(-1);
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.data.setupStatus.status, 'succeeded');
  assert.equal(result.data.meta.polling.attempts, 2);

  await assert.rejects(
    runExtCommand({
      args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--wait', '--interval-ms', '0'],
      config: {},
      client: {},
    }),
    (error) => {
      assert.equal(error?.code, 'VALIDATION_ERROR');
      assert.equal(error?.message, '--interval-ms must be >= 1.');
      return true;
    },
  );

  await assert.rejects(
    runExtCommand({
      args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--follow', '--timeout-ms', 'abc'],
      config: {},
      client: {},
    }),
    (error) => {
      assert.equal(error?.code, 'VALIDATION_ERROR');
      assert.equal(error?.message, '--timeout-ms must be an integer.');
      return true;
    },
  );
});

test('main emits polling metadata for ext setup-status --wait after the live-target journal reaches success', async () => {
  const writes = [];
  const targetPath = '/opt/modly/extensions/octo.tools';
  let attempts = 0;

  const exitCode = await main([
    '--json',
    'ext',
    'setup-status',
    '--extensions-dir',
    '/opt/modly/extensions',
    '--manifest-id',
    'octo.tools',
    '--wait',
    '--interval-ms',
    '1',
    '--timeout-ms',
    '50',
  ], {
    stdout: { write(chunk) { writes.push(chunk); } },
    stderr: { write() {} },
    env: {},
    cwd: '/workspace/modly_CLI_MCP',
    platform: 'linux',
    createClient() {
      return {};
    },
    reconcileLatestSetupRun() {
      attempts += 1;
      return attempts === 1
        ? {
            status: 'running',
            runId: 'run-123',
            pid: 123,
            logPath: `${targetPath}/.modly/setup-runs/run-123.log`,
            startedAt: '2026-04-20T02:00:00.000Z',
            lastOutputAt: '2026-04-20T02:00:01.000Z',
            finishedAt: null,
            exitCode: null,
            signal: null,
          }
        : {
            status: 'succeeded',
            runId: 'run-123',
            pid: 123,
            logPath: `${targetPath}/.modly/setup-runs/run-123.log`,
            startedAt: '2026-04-20T02:00:00.000Z',
            lastOutputAt: '2026-04-20T02:00:02.000Z',
            finishedAt: '2026-04-20T02:00:03.000Z',
            exitCode: 0,
            signal: null,
            stdoutBytes: 4,
            stderrBytes: 0,
            totalBytes: 4,
          };
    },
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.setupStatus.status, 'succeeded');
  assert.equal(payload.data.setupStatus.totalBytes, 4);
  assert.equal(payload.data.meta.polling.intervalMs, 1);
  assert.equal(payload.data.meta.polling.timeoutMs, 50);
  assert.equal(payload.data.meta.polling.attempts, 2);
});

test('runExtCommand returns interrupted terminal setup-status snapshots when waiting and surfaces staleReason telemetry', async () => {
  const targetPath = '/opt/modly/extensions/octo.tools';
  let attempts = 0;

  const result = await runExtCommand({
    args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--wait', '--interval-ms', '1', '--timeout-ms', '50'],
    config: {},
    client: {},
    reconcileLatestSetupRun() {
      attempts += 1;
      return attempts === 1
        ? {
            status: 'running',
            runId: 'run-stale',
            pid: 321,
            logPath: `${targetPath}/.modly/setup-runs/run-stale.log`,
            startedAt: '2026-04-20T02:01:00.000Z',
            lastOutputAt: '2026-04-20T02:01:01.000Z',
            finishedAt: null,
            exitCode: null,
            signal: null,
          }
        : {
            status: 'interrupted',
            runId: 'run-stale',
            pid: 321,
            logPath: `${targetPath}/.modly/setup-runs/run-stale.log`,
            startedAt: '2026-04-20T02:01:00.000Z',
            lastOutputAt: '2026-04-20T02:01:01.000Z',
            finishedAt: '2026-04-20T02:01:04.000Z',
            exitCode: null,
            signal: null,
            stdoutBytes: 12,
            stderrBytes: 3,
            totalBytes: 15,
            staleReason: 'pid_not_alive',
          };
    },
  });

  assert.equal(result.data.setupStatus.status, 'interrupted');
  assert.equal(result.data.setupStatus.staleReason, 'pid_not_alive');
  assert.equal(result.data.setupStatus.stdoutBytes, 12);
  assert.equal(result.data.setupStatus.stderrBytes, 3);
  assert.equal(result.data.setupStatus.totalBytes, 15);
  assert.equal(result.data.meta.polling.attempts, 2);
  assert.match(result.humanMessage, /Live target setup status: interrupted/u);
  assert.match(result.humanMessage, /staleReason: pid_not_alive/u);
  assert.match(result.humanMessage, /stdoutBytes: 12/u);
  assert.match(result.humanMessage, /stderrBytes: 3/u);
  assert.match(result.humanMessage, /totalBytes: 15/u);
});

test('runExtCommand times out locally while waiting for setup-status and clarifies the observed setup may still be running', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--wait', '--interval-ms', '1', '--timeout-ms', '5'],
      config: {},
      client: {},
      reconcileLatestSetupRun() {
        return {
          status: 'running',
          runId: 'run-timeout',
          pid: 555,
          logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-timeout.log',
          startedAt: '2026-04-20T02:02:00.000Z',
          lastOutputAt: '2026-04-20T02:02:01.000Z',
          finishedAt: null,
          exitCode: null,
          signal: null,
        };
      },
    }),
    (error) => {
      assert.equal(error?.code, 'TIMEOUT');
      assert.match(error?.message, /setup-status observer timed out locally before reaching a terminal state/u);
      assert.match(error?.message, /The observed setup may still be running/u);
      assert.doesNotMatch(error?.message, /cancel|reattach|resume|background manager/u);
      assert.equal(error?.details?.timeoutMs, 5);
      assert.equal(error?.details?.intervalMs, 1);
      assert.equal(error?.details?.lastObservedRun?.status, 'running');
      return true;
    },
  );
});

test('runExtCommand follows appended setup log output and returns final telemetry from the terminal journal snapshot', async (t) => {
  const stagePath = createTempStage(t);
  const extensionsDir = path.join(path.dirname(stagePath), 'extensions');
  const targetPath = path.join(extensionsDir, 'octo.tools');
  const logPath = path.join(targetPath, '.modly', 'setup-runs', 'run-follow.log');
  writeManifest(stagePath, { id: 'octo.tools', name: 'Octo Tools', version: '1.0.0' });
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, 'boot\n');

  let attempts = 0;
  const { result, stderr } = await captureStderr(() => runExtCommand({
    args: ['setup-status', '--stage-path', stagePath, '--extensions-dir', extensionsDir, '--follow', '--interval-ms', '1', '--timeout-ms', '50'],
    config: {},
    client: {},
    reconcileLatestSetupRun() {
      attempts += 1;

      if (attempts === 1) {
        return {
          status: 'running',
          runId: 'run-follow',
          pid: 777,
          logPath,
          startedAt: '2026-04-20T02:03:00.000Z',
          lastOutputAt: '2026-04-20T02:03:01.000Z',
          finishedAt: null,
          exitCode: null,
          signal: null,
          stdoutBytes: 5,
          stderrBytes: 0,
          totalBytes: 5,
        };
      }

      appendFileSync(logPath, 'done\n');
      return {
        status: 'succeeded',
        runId: 'run-follow',
        pid: 777,
        logPath,
        startedAt: '2026-04-20T02:03:00.000Z',
        lastOutputAt: '2026-04-20T02:03:02.000Z',
        finishedAt: '2026-04-20T02:03:03.000Z',
        exitCode: 0,
        signal: null,
        stdoutBytes: 10,
        stderrBytes: 0,
        totalBytes: 10,
      };
    },
  }));

  assert.match(stderr, /boot\n/u);
  assert.match(stderr, /done\n/u);
  assert.equal(result.data.setupStatus.status, 'succeeded');
  assert.equal(result.data.setupStatus.logPath, logPath);
  assert.equal(result.data.setupStatus.totalBytes, 10);
  assert.equal(result.data.meta.polling.attempts, 2);
});

test('runExtCommand rejects --follow when no followable setup run log is available', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['setup-status', '--extensions-dir', '/opt/modly/extensions', '--manifest-id', 'octo.tools', '--follow', '--interval-ms', '1', '--timeout-ms', '50'],
      config: {},
      client: {},
      reconcileLatestSetupRun() {
        return {
          status: 'running',
          runId: 'run-without-log',
          pid: 909,
          logPath: null,
          startedAt: '2026-04-20T02:04:00.000Z',
          lastOutputAt: null,
          finishedAt: null,
          exitCode: null,
          signal: null,
        };
      },
    }),
    (error) => {
      assert.equal(error?.code, 'VALIDATION_ERROR');
      assert.match(error?.message, /No followable setup run log is available for this live target/u);
      assert.doesNotMatch(error?.message, /reattach|cancel|resume|background manager/u);
      return true;
    },
  );
});

test('main surfaces ext setup reentry as local stage-scoped guidance toward setup-status', async () => {
  const writes = [];
  const stagePath = '/tmp/modly-ext-stage-123';

  await assert.rejects(
    () => main(['ext', 'setup', '--stage-path', stagePath, '--python-exe', 'python3', '--allow-third-party'], {
      stdout: { write(chunk) { writes.push(chunk); } },
      stderr: { write() {} },
      env: {},
      cwd: '/workspace/modly_CLI_MCP',
      platform: 'linux',
      createClient() {
        return {};
      },
      async configureStagedExtension() {
        throw new ValidationError('Another setup run is already active for this stage path.', {
          code: 'SETUP_ALREADY_RUNNING',
          details: {
            setup: {
              stagePath,
              logPath: `${stagePath}/.modly/setup-runs/run-123.log`,
              statusCommand: `modly ext setup-status --stage-path "${stagePath}"`,
            },
          },
        });
      },
    }),
    (error) => {
      assert.equal(error?.code, 'SETUP_ALREADY_RUNNING');
      assert.match(error.message, /Local stage-scoped setup is already running/u);
      assert.match(error.message, /setup-status --stage-path/u);
      assert.match(error.message, /run-123\.log/u);
      return true;
    },
  );

  assert.deepEqual(writes, []);
});

test('runExtCommand delegates ext setup to the reusable core with explicit third-party consent and payload', async () => {
  const calls = [];
  const setup = createSetupResult();

  const result = await runExtCommand({
    args: [
      'setup',
      '--stage-path',
      'tmp/stage/octo.tools',
      '--python-exe',
      'python3',
      '--allow-third-party',
      '--setup-payload-json',
      '{"apiBaseUrl":"https://api.example.test"}',
    ],
    config: {},
    client: {},
    async configureStagedExtension(input) {
      calls.push(input);
      return setup;
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    stagePath: 'tmp/stage/octo.tools',
    pythonExe: 'python3',
    allowThirdParty: true,
    setupPayload: { apiBaseUrl: 'https://api.example.test' },
  });
  assert.deepEqual(result.data, { setup });
  assert.match(result.humanMessage, /CLI-only staged setup: configured/u);
  assert.match(result.humanMessage, /stagePath: \/tmp\/modly-ext-stage-123/u);
  assert.match(result.humanMessage, /contract: python-root-setup-py/u);
  assert.match(result.humanMessage, /third-party execution: consent granted explicitly/u);
  assert.match(result.humanMessage, /No install completo, apply, repair, ni build implícito fue intentado/u);
});

test('runExtCommand preserves blocked setup status honestly when third-party consent was not granted', async () => {
  const setup = createSetupResult({
    status: 'blocked',
    blocked: true,
    plan: {
      consentGranted: false,
      cwd: '/tmp/modly-ext-stage-123',
      command: 'python3',
      args: ['setup.py', '{}'],
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
      },
    },
    blockers: [
      {
        code: 'THIRD_PARTY_CONSENT_REQUIRED',
        message: 'Explicit --allow-third-party consent is required before executing staged setup contracts.',
      },
    ],
    execution: null,
  });

  const result = await runExtCommand({
    args: ['setup', '--stage-path', 'tmp/stage/octo.tools', '--python-exe', 'python3'],
    config: {},
    client: {},
    async configureStagedExtension() {
      return setup;
    },
  });

  assert.equal(result.data.setup.status, 'blocked');
  assert.match(result.humanMessage, /CLI-only staged setup: blocked/u);
  assert.match(result.humanMessage, /third-party execution: consent NOT granted/u);
  assert.match(result.humanMessage, /blockers: 1/u);
  assert.doesNotMatch(result.humanMessage, /install complete|dependencies installed|repair completed/u);
});

test('runExtCommand requires --stage-path for ext setup', async () => {
  await assert.rejects(
    runExtCommand({ args: ['setup', '--python-exe', 'python3', '--allow-third-party'], config: {}, client: {} }),
    UsageError,
  );
});

test('runExtCommand requires --python-exe for ext setup before delegating to core', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['setup', '--stage-path', 'tmp/stage/octo.tools', '--allow-third-party'],
      config: {},
      client: {},
      async configureStagedExtension() {
        throw new Error('configureStagedExtension should not be called without --python-exe');
      },
    }),
    UsageError,
  );
});

test('main emits JSON envelope with data.setup for ext setup', async () => {
  const writes = [];
  const setup = createSetupResult({ status: 'configured_degraded' });

  const exitCode = await main([
    '--json',
    'ext',
    'setup',
    '--stage-path',
    'tmp/stage/octo.tools',
    '--python-exe',
    'python3',
    '--allow-third-party',
    '--setup-payload-json',
    '{"apiBaseUrl":"https://api.example.test"}',
  ], {
    stdout: { write(chunk) { writes.push(chunk); } },
    stderr: { write() {} },
    env: {},
    cwd: '/workspace/modly_CLI_MCP',
    platform: 'linux',
    createClient() {
      return {};
    },
    configureStagedExtension: async () => setup,
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.setup.status, 'configured_degraded');
  assert.equal(payload.data.setup.plan.command, 'python3');
});

test('runExtCommand delegates ext repair to the reusable core with explicit stage and extensions paths plus live-target setup flags', async () => {
  const calls = [];
  const repair = createRepairResult();
  const client = {
    async reloadExtensions() {},
    async getExtensionErrors() { return []; },
  };

  const result = await runExtCommand({
    args: [
      'repair',
      '--stage-path',
      'tmp/stage/octo.tools',
      '--extensions-dir',
      '/opt/modly/extensions',
      '--source-repo',
      'octo/tools',
      '--source-ref',
      'main',
      '--source-commit',
      'abc123',
      '--python-exe',
      'python3.11',
      '--allow-third-party',
      '--setup-payload-json',
      '{"gpu_sm":"89","apiBaseUrl":"https://api.example.test"}',
    ],
    config: {},
    client,
    async repairStagedExtension(input, deps) {
      calls.push({ input, deps });
      return repair;
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    stagePath: 'tmp/stage/octo.tools',
    extensionsDir: '/opt/modly/extensions',
    sourceRepo: 'octo/tools',
    sourceRef: 'main',
    sourceCommit: 'abc123',
    pythonExe: 'python3.11',
    allowThirdParty: true,
    setupPayload: {
      gpu_sm: '89',
      apiBaseUrl: 'https://api.example.test',
    },
  });
  assert.equal(typeof calls[0].deps.reloadExtensions, 'function');
  assert.equal(typeof calls[0].deps.getExtensionErrors, 'function');
  assert.deepEqual(result.data, { repair });
  assert.equal(result.data.repair.backup.created, false);
  assert.match(result.humanMessage, /CLI-only repair\/reapply over prepared stage: repaired/u);
  assert.match(result.humanMessage, /stagePath: \/tmp\/modly-ext-stage-123/u);
  assert.match(result.humanMessage, /extensionsDir: \/opt\/modly\/extensions/u);
  assert.doesNotMatch(result.humanMessage, /backup: /u);
  assert.match(result.humanMessage, /May trigger live-target setup when the prepared stage requires it/u);
  assert.match(result.humanMessage, /No GitHub fetch, install, build, or general health fix was attempted/u);
});

test('runExtCommand reports degraded repair honestly without claiming a healthy install or dependency fix', async () => {
  const repair = createRepairResult({
    status: 'repaired_degraded',
    errors: {
      observed: true,
      matched: [{ manifestId: 'octo.tools', message: 'Import failed' }],
    },
    warnings: [
      {
        code: 'EXTENSION_RUNTIME_ERRORS',
        message: 'Extension runtime errors were observed after reload for the promoted extension.',
      },
    ],
  });

  const result = await runExtCommand({
    args: ['repair', '--stage-path', 'tmp/stage/octo.tools', '--extensions-dir', '/opt/modly/extensions'],
    config: {},
    client: {},
    async repairStagedExtension() {
      return repair;
    },
  });

  assert.equal(result.data.repair.status, 'repaired_degraded');
  assert.equal(result.data.repair.backup.expected, false);
  assert.match(result.humanMessage, /CLI-only repair\/reapply over prepared stage: repaired_degraded/u);
  assert.match(result.humanMessage, /runtime errors: 1/u);
  assert.doesNotMatch(result.humanMessage, /backup: /u);
  assert.doesNotMatch(result.humanMessage, /install complete|healthy install|dependencies repaired|health fix completed/u);
});

test('runExtCommand adds observability-only setup guidance to degraded apply results', async () => {
  const apply = createApplyResult({
    status: 'applied_degraded',
    setupObservation: {
      status: 'interrupted',
      runId: 'run-live-123',
      logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-live-123.log',
      statusCommand: 'modly ext setup-status --extensions-dir "/opt/modly/extensions" --manifest-id "octo.tools"',
      staleReason: 'pid_not_alive',
      attempt: 2,
      maxAttempts: 3,
      failureClass: 'transient_network',
      retryable: false,
      attempts: [
        {
          attempt: 1,
          startedAt: '2026-04-20T18:00:00.000Z',
          finishedAt: '2026-04-20T18:00:02.000Z',
          exitCode: 1,
          failureClass: 'transient_network',
          retryable: true,
        },
        {
          attempt: 2,
          startedAt: '2026-04-20T18:00:03.000Z',
          finishedAt: '2026-04-20T18:00:04.000Z',
          exitCode: null,
          failureClass: 'transient_network',
          retryable: false,
        },
      ],
    },
  });

  const result = await runExtCommand({
    args: ['apply', '--stage-path', 'tmp/stage/octo.tools', '--extensions-dir', '/opt/modly/extensions'],
    config: {},
    client: {},
    async applyStagedExtension() {
      return apply;
    },
  });

  assert.match(result.humanMessage, /Live-target apply from prepared stage: applied_degraded/u);
  assert.match(result.humanMessage, /Observe the live-target setup locally with: modly ext setup-status/u);
  assert.match(result.humanMessage, /setup observation: interrupted/u);
  assert.match(result.humanMessage, /attempt: 2\/3/u);
  assert.match(result.humanMessage, /failureClass: transient_network/u);
  assert.match(result.humanMessage, /retryable: no/u);
  assert.match(result.humanMessage, /runId: run-live-123/u);
  assert.match(result.humanMessage, /staleReason: pid_not_alive/u);
  assert.match(result.humanMessage, /logPath: .*run-live-123\.log/u);
  assert.match(result.humanMessage, /Observability only: this does NOT reattach, cancel, or resume the setup/u);
  assert.doesNotMatch(result.humanMessage, /background manager|job manager|reattach later/u);
});

test('runExtCommand adds observability-only setup guidance to degraded repair results', async () => {
  const repair = createRepairResult({
    status: 'repaired_degraded',
    setupObservation: {
      status: 'running',
      runId: 'run-live-456',
      logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-live-456.log',
      statusCommand: 'modly ext setup-status --extensions-dir "/opt/modly/extensions" --manifest-id "octo.tools"',
      staleReason: null,
      attempt: 1,
      maxAttempts: 1,
      failureClass: 'structural',
      retryable: false,
    },
  });

  const result = await runExtCommand({
    args: ['repair', '--stage-path', 'tmp/stage/octo.tools', '--extensions-dir', '/opt/modly/extensions'],
    config: {},
    client: {},
    async repairStagedExtension() {
      return repair;
    },
  });

  assert.match(result.humanMessage, /CLI-only repair\/reapply over prepared stage: repaired_degraded/u);
  assert.match(result.humanMessage, /Observe the live-target setup locally with: modly ext setup-status/u);
  assert.match(result.humanMessage, /setup observation: running/u);
  assert.match(result.humanMessage, /attempt: 1\/1/u);
  assert.match(result.humanMessage, /failureClass: structural/u);
  assert.match(result.humanMessage, /retryable: no/u);
  assert.match(result.humanMessage, /runId: run-live-456/u);
  assert.match(result.humanMessage, /logPath: .*run-live-456\.log/u);
  assert.doesNotMatch(result.humanMessage, /staleReason:/u);
  assert.match(result.humanMessage, /Observability only: this does NOT reattach, cancel, or resume the setup/u);
  assert.doesNotMatch(result.humanMessage, /background manager|job manager|reattach later/u);
});

test('runExtCommand surfaces apply setup reentry errors with setup-status and logPath guidance only', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['apply', '--stage-path', 'tmp/stage/octo.tools', '--extensions-dir', '/opt/modly/extensions'],
      config: {},
      client: {},
      async applyStagedExtension() {
        throw new ValidationError('setup still running', {
          code: 'APPLY_PROMOTE_FAILED',
          details: {
            apply: {
              phase: 'promote',
              setupObservation: {
                status: 'running',
                runId: 'run-live-777',
                logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-live-777.log',
                statusCommand: 'modly ext setup-status --extensions-dir "/opt/modly/extensions" --manifest-id "octo.tools"',
                staleReason: null,
              },
            },
          },
        });
      },
    }),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.match(error.message, /Inspect the live-target setup locally with modly ext setup-status/u);
      assert.match(error.message, /run-live-777\.log/u);
      assert.match(error.message, /Observability only/u);
      assert.match(error.message, /does NOT reattach, cancel, or resume the setup/u);
      assert.doesNotMatch(error.message, /background manager|cancel it for you|resume later/u);
      return true;
    },
  );
});

test('runExtCommand surfaces repair setup reentry errors with setup-status and logPath guidance only', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['repair', '--stage-path', 'tmp/stage/octo.tools', '--extensions-dir', '/opt/modly/extensions'],
      config: {},
      client: {},
      async repairStagedExtension() {
        throw new ValidationError('setup still interrupted', {
          code: 'APPLY_PROMOTE_FAILED',
          details: {
            apply: {
              phase: 'promote',
              setupObservation: {
                status: 'interrupted',
                runId: 'run-live-888',
                logPath: '/opt/modly/extensions/octo.tools/.modly/setup-runs/run-live-888.log',
                statusCommand: 'modly ext setup-status --extensions-dir "/opt/modly/extensions" --manifest-id "octo.tools"',
                staleReason: 'pid_not_alive',
              },
            },
          },
        });
      },
    }),
    (error) => {
      assert.equal(error.code, 'APPLY_PROMOTE_FAILED');
      assert.match(error.message, /Inspect the live-target setup locally with modly ext setup-status/u);
      assert.match(error.message, /run-live-888\.log/u);
      assert.match(error.message, /staleReason: pid_not_alive/u);
      assert.match(error.message, /Observability only/u);
      assert.doesNotMatch(error.message, /background manager|cancel it for you|resume later/u);
      return true;
    },
  );
});

test('runExtCommand requires --stage-path for ext repair', async () => {
  await assert.rejects(
    runExtCommand({ args: ['repair', '--extensions-dir', '/opt/modly/extensions'], config: {}, client: {} }),
    UsageError,
  );
});

test('runExtCommand requires --extensions-dir for ext repair before delegating to core', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['repair', '--stage-path', 'tmp/stage/octo.tools'],
      config: {},
      client: {},
      async repairStagedExtension() {
        throw new Error('repairStagedExtension should not be called without --extensions-dir');
      },
    }),
    UsageError,
  );
});

test('runExtCommand rejects invalid --setup-payload-json for ext repair before delegating to core', async () => {
  await assert.rejects(
    runExtCommand({
      args: [
        'repair',
        '--stage-path',
        'tmp/stage/octo.tools',
        '--extensions-dir',
        '/opt/modly/extensions',
        '--setup-payload-json',
        '{bad json}',
      ],
      config: {},
      client: {},
      async repairStagedExtension() {
        throw new Error('repairStagedExtension should not be called with invalid --setup-payload-json');
      },
    }),
    (error) => {
      assert.equal(error instanceof ValidationError, true);
      assert.match(error.message, /--setup-payload-json/u);
      return true;
    },
  );
});

test('runExtCommand delegates ext apply to the reusable core with explicit stage and extensions paths', async () => {
  const calls = [];
  const apply = createApplyResult();
  const client = {
    async reloadExtensions() {},
    async getExtensionErrors() { return []; },
  };

  const result = await runExtCommand({
    args: [
      'apply',
      '--stage-path',
      'tmp/stage/octo.tools',
      '--extensions-dir',
      '/opt/modly/extensions',
      '--source-repo',
      'octo/tools',
      '--source-ref',
      'main',
      '--source-commit',
      'abc123',
    ],
    config: {},
    client,
    async applyStagedExtension(input, deps) {
      calls.push({ input, deps });
      return apply;
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    stagePath: 'tmp/stage/octo.tools',
    extensionsDir: '/opt/modly/extensions',
    sourceRepo: 'octo/tools',
    sourceRef: 'main',
    sourceCommit: 'abc123',
    pythonExe: undefined,
    allowThirdParty: false,
    setupPayload: undefined,
  });
  assert.equal(typeof calls[0].deps.reloadExtensions, 'function');
  assert.equal(typeof calls[0].deps.getExtensionErrors, 'function');
  assert.deepEqual(result.data, { apply });
  assert.equal(result.data.apply.backup.expected, true);
  assert.equal(result.data.apply.backup.created, true);
  assert.equal(result.data.apply.backup.path, '/opt/modly/extensions/octo.tools.backup');
  assert.match(result.humanMessage, /Live-target apply from prepared stage: applied/u);
  assert.match(result.humanMessage, /stagePath: \/tmp\/modly-ext-stage-123/u);
  assert.match(result.humanMessage, /extensionsDir \(explicit\): \/opt\/modly\/extensions/u);
  assert.match(result.humanMessage, /targetPath: \/opt\/modly\/extensions\/octo\.tools/u);
  assert.match(result.humanMessage, /backup: \/opt\/modly\/extensions\/octo\.tools\.backup/u);
  assert.match(result.humanMessage, /No GitHub fetch, install, build, or repair was attempted/u);
});

test('runExtCommand forwards live-target setup flags through ext apply', async () => {
  const calls = [];
  const apply = createApplyResult({
    setup: {
      status: 'configured',
    },
  });
  const client = {
    async reloadExtensions() {},
    async getExtensionErrors() { return []; },
  };

  const result = await runExtCommand({
    args: [
      'apply',
      '--stage-path',
      'tmp/stage/octo.tools',
      '--extensions-dir',
      '/opt/modly/extensions',
      '--python-exe',
      'python3.11',
      '--allow-third-party',
      '--setup-payload-json',
      '{"gpu_sm":"89","apiBaseUrl":"https://api.example.test"}',
    ],
    config: {},
    client,
    async applyStagedExtension(input, deps) {
      calls.push({ input, deps });
      return apply;
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    stagePath: 'tmp/stage/octo.tools',
    extensionsDir: '/opt/modly/extensions',
    sourceRepo: undefined,
    sourceRef: undefined,
    sourceCommit: undefined,
    pythonExe: 'python3.11',
    allowThirdParty: true,
    setupPayload: {
      gpu_sm: '89',
      apiBaseUrl: 'https://api.example.test',
    },
  });
  assert.equal(typeof calls[0].deps.reloadExtensions, 'function');
  assert.equal(typeof calls[0].deps.getExtensionErrors, 'function');
  assert.deepEqual(result.data, { apply });
});

test('runExtCommand reports degraded apply honestly without claiming a healthy install', async () => {
  const apply = createApplyResult({
    status: 'applied_degraded',
    errors: {
      observed: true,
      matched: [{ manifestId: 'octo.tools', message: 'Import failed' }],
    },
    warnings: [
      {
        code: 'EXTENSION_RUNTIME_ERRORS',
        message: 'Extension runtime errors were observed after reload for the promoted extension.',
      },
    ],
  });

  const result = await runExtCommand({
    args: ['apply', '--stage-path', 'tmp/stage/octo.tools', '--extensions-dir', '/opt/modly/extensions'],
    config: {},
    client: {},
    async applyStagedExtension() {
      return apply;
    },
  });

  assert.equal(result.data.apply.status, 'applied_degraded');
  assert.equal(result.data.apply.backup.expected, true);
  assert.equal(result.data.apply.backup.created, true);
  assert.match(result.humanMessage, /Live-target apply from prepared stage: applied_degraded/u);
  assert.match(result.humanMessage, /backup: \/opt\/modly\/extensions\/octo\.tools\.backup/u);
  assert.match(result.humanMessage, /runtime errors: 1/u);
  assert.doesNotMatch(result.humanMessage, /install complete|repaired|healthy install/u);
});

test('runExtCommand requires --extensions-dir for ext apply before delegating to core', async () => {
  await assert.rejects(
    runExtCommand({
      args: ['apply', '--stage-path', 'tmp/stage/octo.tools'],
      config: {},
      client: {},
      async applyStagedExtension() {
        throw new Error('applyStagedExtension should not be called without --extensions-dir');
      },
    }),
    UsageError,
  );
});

test('runExtCommand requires --stage-path for ext apply', async () => {
  await assert.rejects(
    runExtCommand({ args: ['apply', '--extensions-dir', '/opt/modly/extensions'], config: {}, client: {} }),
    UsageError,
  );
});

test('runExtCommand delegates ext stage github to the reusable staging core and returns honest human wording', async () => {
  const calls = [];
  const staging = createPreparedStagingResult();

  const result = await runExtCommand({
    args: ['stage', 'github', '--repo', 'octo/tools', '--ref', 'release-1', '--staging-dir', 'tmp/stage'],
    config: {},
    client: {},
    async stageGitHubExtension(input) {
      calls.push(input);
      return staging;
    },
  });

  assert.deepEqual(calls, [{ repo: 'octo/tools', ref: 'release-1', stagingDir: 'tmp/stage' }]);
  assert.deepEqual(result.data, { staging });
  assert.match(result.humanMessage, /stage\/preflight only/u);
  assert.match(result.humanMessage, /No live install was attempted/u);
  assert.match(result.humanMessage, /octo\/tools/u);
  assert.match(result.humanMessage, /prepared/u);
});

test('runExtCommand preserves failed staging diagnostics without inventing install support', async () => {
  const staging = createPreparedStagingResult({
    status: 'failed',
    diagnostics: {
      phase: 'inspect',
      code: 'MANIFEST_MISSING',
      detail: 'manifest.json was not found.',
    },
    manifestSummary: {
      present: false,
      readable: false,
      id: null,
      name: null,
      version: null,
      extensionType: 'unknown',
    },
  });

  const result = await runExtCommand({
    args: ['stage', 'github', '--repo', 'octo/tools'],
    config: {},
    client: {},
    async stageGitHubExtension() {
      return staging;
    },
  });

  assert.equal(result.data.staging.status, 'failed');
  assert.equal(result.data.staging.diagnostics.code, 'MANIFEST_MISSING');
  assert.match(result.humanMessage, /failed/u);
  assert.match(result.humanMessage, /MANIFEST_MISSING/u);
  assert.match(result.humanMessage, /stage\/preflight only/u);
  assert.doesNotMatch(result.humanMessage, /installed|applied/u);
});

test('main emits JSON envelope with data.staging for ext stage github', async () => {
  const writes = [];
  const staging = createPreparedStagingResult();

  const exitCode = await main(['--json', 'ext', 'stage', 'github', '--repo', 'octo/tools', '--ref', 'main'], {
    stdout: { write(chunk) { writes.push(chunk); } },
    stderr: { write() {} },
    env: {},
    cwd: '/workspace/modly_CLI_MCP',
    platform: 'linux',
    createClient() {
      return {};
    },
    stageGitHubExtension: async () => staging,
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.staging.stagePath, '/tmp/modly-ext-stage-123');
  assert.equal(payload.data.staging.source.repo, 'octo/tools');
});

test('main emits JSON envelope with data.apply for ext apply', async () => {
  const writes = [];
  const apply = createApplyResult({ status: 'applied_degraded' });

  const exitCode = await main([
    '--json',
    'ext',
    'apply',
    '--stage-path',
    'tmp/stage/octo.tools',
    '--extensions-dir',
    '/opt/modly/extensions',
  ], {
    stdout: { write(chunk) { writes.push(chunk); } },
    stderr: { write() {} },
    env: {},
    cwd: '/workspace/modly_CLI_MCP',
    platform: 'linux',
    createClient() {
      return {};
    },
    applyStagedExtension: async () => apply,
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.apply.status, 'applied_degraded');
  assert.equal(payload.data.apply.resolution.extensionsDir, '/opt/modly/extensions');
});

test('main emits JSON envelope with data.repair for ext repair', async () => {
  const writes = [];
  const repair = createRepairResult({ status: 'repaired_degraded' });

  const exitCode = await main([
    '--json',
    'ext',
    'repair',
    '--stage-path',
    'tmp/stage/octo.tools',
    '--extensions-dir',
    '/opt/modly/extensions',
  ], {
    stdout: { write(chunk) { writes.push(chunk); } },
    stderr: { write() {} },
    env: {},
    cwd: '/workspace/modly_CLI_MCP',
    platform: 'linux',
    createClient() {
      return {};
    },
    repairStagedExtension: async () => repair,
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.repair.status, 'repaired_degraded');
  assert.equal(payload.data.repair.resolution.extensionsDir, '/opt/modly/extensions');
});

test('runExtCommand rejects live install semantics as out of scope', async () => {
  await assert.rejects(
    runExtCommand({ args: ['install', 'github', '--repo', 'octo/tools'], config: {}, client: {} }),
    UnsupportedOperationError,
  );
});
