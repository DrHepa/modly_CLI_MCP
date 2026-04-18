import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ModlyError, ValidationError } from './errors.mjs';

const MODLY_REPO_MARKERS = ['api/main.py', 'electron/main'];

function normalizeExplicitLauncher(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    const details = await stat(targetPath);
    return details.isDirectory();
  } catch {
    return false;
  }
}

export function getPreferredLauncherNames(platform = process.platform) {
  return [platform === 'win32' ? 'launch.bat' : 'launch.sh'];
}

export function listAncestorDirectories(startDir) {
  const current = path.resolve(startDir);
  const ancestors = [current];
  let cursor = current;

  while (true) {
    const parent = path.dirname(cursor);

    if (parent === cursor) {
      return ancestors;
    }

    ancestors.push(parent);
    cursor = parent;
  }
}

export async function isModlyRepoRoot(repoRoot) {
  for (const marker of MODLY_REPO_MARKERS) {
    const markerPath = path.join(repoRoot, marker);
    const exists = marker.endsWith('/main') ? await isDirectory(markerPath) : await pathExists(markerPath);

    if (!exists) {
      return false;
    }
  }

  return true;
}

export async function validateCandidateRepo(repoRoot) {
  return isModlyRepoRoot(repoRoot);
}

export async function resolveExpectedLauncher(repoRoot, platform = process.platform) {
  const [expectedLauncher] = getPreferredLauncherNames(platform);
  const launcherPath = path.join(repoRoot, expectedLauncher);

  if (!(await pathExists(launcherPath))) {
    return null;
  }

  return {
    path: launcherPath,
    root: repoRoot,
    entry: expectedLauncher,
  };
}

export async function validateModlyLauncherCandidate(launcherPath, { baseDir } = {}) {
  const absoluteLauncherPath = path.resolve(baseDir ?? process.cwd(), launcherPath);
  const launcherEntry = path.basename(absoluteLauncherPath);

  if (launcherEntry !== 'launch.sh' && launcherEntry !== 'launch.bat') {
    return null;
  }

  if (!(await pathExists(absoluteLauncherPath))) {
    return null;
  }

  const launcherDir = path.dirname(absoluteLauncherPath);

  if (!(await validateCandidateRepo(launcherDir))) {
    return null;
  }

  return {
    path: absoluteLauncherPath,
    root: launcherDir,
    entry: path.basename(absoluteLauncherPath),
  };
}

function buildCandidateRoots(cwd) {
  const ancestors = listAncestorDirectories(cwd);
  const siblingRoots = [];
  const seenSiblingRoots = new Set();

  for (const ancestor of ancestors) {
    const siblingRoot = path.join(path.dirname(ancestor), 'modly');

    if (!seenSiblingRoots.has(siblingRoot)) {
      seenSiblingRoots.add(siblingRoot);
      siblingRoots.push(siblingRoot);
    }
  }

  return {
    ancestors,
    siblingRoots,
  };
}

async function locateLauncherInRoots(candidateRoots, platform, source) {
  for (const repoRoot of candidateRoots) {
    if (!(await validateCandidateRepo(repoRoot))) {
      continue;
    }

    const candidate = await resolveExpectedLauncher(repoRoot, platform);

    if (candidate) {
      return {
        ...candidate,
        source,
      };
    }
  }

  return null;
}

export async function resolveModlyLauncher({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const launcherNames = getPreferredLauncherNames(platform);
  const explicitLauncher = normalizeExplicitLauncher(env.MODLY_LAUNCHER);

  if (explicitLauncher) {
    const candidate = await validateModlyLauncherCandidate(explicitLauncher, { baseDir: cwd });

    if (candidate && candidate.entry === launcherNames[0]) {
      return {
        ...candidate,
        source: 'env',
        preferredOrder: launcherNames,
      };
    }
  }

  const { ancestors, siblingRoots } = buildCandidateRoots(cwd);
  const ancestorCandidate = await locateLauncherInRoots(ancestors, platform, 'ancestor');

  if (ancestorCandidate) {
    return {
      ...ancestorCandidate,
      preferredOrder: launcherNames,
    };
  }

  const siblingCandidate = await locateLauncherInRoots(siblingRoots, platform, 'sibling');

  if (siblingCandidate) {
    return {
      ...siblingCandidate,
      preferredOrder: launcherNames,
    };
  }

  return null;
}

export function buildModlyLauncherOpenSpec({
  launcherPath,
  platform = process.platform,
  windowsCommand = process.env.ComSpec || 'cmd.exe',
  detached = true,
}) {
  const absoluteLauncherPath = path.resolve(launcherPath);
  const launcherDir = path.dirname(absoluteLauncherPath);
  const launcherEntry = path.basename(absoluteLauncherPath);

  if (launcherEntry === 'launch.bat') {
    return {
      command: platform === 'win32' ? windowsCommand : 'cmd.exe',
      args: ['/c', launcherEntry],
      cwd: launcherDir,
      detached,
      launcherPath: absoluteLauncherPath,
      launcherEntry,
    };
  }

  if (launcherEntry === 'launch.sh') {
    return {
      command: 'bash',
      args: [launcherEntry],
      cwd: launcherDir,
      detached,
      launcherPath: absoluteLauncherPath,
      launcherEntry,
    };
  }

  throw new ValidationError('Launcher must be launch.sh or launch.bat.');
}

export async function openModlyLauncher({
  launcherPath,
  platform = process.platform,
  spawnImpl = spawn,
  windowsCommand,
  detached = true,
} = {}) {
  const spec = buildModlyLauncherOpenSpec({ launcherPath, platform, windowsCommand, detached });

  const child = await new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: spec.detached ? 'ignore' : 'inherit',
      detached: spec.detached,
    });

    child.once('error', reject);
    if (spec.detached) {
      child.once('spawn', () => resolve(child));
      return;
    }

    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(child);
        return;
      }

      reject(
        new ModlyError(`Launcher exited with code ${code ?? 'unknown'}${signal ? ` (signal: ${signal})` : ''}.`, {
          code: 'LAUNCHER_FAILED',
          details: {
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            exitCode: code,
            signal,
          },
        }),
      );
    });
  });

  if (spec.detached && typeof child.unref === 'function') {
    child.unref();
  }

  return {
    ...spec,
    pid: child.pid ?? null,
  };
}
