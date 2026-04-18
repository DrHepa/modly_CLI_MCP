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

test('help advertises ext stage github and ext apply with honest guardrails', () => {
  const globalHelp = renderHelp();
  const extHelp = renderExtHelp();

  assert.match(globalHelp, /ext <subcomando>\s+reload \| errors \| stage github \| apply/u);
  assert.match(globalHelp, /stage github\s+Stage\/preflight only desde GitHub/u);
  assert.match(globalHelp, /apply\s+Promueve un stage YA preparado/u);
  assert.doesNotMatch(globalHelp, /install headless|live install|auto-reload|repair automático/u);

  assert.match(extHelp, /modly ext stage github --repo <owner\/name>/u);
  assert.match(extHelp, /modly ext apply --stage-path <path> --extensions-dir <abs-path>/u);
  assert.match(extHelp, /apply sobre un stage ya preparado/u);
  assert.match(extHelp, /NO hace fetch GitHub, install, build ni repair/u);
  assert.match(extHelp, /staging\/preflight only/u);
  assert.match(extHelp, /No expone capability MCP estable/u);
  assert.match(extHelp, /NO instala ni aplica en vivo/u);
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

test('runExtCommand rejects live install semantics as out of scope', async () => {
  await assert.rejects(
    runExtCommand({ args: ['install', 'github', '--repo', 'octo/tools'], config: {}, client: {} }),
    UnsupportedOperationError,
  );
});
