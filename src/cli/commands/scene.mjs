import { importSceneMeshWithBridge } from '../../core/scene-import.mjs';
import { UnsupportedOperationError, UsageError } from '../../core/errors.mjs';

const SCENE_SUBCOMMANDS = ['import-mesh'];
const IMPORT_MESH_USAGE =
  'Usage: modly scene import-mesh <mesh-path> [--api-url <url>] [--json]';

function toCliUnsupportedError(error) {
  return new UnsupportedOperationError('Desktop bridge import mesh support is unavailable.', {
    code: 'SCENE_IMPORT_UNSUPPORTED',
    details: error.details,
    cause: error,
  });
}

function formatImportHumanMessage(result) {
  const parts = [`Scene import ${result.status} for ${result.meshPath}.`];

  if (result.sceneId) parts.push(`sceneId=${result.sceneId}`);
  if (result.objectId) parts.push(`objectId=${result.objectId}`);
  if (result.runId) parts.push(`runId=${result.runId}`);
  if (result.statusUrl) parts.push(`statusUrl=${result.statusUrl}`);

  return parts.join(' ');
}

async function runImportMesh(context, args) {
  if (args.length !== 1) {
    throw new UsageError(IMPORT_MESH_USAGE);
  }

  const [meshPath] = args;

  await context.client.health();
  const capabilities = await context.client.getAutomationCapabilities();

  try {
    const result = await importSceneMeshWithBridge({
      workspaceRoot: context.cwd,
      meshPath,
      capabilities,
      importSceneMesh: (payload) => context.client.importSceneMesh(payload),
      requireExistingFile: false,
    });

    return {
      data: result,
      humanMessage: formatImportHumanMessage(result),
    };
  } catch (error) {
    if (error?.code === 'SCENE_IMPORT_UNSUPPORTED') {
      throw toCliUnsupportedError(error);
    }

    throw error;
  }
}

export async function runSceneCommand(context) {
  const [subcommand, ...args] = context.args;

  switch (subcommand) {
    case 'import-mesh':
      return runImportMesh(context, args);
    default:
      throw new UsageError(`Unknown scene subcommand: ${subcommand ?? '<missing>'}. Available: ${SCENE_SUBCOMMANDS.join(', ')}.`);
  }
}
