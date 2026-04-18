import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

function createTempRoot(t) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-stage-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

async function loadModule() {
  return import('../../src/core/github-extension-staging.mjs');
}

function createSpawnImpl(steps) {
  return (command, args, options) => {
    const step = steps.shift();

    if (!step) {
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    }

    assert.equal(command, step.command);
    assert.deepEqual(args, step.args);

    if (typeof step.cwd === 'function') {
      assert.equal(step.cwd(options.cwd), true);
    } else if (step.cwd !== undefined) {
      assert.equal(options.cwd, step.cwd);
    }

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    process.nextTick(() => {
      step.onSpawn?.(options);

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

function writeStageFiles(stagePath, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(path.join(stagePath, relativePath), content);
  }
}

test('stageGitHubExtension rejects invalid repo and ref input with UsageError', async () => {
  const { stageGitHubExtension } = await loadModule();

  await assert.rejects(
    () => stageGitHubExtension({ repo: 'invalid', ref: 'main' }),
    (error) => {
      assert.equal(error.name, 'UsageError');
      assert.equal(error.code, 'INVALID_USAGE');
      assert.match(error.message, /repo/i);
      return true;
    },
  );

  await assert.rejects(
    () => stageGitHubExtension({ repo: 'owner/name', ref: '   ' }),
    (error) => {
      assert.equal(error.name, 'UsageError');
      assert.equal(error.code, 'INVALID_USAGE');
      assert.match(error.message, /ref/i);
      return true;
    },
  );
});

test('stageGitHubExtension prepares an isolated stage path and returns the inspected JSON shape for a minimal manifest', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);
  const stageParent = path.join(tempRoot, 'staging-root');
  const spawnSteps = [
    { command: 'git', args: ['init', '--quiet'] },
    { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/octo/hello.git'] },
    { command: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
    {
      command: 'git',
      args: ['checkout', '--quiet', 'FETCH_HEAD'],
      onSpawn: ({ cwd }) => {
        writeStageFiles(cwd, {
          'manifest.json': JSON.stringify({ id: 'octo.minimal', name: 'Octo Minimal', version: '0.0.1' }),
        });
      },
    },
    { command: 'git', args: ['rev-parse', 'FETCH_HEAD'], stdout: 'abc123\n' },
  ];

  const result = await stageGitHubExtension(
    { repo: 'octo/hello', ref: 'main', stagingDir: stageParent },
    {
      spawnImpl: createSpawnImpl(spawnSteps),
    },
  );

  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.source, {
    kind: 'github',
    repo: 'octo/hello',
    ref: 'main',
    resolvedRef: 'abc123',
  });
  assert.equal(result.stagePath.startsWith(stageParent), true);
  assert.deepEqual(result.manifestSummary, {
    present: true,
    readable: true,
    id: 'octo.minimal',
    name: 'Octo Minimal',
    version: '0.0.1',
    extensionType: 'unknown',
  });
  assert.deepEqual(result.checks, [
    { id: 'manifest.present', status: 'pass' },
    { id: 'manifest.readable', status: 'pass' },
    { id: 'manifest.id', status: 'pass' },
    { id: 'extension.type', status: 'warn', detail: 'unknown' },
    { id: 'dependency.markers', status: 'pass', detail: [] },
    { id: 'build.markers', status: 'pass', detail: [] },
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.nextManualActions, []);
  assert.equal(result.diagnostics, null);
});

test('stageGitHubExtension rejects empty stagingDir input with UsageError', async () => {
  const { stageGitHubExtension } = await loadModule();

  await assert.rejects(
    () => stageGitHubExtension({ repo: 'owner/name', stagingDir: '   ' }),
    (error) => {
      assert.equal(error.name, 'UsageError');
      assert.equal(error.code, 'INVALID_USAGE');
      assert.match(error.message, /staging/i);
      return true;
    },
  );
});

test('stageGitHubExtension reports FETCH_TOOL_UNAVAILABLE when git is missing and avoids fabricated success fields', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);
  const missingGit = new Error('spawn git ENOENT');
  missingGit.code = 'ENOENT';

  const result = await stageGitHubExtension(
    { repo: 'octo/hello', ref: 'main', stagingDir: tempRoot },
    {
      spawnImpl: createSpawnImpl([
        {
          command: 'git',
          args: ['init', '--quiet'],
          cwd: (value) => typeof value === 'string' && value.startsWith(tempRoot),
          error: missingGit,
        },
      ]),
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.source, {
    kind: 'github',
    repo: 'octo/hello',
    ref: 'main',
    resolvedRef: null,
  });
  assert.equal(typeof result.stagePath, 'string');
  assert.deepEqual(result.manifestSummary, {
    present: null,
    readable: null,
    id: null,
    name: null,
    version: null,
    extensionType: 'unknown',
  });
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.nextManualActions, [
    {
      id: 'install-git',
      message: 'Install git locally and retry the GitHub staging flow.',
    },
  ]);
  assert.deepEqual(result.diagnostics, {
    phase: 'fetch',
    code: 'FETCH_TOOL_UNAVAILABLE',
    detail: 'git is not installed or not available on PATH.',
  });
});

test('stageGitHubExtension reports FETCH_FAILED when git exits non-zero during snapshot materialization', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);

  const result = await stageGitHubExtension(
    { repo: 'octo/hello', ref: 'main', stagingDir: tempRoot },
    {
      spawnImpl: createSpawnImpl([
        {
          command: 'git',
          args: ['init', '--quiet'],
          cwd: (value) => typeof value === 'string' && value.startsWith(tempRoot),
        },
        {
          command: 'git',
          args: ['remote', 'add', 'origin', 'https://github.com/octo/hello.git'],
          cwd: (value) => typeof value === 'string' && value.startsWith(tempRoot),
          exitCode: 128,
          stderr: 'remote add failed',
        },
      ]),
    },
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.source.resolvedRef, null);
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.nextManualActions, []);
  assert.deepEqual(result.diagnostics, {
    phase: 'fetch',
    code: 'FETCH_FAILED',
    detail: 'remote add failed',
  });
});

