import test from 'node:test';
import assert from 'node:assert/strict';

import { main } from '../../src/cli/index.mjs';
import { UnsupportedOperationError, UsageError } from '../../src/core/errors.mjs';
import { runExtCommand } from '../../src/cli/commands/ext.mjs';
import { renderExtHelp, renderHelp } from '../../src/cli/help.mjs';

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
      restored: false,
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
      path: '/opt/modly/extensions/octo.tools.backup',
      expected: true,
      created: true,
      restored: false,
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
    stagePath: '/tmp/modly-ext-stage-123',
    plan: {
      consentGranted: true,
      cwd: '/tmp/modly-ext-stage-123',
      command: 'python3',
      args: ['setup.py', '{"apiBaseUrl":"https://api.example.test"}'],
      setupContract: {
        kind: 'python-root-setup-py',
        entry: 'setup.py',
        requiredInputs: ['apiBaseUrl'],
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
          requiredInputs: ['apiBaseUrl'],
        },
      },
      after: {
        status: 'prepared',
        warnings: [],
        manifestSummary: { id: 'octo.tools' },
        setupContract: {
          kind: 'python-root-setup-py',
          entry: 'setup.py',
          requiredInputs: ['apiBaseUrl'],
        },
      },
    },
    ...overrides,
  };
}

test('help advertises ext stage github, ext apply, ext setup, and ext repair with honest guardrails', () => {
  const globalHelp = renderHelp();
  const extHelp = renderExtHelp();

  assert.match(globalHelp, /ext <subcomando>\s+reload \| errors \| stage github \| apply \| setup \| repair/u);
  assert.match(globalHelp, /stage github\s+Stage\/preflight only desde GitHub/u);
  assert.match(globalHelp, /apply\s+Promueve un stage YA preparado/u);
  assert.match(globalHelp, /setup\s+Ejecuta SOLO un contrato explícito/u);
  assert.match(globalHelp, /repair\s+Reaplica un stage YA preparado/u);
  assert.doesNotMatch(globalHelp, /install headless|live install|auto-reload|repair automático|setup automático/u);

  assert.match(extHelp, /modly ext stage github --repo <owner\/name>/u);
  assert.match(extHelp, /modly ext apply --stage-path <path> --extensions-dir <abs-path>/u);
  assert.match(extHelp, /modly ext setup --stage-path <path> --python-exe <exe> --allow-third-party/u);
  assert.match(extHelp, /modly ext repair --stage-path <path> --extensions-dir <abs-path>/u);
  assert.match(extHelp, /apply sobre un stage ya preparado/u);
  assert.match(extHelp, /setup CLI-only sobre un stage ya preparado/u);
  assert.match(extHelp, /requiere consentimiento explícito porque ejecuta código de terceros/u);
  assert.match(extHelp, /repair como reapply CLI-only sobre un stage ya preparado/u);
  assert.match(extHelp, /NO hace fetch GitHub, install, setup implícito, build ni health-fix general/u);
  assert.match(extHelp, /staging\/preflight only/u);
  assert.match(extHelp, /No expone capability MCP estable/u);
  assert.match(extHelp, /NO instala ni aplica en vivo/u);
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

test('runExtCommand delegates ext repair to the reusable core with explicit stage and extensions paths', async () => {
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
  });
  assert.equal(typeof calls[0].deps.reloadExtensions, 'function');
  assert.equal(typeof calls[0].deps.getExtensionErrors, 'function');
  assert.deepEqual(result.data, { repair });
  assert.match(result.humanMessage, /CLI-only repair\/reapply over prepared stage: repaired/u);
  assert.match(result.humanMessage, /stagePath: \/tmp\/modly-ext-stage-123/u);
  assert.match(result.humanMessage, /extensionsDir: \/opt\/modly\/extensions/u);
  assert.match(result.humanMessage, /No GitHub fetch, install, setup, build, or general health fix was attempted/u);
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
  assert.match(result.humanMessage, /CLI-only repair\/reapply over prepared stage: repaired_degraded/u);
  assert.match(result.humanMessage, /runtime errors: 1/u);
  assert.doesNotMatch(result.humanMessage, /install complete|healthy install|dependencies repaired|health fix completed/u);
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
  });
  assert.equal(typeof calls[0].deps.reloadExtensions, 'function');
  assert.equal(typeof calls[0].deps.getExtensionErrors, 'function');
  assert.deepEqual(result.data, { apply });
  assert.match(result.humanMessage, /CLI-only apply over prepared stage: applied/u);
  assert.match(result.humanMessage, /stagePath: \/tmp\/modly-ext-stage-123/u);
  assert.match(result.humanMessage, /extensionsDir: \/opt\/modly\/extensions/u);
  assert.match(result.humanMessage, /No GitHub fetch, install, build, or repair was attempted/u);
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
  assert.match(result.humanMessage, /CLI-only apply over prepared stage: applied_degraded/u);
  assert.match(result.humanMessage, /runtime errors: 1/u);
  assert.doesNotMatch(result.humanMessage, /install complete|repaired|healthy install/u);
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
