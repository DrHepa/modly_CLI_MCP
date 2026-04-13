import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../../core/errors.mjs';
import { assertWorkspaceRelativePath, parseCommandArgs, parseInteger } from './shared.mjs';

const MESH_SUBCOMMANDS = ['optimize', 'smooth', 'export'];
const EXPORT_FORMATS = new Set(['glb', 'obj', 'stl', 'ply']);

const OPTIMIZE_USAGE =
  'Usage: modly mesh optimize --path <workspace-relative-path> --target-faces <n> [--api-url <url>] [--json]';
const SMOOTH_USAGE =
  'Usage: modly mesh smooth --path <workspace-relative-path> --iterations <n> [--api-url <url>] [--json]';
const EXPORT_USAGE =
  'Usage: modly mesh export --path <workspace-relative-path> --format glb|obj|stl|ply [--out <file>] [--api-url <url>] [--json]';

function defaultExportPath(workspacePath, format) {
  const stem = path.basename(workspacePath, path.extname(workspacePath)) || 'mesh';
  return path.resolve(process.cwd(), `${stem}.${format}`);
}

async function runOptimize(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: OPTIMIZE_USAGE,
    valueFlags: ['--path', '--target-faces'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(OPTIMIZE_USAGE);
  }

  const meshPath = assertWorkspaceRelativePath(options['--path'], '--path');
  const targetFaces = parseInteger(options['--target-faces'], '--target-faces', { min: 100, max: 500000 });
  const result = await context.client.optimizeMesh({ path: meshPath, target_faces: targetFaces });

  return {
    data: { path: meshPath, targetFaces, result },
    humanMessage: `Optimize requested for ${meshPath} to ${targetFaces} faces.`,
  };
}

async function runSmooth(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: SMOOTH_USAGE,
    valueFlags: ['--path', '--iterations'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(SMOOTH_USAGE);
  }

  const meshPath = assertWorkspaceRelativePath(options['--path'], '--path');
  const iterations = parseInteger(options['--iterations'], '--iterations', { min: 1, max: 20 });
  const result = await context.client.smoothMesh({ path: meshPath, iterations });

  return {
    data: { path: meshPath, iterations, result },
    humanMessage: `Smooth requested for ${meshPath} with ${iterations} iterations.`,
  };
}

async function runExport(context, args) {
  const { positionals, options } = parseCommandArgs(args, {
    usage: EXPORT_USAGE,
    valueFlags: ['--path', '--format', '--out'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(EXPORT_USAGE);
  }

  const meshPath = assertWorkspaceRelativePath(options['--path'], '--path');
  const format = options['--format'];

  if (!format || !EXPORT_FORMATS.has(format)) {
    throw new UsageError(EXPORT_USAGE);
  }

  const outPath = options['--out'] ? path.resolve(options['--out']) : defaultExportPath(meshPath, format);
  const exported = await context.client.exportMesh({ format, path: meshPath });

  await writeFile(outPath, exported.buffer);

  return {
    data: {
      path: meshPath,
      format,
      out: outPath,
    },
    humanMessage: `Mesh exported to ${outPath}.`,
  };
}

export async function runMeshCommand(context) {
  const [subcommand = 'optimize', ...args] = context.args;

  switch (subcommand) {
    case 'optimize':
      return runOptimize(context, args);
    case 'smooth':
      return runSmooth(context, args);
    case 'export':
      return runExport(context, args);
    default:
      throw new UsageError(`Unknown mesh subcommand: ${subcommand}. Available: ${MESH_SUBCOMMANDS.join(', ')}.`);
  }
}