test('stageGitHubExtension inspects manifest, classifies node extensions, and emits manual dependency/build follow-up', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);
  const stageParent = path.join(tempRoot, 'node-stage');
  let inspectedStagePath = null;

  const result = await stageGitHubExtension(
    { repo: 'octo/hello', ref: 'main', stagingDir: stageParent },
    {
      spawnImpl: createSpawnImpl([
        { command: 'git', args: ['init', '--quiet'] },
        { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/octo/hello.git'] },
        { command: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
        {
          command: 'git',
          args: ['checkout', '--quiet', 'FETCH_HEAD'],
          onSpawn: ({ cwd }) => {
            inspectedStagePath = cwd;
            writeStageFiles(cwd, {
              'manifest.json': JSON.stringify({ id: 'octo.node', name: 'Octo Node', version: '1.2.3' }),
              'package.json': JSON.stringify({ name: 'octo-node' }),
              'package-lock.json': '{}',
              'tsconfig.json': '{"compilerOptions":{}}',
              'vite.config.mjs': 'export default {}',
            });
          },
        },
        { command: 'git', args: ['rev-parse', 'FETCH_HEAD'], stdout: 'abc123\n' },
      ]),
    },
  );

  assert.equal(result.status, 'prepared');
  assert.equal(result.stagePath, inspectedStagePath);
  assert.deepEqual(result.manifestSummary, {
    present: true,
    readable: true,
    id: 'octo.node',
    name: 'Octo Node',
    version: '1.2.3',
    extensionType: 'node',
  });
  assert.deepEqual(result.checks, [
    { id: 'manifest.present', status: 'pass' },
    { id: 'manifest.readable', status: 'pass' },
    { id: 'manifest.id', status: 'pass' },
    { id: 'extension.type', status: 'pass', detail: 'node' },
    {
      id: 'dependency.markers',
      status: 'warn',
      detail: ['package.json', 'package-lock.json'],
    },
    {
      id: 'build.markers',
      status: 'warn',
      detail: ['tsconfig.json', 'vite.config.mjs'],
    },
  ]);
  assert.deepEqual(result.warnings, [
    {
      code: 'MANUAL_DEPENDENCIES_REQUIRED',
      message: 'Dependency markers detected in the staged extension; install dependencies manually inside stagePath.',
      detail: ['package.json', 'package-lock.json'],
    },
    {
      code: 'MANUAL_BUILD_REQUIRED',
      message: 'Build markers detected in the staged extension; run the extension build manually inside stagePath.',
      detail: ['tsconfig.json', 'vite.config.mjs'],
    },
  ]);
  assert.deepEqual(result.nextManualActions, [
    {
      id: 'install-deps',
      message: 'Run the extension-specific dependency step manually inside stagePath.',
    },
    {
      id: 'run-build',
      message: 'Run the extension-specific build step manually inside stagePath if required.',
    },
  ]);
  assert.equal(result.diagnostics, null);
});

