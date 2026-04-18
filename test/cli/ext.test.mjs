import test from 'node:test';
import assert from 'node:assert/strict';

import { main } from '../../src/cli/index.mjs';
import { UnsupportedOperationError } from '../../src/core/errors.mjs';
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

test('help advertises ext stage github as staging/preflight only', () => {
  const globalHelp = renderHelp();
  const extHelp = renderExtHelp();

  assert.match(globalHelp, /ext <subcomando>\s+reload \| errors \| stage github/u);
  assert.match(globalHelp, /stage github\s+Stage\/preflight only desde GitHub/u);
  assert.doesNotMatch(globalHelp, /install headless|live install|auto-reload/u);

  assert.match(extHelp, /modly ext stage github --repo <owner\/name>/u);
  assert.match(extHelp, /staging\/preflight only/u);
  assert.match(extHelp, /No expone capability MCP estable/u);
  assert.match(extHelp, /NO instala ni aplica en vivo/u);
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

test('runExtCommand rejects live install/apply semantics as out of scope', async () => {
  await assert.rejects(
    runExtCommand({ args: ['install', 'github', '--repo', 'octo/tools'], config: {}, client: {} }),
    UnsupportedOperationError,
  );

  await assert.rejects(
    runExtCommand({ args: ['apply', 'github', '--repo', 'octo/tools'], config: {}, client: {} }),
    UnsupportedOperationError,
  );
});
