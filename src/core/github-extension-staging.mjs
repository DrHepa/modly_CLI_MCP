import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { UsageError } from './errors.mjs';

const DEFAULT_STAGE_PREFIX = 'modly-ext-stage-';
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function buildEmptyManifestSummary() {
  return {
    present: null,
    readable: null,
    id: null,
    name: null,
    version: null,
    extensionType: 'unknown',
  };
}

const NODE_TYPE_MARKERS = ['package.json'];
const PYTHON_TYPE_MARKERS = ['pyproject.toml', 'setup.py', 'requirements.txt'];
const DEPENDENCY_MARKERS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'setup.py', 'requirements.txt'];
const BUILD_MARKER_PATTERNS = [/^tsconfig(?:\..+)?\.json$/u, /^tsconfig\.json$/u, /^vite\.config\.[^.]+$/u, /^webpack\.config\.[^.]+$/u, /^rollup\.config\.[^.]+$/u, /^esbuild\.config\.[^.]+$/u];

function normalizeRepo(repo) {
  if (typeof repo !== 'string' || !GITHUB_REPO_PATTERN.test(repo.trim())) {
    throw new UsageError('Expected --repo in the format <owner/name>.');
  }

  return repo.trim();
}

function normalizeRef(ref) {
  if (ref === undefined) {
    return 'HEAD';
  }

  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new UsageError('Expected --ref to be a non-empty string when provided.');
  }

  return ref.trim();
}

function normalizeStagingDir(stagingDir) {
  if (stagingDir === undefined) {
    return null;
  }

  if (typeof stagingDir !== 'string' || stagingDir.trim() === '') {
    throw new UsageError('Expected --staging-dir to be a non-empty path when provided.');
  }

  return stagingDir.trim();
}

function buildBaseResult({ repo, ref, stagePath }) {
  return {
    source: {
      kind: 'github',
      repo,
      ref,
      resolvedRef: null,
    },
    stagePath,
    manifestSummary: buildEmptyManifestSummary(),
    checks: [],
    warnings: [],
    nextManualActions: [],
    diagnostics: null,
  };
}

function classifyExtensionType(entries) {
  const hasNode = NODE_TYPE_MARKERS.some((marker) => entries.includes(marker));
  const hasPython = PYTHON_TYPE_MARKERS.some((marker) => entries.includes(marker));

  if (hasNode && hasPython) {
    return 'hybrid';
  }

  if (hasNode) {
    return 'node';
  }

  if (hasPython) {
    return 'python';
  }

  return 'unknown';
}

function collectDependencyMarkers(entries) {
  return DEPENDENCY_MARKERS.filter((marker) => entries.includes(marker));
}

function collectBuildMarkers(entries) {
  return entries.filter((entry) => BUILD_MARKER_PATTERNS.some((pattern) => pattern.test(entry))).sort();
}

function createCheck(id, status, detail) {
  return detail === undefined ? { id, status } : { id, status, detail };
}

function createInspectionArtifacts({ manifestSummary, dependencyMarkers, buildMarkers }) {
  const extensionTypeStatus = manifestSummary.extensionType === 'unknown' ? 'warn' : 'pass';
  const dependencyStatus = dependencyMarkers.length > 0 ? 'warn' : 'pass';
  const buildStatus = buildMarkers.length > 0 ? 'warn' : 'pass';
  const warnings = [];
  const nextManualActions = [];

  if (dependencyMarkers.length > 0) {
    warnings.push({
      code: 'MANUAL_DEPENDENCIES_REQUIRED',
      message: 'Dependency markers detected in the staged extension; install dependencies manually inside stagePath.',
      detail: dependencyMarkers,
    });
    nextManualActions.push({
      id: 'install-deps',
      message: 'Run the extension-specific dependency step manually inside stagePath.',
    });
  }

  if (buildMarkers.length > 0) {
    warnings.push({
      code: 'MANUAL_BUILD_REQUIRED',
      message: 'Build markers detected in the staged extension; run the extension build manually inside stagePath.',
      detail: buildMarkers,
    });
    nextManualActions.push({
      id: 'run-build',
      message: 'Run the extension-specific build step manually inside stagePath if required.',
    });
  }

  return {
    checks: [
      createCheck('manifest.present', manifestSummary.present ? 'pass' : 'fail'),
      createCheck('manifest.readable', manifestSummary.readable ? 'pass' : 'fail'),
      createCheck('manifest.id', manifestSummary.id ? 'pass' : 'fail'),
      createCheck('extension.type', extensionTypeStatus, manifestSummary.extensionType),
      createCheck('dependency.markers', dependencyStatus, dependencyMarkers),
      createCheck('build.markers', buildStatus, buildMarkers),
    ],
    warnings,
    nextManualActions,
  };
}