test('stageGitHubExtension classifies hybrid extensions from mixed node/python markers without fabricating warnings', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);

  const result = await stageGitHubExtension(
    { repo: 'octo/hybrid', ref: 'main', stagingDir: tempRoot },
    {
      spawnImpl: createSpawnImpl([
        { command: 'git', args: ['init', '--quiet'] },
        { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/octo/hybrid.git'] },
        { command: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
        {
          command: 'git',
          args: ['checkout', '--quiet', 'FETCH_HEAD'],
          onSpawn: ({ cwd }) => {
            writeStageFiles(cwd, {
              'manifest.json': JSON.stringify({ id: 'octo.hybrid', name: 'Octo Hybrid', version: '2.0.0' }),
              'package.json': JSON.stringify({ name: 'octo-hybrid' }),
              'pyproject.toml': '[build-system]\nrequires = ["setuptools"]\n',
            });
          },
        },
        { command: 'git', args: ['rev-parse', 'FETCH_HEAD'], stdout: 'def456\n' },
      ]),
    },
  );

  assert.equal(result.status, 'prepared');
  assert.equal(result.manifestSummary.extensionType, 'hybrid');
  assert.deepEqual(result.checks[3], { id: 'extension.type', status: 'pass', detail: 'hybrid' });
  assert.deepEqual(result.checks[4], {
    id: 'dependency.markers',
    status: 'warn',
    detail: ['package.json', 'pyproject.toml'],
  });
  assert.deepEqual(result.checks[5], { id: 'build.markers', status: 'pass', detail: [] });
  assert.deepEqual(result.warnings, [
    {
      code: 'MANUAL_DEPENDENCIES_REQUIRED',
      message: 'Dependency markers detected in the staged extension; install dependencies manually inside stagePath.',
      detail: ['package.json', 'pyproject.toml'],
    },
  ]);
  assert.deepEqual(result.nextManualActions, [
    {
      id: 'install-deps',
      message: 'Run the extension-specific dependency step manually inside stagePath.',
    },
  ]);
  assert.equal(result.diagnostics, null);
});

test('stageGitHubExtension reports MANIFEST_MISSING when the staged snapshot has no manifest.json', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);

  const result = await stageGitHubExtension(
    { repo: 'octo/missing-manifest', ref: 'main', stagingDir: tempRoot },
    {
      spawnImpl: createSpawnImpl([
        { command: 'git', args: ['init', '--quiet'] },
        { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/octo/missing-manifest.git'] },
        { command: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
        { command: 'git', args: ['checkout', '--quiet', 'FETCH_HEAD'] },
        { command: 'git', args: ['rev-parse', 'FETCH_HEAD'], stdout: 'aaa111\n' },
      ]),
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.manifestSummary, {
    present: false,
    readable: false,
    id: null,
    name: null,
    version: null,
    extensionType: 'unknown',
  });
  assert.deepEqual(result.checks, [
    { id: 'manifest.present', status: 'fail' },
    { id: 'manifest.readable', status: 'fail' },
    { id: 'manifest.id', status: 'fail' },
    { id: 'extension.type', status: 'warn', detail: 'unknown' },
    { id: 'dependency.markers', status: 'pass', detail: [] },
    { id: 'build.markers', status: 'pass', detail: [] },
  ]);
  assert.deepEqual(result.diagnostics, {
    phase: 'inspect',
    code: 'MANIFEST_MISSING',
    detail: 'manifest.json was not found in the staged extension snapshot.',
  });
});

test('stageGitHubExtension reports MANIFEST_INVALID when manifest.json is unreadable JSON', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);

  const result = await stageGitHubExtension(
    { repo: 'octo/bad-manifest', ref: 'main', stagingDir: tempRoot },
    {
      spawnImpl: createSpawnImpl([
        { command: 'git', args: ['init', '--quiet'] },
        { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/octo/bad-manifest.git'] },
        { command: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
        {
          command: 'git',
          args: ['checkout', '--quiet', 'FETCH_HEAD'],
          onSpawn: ({ cwd }) => {
            writeStageFiles(cwd, {
              'manifest.json': '{not-json}',
            });
          },
        },
        { command: 'git', args: ['rev-parse', 'FETCH_HEAD'], stdout: 'bbb222\n' },
      ]),
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.manifestSummary, {
    present: true,
    readable: false,
    id: null,
    name: null,
    version: null,
    extensionType: 'unknown',
  });
  assert.deepEqual(result.checks, [
    { id: 'manifest.present', status: 'pass' },
    { id: 'manifest.readable', status: 'fail' },
    { id: 'manifest.id', status: 'fail' },
    { id: 'extension.type', status: 'warn', detail: 'unknown' },
    { id: 'dependency.markers', status: 'pass', detail: [] },
    { id: 'build.markers', status: 'pass', detail: [] },
  ]);
  assert.deepEqual(result.diagnostics, {
    phase: 'inspect',
    code: 'MANIFEST_INVALID',
    detail: 'manifest.json could not be parsed as valid JSON.',
  });
});

test('stageGitHubExtension reports MANIFEST_ID_MISSING when manifest.json has no usable id', async (t) => {
  const { stageGitHubExtension } = await loadModule();
  const tempRoot = createTempRoot(t);

  const result = await stageGitHubExtension(
    { repo: 'octo/missing-id', ref: 'main', stagingDir: tempRoot },
    {
      spawnImpl: createSpawnImpl([
        { command: 'git', args: ['init', '--quiet'] },
        { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/octo/missing-id.git'] },
        { command: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
        {
          command: 'git',
          args: ['checkout', '--quiet', 'FETCH_HEAD'],
          onSpawn: ({ cwd }) => {
            writeStageFiles(cwd, {
              'manifest.json': JSON.stringify({ name: 'No Id', version: '0.1.0' }),
            });
          },
        },
        { command: 'git', args: ['rev-parse', 'FETCH_HEAD'], stdout: 'ccc333\n' },
      ]),
    },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.manifestSummary, {
    present: true,
    readable: true,
    id: null,
    name: 'No Id',
    version: '0.1.0',
    extensionType: 'unknown',
  });
  assert.deepEqual(result.checks, [
    { id: 'manifest.present', status: 'pass' },
    { id: 'manifest.readable', status: 'pass' },
    { id: 'manifest.id', status: 'fail' },
    { id: 'extension.type', status: 'warn', detail: 'unknown' },
    { id: 'dependency.markers', status: 'pass', detail: [] },
    { id: 'build.markers', status: 'pass', detail: [] },
  ]);
  assert.deepEqual(result.diagnostics, {
    phase: 'inspect',
    code: 'MANIFEST_ID_MISSING',
    detail: 'manifest.json must include a non-empty manifest.id value.',
  });
});