async function inspectStagedExtension(stagePath) {
  const manifestPath = path.join(stagePath, 'manifest.json');
  const entries = (await readdir(stagePath)).sort();
  const dependencyMarkers = collectDependencyMarkers(entries);
  const buildMarkers = collectBuildMarkers(entries);
  const manifestSummary = buildEmptyManifestSummary();

  try {
    const manifestRaw = await readFile(manifestPath, 'utf8');
    manifestSummary.present = true;

    let manifest;

    try {
      manifest = JSON.parse(manifestRaw);
      manifestSummary.readable = true;
    } catch {
      manifestSummary.readable = false;
      const artifacts = createInspectionArtifacts({ manifestSummary, dependencyMarkers, buildMarkers });
      return {
        status: 'failed',
        manifestSummary,
        ...artifacts,
        diagnostics: {
          phase: 'inspect',
          code: 'MANIFEST_INVALID',
          detail: 'manifest.json could not be parsed as valid JSON.',
        },
      };
    }

    manifestSummary.id = typeof manifest?.id === 'string' && manifest.id.trim() !== '' ? manifest.id.trim() : null;
    manifestSummary.name = typeof manifest?.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : null;
    manifestSummary.version = typeof manifest?.version === 'string' && manifest.version.trim() !== '' ? manifest.version.trim() : null;
    manifestSummary.extensionType = classifyExtensionType(entries);

    const artifacts = createInspectionArtifacts({ manifestSummary, dependencyMarkers, buildMarkers });

    if (!manifestSummary.id) {
      return {
        status: 'failed',
        manifestSummary,
        ...artifacts,
        diagnostics: {
          phase: 'inspect',
          code: 'MANIFEST_ID_MISSING',
          detail: 'manifest.json must include a non-empty manifest.id value.',
        },
      };
    }

    return {
      status: 'prepared',
      manifestSummary,
      ...artifacts,
      diagnostics: null,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    manifestSummary.present = false;
    manifestSummary.readable = false;
    manifestSummary.extensionType = classifyExtensionType(entries);
    const artifacts = createInspectionArtifacts({ manifestSummary, dependencyMarkers, buildMarkers });

    return {
      status: 'failed',
      manifestSummary,
      ...artifacts,
      diagnostics: {
        phase: 'inspect',
        code: 'MANIFEST_MISSING',
        detail: 'manifest.json was not found in the staged extension snapshot.',
      },
    };
  }
}

async function allocateStagePath({ stagingDir, cwd, tmpdir }) {
  if (stagingDir) {
    const parentDir = path.resolve(cwd, stagingDir);
    await mkdir(parentDir, { recursive: true });
    return mkdtemp(path.join(parentDir, DEFAULT_STAGE_PREFIX));
  }

  return mkdtemp(path.join(tmpdir, DEFAULT_STAGE_PREFIX));
}

function createRunGit(spawnImpl) {
  return function runGit(args, { cwd }) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.once('error', (error) => {
        reject(error);
      });

      child.once('close', (exitCode) => {
        if (exitCode === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }

        const error = new Error(stderr.trim() || `git ${args.join(' ')} failed with exit code ${exitCode}.`);
        error.code = 'GIT_COMMAND_FAILED';
        error.exitCode = exitCode;
        error.stderr = stderr.trim();
        error.stdout = stdout.trim();
        error.args = args;
        reject(error);
      });
    });
  };
}

async function materializeGitHubSnapshot({ repo, ref, stagePath, spawnImpl }) {
  const runGit = createRunGit(spawnImpl);

  await runGit(['init', '--quiet'], { cwd: stagePath });
  await runGit(['remote', 'add', 'origin', `https://github.com/${repo}.git`], { cwd: stagePath });
  await runGit(['fetch', '--depth', '1', 'origin', ref], { cwd: stagePath });
  await runGit(['checkout', '--quiet', 'FETCH_HEAD'], { cwd: stagePath });
  const resolved = await runGit(['rev-parse', 'FETCH_HEAD'], { cwd: stagePath });

  return {
    resolvedRef: resolved.stdout || null,
  };
}

function buildFailureResult(baseResult, diagnostics, nextManualActions = []) {
  return {
    status: 'failed',
    ...baseResult,
    diagnostics,
    nextManualActions,
  };
}

export async function stageGitHubExtension(input = {}, deps = {}) {
  const repo = normalizeRepo(input.repo);
  const ref = normalizeRef(input.ref);
  const stagingDir = normalizeStagingDir(input.stagingDir);
  const cwd = deps.cwd ?? process.cwd();
  const tmpdir = deps.tmpdir ?? os.tmpdir();
  const spawnImpl = deps.spawnImpl ?? spawn;
  const stagePath = await allocateStagePath({ stagingDir, cwd, tmpdir });
  const baseResult = buildBaseResult({ repo, ref, stagePath });

  try {
    const materialized = await materializeGitHubSnapshot({
      repo,
      ref,
      stagePath,
      spawnImpl,
    });
    const inspection = await inspectStagedExtension(stagePath);

    return {
      status: inspection.status,
      ...baseResult,
      source: {
        ...baseResult.source,
        resolvedRef: materialized.resolvedRef,
      },
      manifestSummary: inspection.manifestSummary,
      checks: inspection.checks,
      warnings: inspection.warnings,
      nextManualActions: inspection.nextManualActions,
      diagnostics: inspection.diagnostics,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return buildFailureResult(
        baseResult,
        {
          phase: 'fetch',
          code: 'FETCH_TOOL_UNAVAILABLE',
          detail: 'git is not installed or not available on PATH.',
        },
        [
          {
            id: 'install-git',
            message: 'Install git locally and retry the GitHub staging flow.',
          },
        ],
      );
    }

    return buildFailureResult(baseResult, {
      phase: 'fetch',
      code: 'FETCH_FAILED',
      detail: error?.message ?? 'GitHub staging fetch failed.',
    });
  }
}
