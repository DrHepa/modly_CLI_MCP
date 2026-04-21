import { createHash } from 'node:crypto';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { ValidationError } from '../../../core/errors.mjs';

const MODEL_TYPE_TO_ID = Object.freeze({
  'triposg/generate': 'triposg',
  'hunyuan3d-mini/generate': 'hunyuan3d-mini',
});

const EXECUTABLE_NODE_TYPES = new Set([
  'imageNode',
  ...Object.keys(MODEL_TYPE_TO_ID),
  'mesh-optimizer/optimize',
  'mesh-exporter/export',
]);

const ALLOWED_NODE_TYPES = new Set([...EXECUTABLE_NODE_TYPES, 'outputNode']);

const SNAPSHOT_LIMITS = Object.freeze({
  pollingFirst: true,
  branching: false,
  automaticRetries: false,
});

const ELIGIBLE_RECIPE_NAME = /^Recipe\s+.+\s+\/\s+Template$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toValidationError(message, details) {
  return new ValidationError(message, { details });
}

function normalizeWorkflowDocument(document) {
  if (!isObject(document)) {
    throw toValidationError('Workflow recipe document must be an object.', {
      field: 'workflow',
      reason: 'invalid_workflow_document',
    });
  }

  const displayName = asNonEmptyString(document.name);

  if (!displayName) {
    throw toValidationError('Workflow recipe name must be a non-empty string.', {
      field: 'name',
      reason: 'invalid_workflow_name',
    });
  }

  if (!Array.isArray(document.nodes)) {
    throw toValidationError('Workflow recipe nodes must be an array.', {
      field: 'nodes',
      reason: 'invalid_workflow_nodes',
    });
  }

  if (!Array.isArray(document.edges)) {
    throw toValidationError('Workflow recipe edges must be an array.', {
      field: 'edges',
      reason: 'invalid_workflow_edges',
    });
  }

  return { displayName, nodes: document.nodes, edges: document.edges };
}

function normalizeNodes(nodes) {
  const nodeMap = new Map();

  for (const node of nodes) {
    if (!isObject(node)) {
      throw toValidationError('Workflow node entries must be objects.', {
        field: 'nodes',
        reason: 'invalid_workflow_node',
      });
    }

    const id = asNonEmptyString(node.id);
    const type = asNonEmptyString(node.type);

    if (!id || !type) {
      throw toValidationError('Workflow node id and type must be non-empty strings.', {
        field: 'nodes',
        reason: 'invalid_workflow_node',
      });
    }

    if (!ALLOWED_NODE_TYPES.has(type)) {
      throw toValidationError(`Unsupported workflow node type: ${type}.`, {
        field: 'nodes',
        reason: 'unsupported_workflow_node',
        nodeId: id,
        nodeType: type,
      });
    }

    if (nodeMap.has(id)) {
      throw toValidationError(`Duplicate workflow node id: ${id}.`, {
        field: 'nodes',
        reason: 'duplicate_workflow_node',
        nodeId: id,
      });
    }

    nodeMap.set(id, {
      id,
      type,
      data: isObject(node.data) ? { ...node.data } : {},
    });
  }

  return nodeMap;
}

function normalizeEdges(edges, nodeMap) {
  return edges.map((edge, index) => {
    if (!isObject(edge)) {
      throw toValidationError('Workflow edge entries must be objects.', {
        field: `edges.${index}`,
        reason: 'invalid_workflow_edge',
      });
    }

    const from = asNonEmptyString(edge.from);
    const to = asNonEmptyString(edge.to);

    if (!from || !to) {
      throw toValidationError('Workflow edge endpoints must be non-empty strings.', {
        field: `edges.${index}`,
        reason: 'invalid_workflow_edge',
      });
    }

    if (!nodeMap.has(from) || !nodeMap.has(to)) {
      throw toValidationError('Workflow edges must point to known nodes.', {
        field: `edges.${index}`,
        reason: 'unknown_workflow_edge_node',
        from,
        to,
      });
    }

    return { from, to };
  });
}

function getNodesByType(nodeMap, type) {
  return Array.from(nodeMap.values()).filter((node) => node.type === type);
}

function assertExactNodeCount(nodes, type, expected, reason) {
  if (nodes.length !== expected) {
    throw toValidationError(`Workflow must contain exactly ${expected} ${type} node(s).`, {
      field: 'nodes',
      reason,
      nodeType: type,
      count: nodes.length,
    });
  }
}

function assertOptionalNodeCount(nodes, type) {
  if (nodes.length > 1) {
    throw toValidationError(`Workflow must not contain more than one ${type} node.`, {
      field: 'nodes',
      reason: 'duplicate_optional_step',
      nodeType: type,
      count: nodes.length,
    });
  }
}

function buildExecutableGraph(nodeMap, edges) {
  const outgoing = new Map();
  const incoming = new Map();

  for (const node of nodeMap.values()) {
    if (EXECUTABLE_NODE_TYPES.has(node.type)) {
      outgoing.set(node.id, []);
      incoming.set(node.id, []);
    }
  }

  for (const edge of edges) {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);

    if (fromNode.type === 'outputNode') {
      throw toValidationError('outputNode cannot feed executable workflow steps.', {
        field: 'edges',
        reason: 'unsupported_output_node_branch',
        from: edge.from,
        to: edge.to,
      });
    }

    if (toNode.type === 'outputNode') {
      continue;
    }

    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }

  return { outgoing, incoming };
}

function assertNoExecutableBranching(outgoing, nodeId) {
  const targets = outgoing.get(nodeId) ?? [];

  if (targets.length > 1) {
    throw toValidationError('Executable workflow branching is not supported.', {
      field: 'edges',
      reason: 'unsupported_workflow_branching',
      from: nodeId,
      targets,
    });
  }
}

function assertIncoming(incoming, nodeId, expected, reason) {
  const sources = incoming.get(nodeId) ?? [];

  if (sources.length !== expected.length || expected.some((source) => !sources.includes(source))) {
    throw toValidationError('Workflow step wiring does not match the supported linear subset.', {
      field: 'edges',
      reason,
      nodeId,
      expected,
      actual: sources,
    });
  }
}

function toRecipeId(displayName) {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `workflow/${slug}`;
}

function isWorkflowRecipeId(value) {
  return typeof value === 'string' && value.trim().startsWith('workflow/');
}

function buildDerivedRecipeValidationError(message, details) {
  return new ValidationError(message, { details });
}

function fingerprintsMatch(expected, actual) {
  return expected?.sha256 === actual?.sha256 && expected?.mtimeMs === actual?.mtimeMs && expected?.size === actual?.size;
}

export function isEligibleWorkflowRecipeName(displayName) {
  return typeof displayName === 'string' && ELIGIBLE_RECIPE_NAME.test(displayName.trim());
}

export function validateWorkflowRecipeDocument(document) {
  const { displayName, nodes, edges } = normalizeWorkflowDocument(document);
  const nodeMap = normalizeNodes(nodes);
  const imageNodes = getNodesByType(nodeMap, 'imageNode');
  const generateNodes = Array.from(nodeMap.values()).filter((node) => Object.hasOwn(MODEL_TYPE_TO_ID, node.type));
  const optimizeNodes = getNodesByType(nodeMap, 'mesh-optimizer/optimize');
  const exportNodes = getNodesByType(nodeMap, 'mesh-exporter/export');
  const outputNodes = getNodesByType(nodeMap, 'outputNode');

  assertExactNodeCount(imageNodes, 'imageNode', 1, 'invalid_image_node_count');
  assertExactNodeCount(generateNodes, 'generate', 1, 'multiple_generate_steps');
  assertOptionalNodeCount(optimizeNodes, 'mesh-optimizer/optimize');
  assertOptionalNodeCount(exportNodes, 'mesh-exporter/export');
  assertOptionalNodeCount(outputNodes, 'outputNode');

  const normalizedEdges = normalizeEdges(edges, nodeMap);
  const { outgoing, incoming } = buildExecutableGraph(nodeMap, normalizedEdges);
  const imageNode = imageNodes[0];
  const generateNode = generateNodes[0];
  const optimizeNode = optimizeNodes[0] ?? null;
  const exportNode = exportNodes[0] ?? null;

  for (const nodeId of outgoing.keys()) {
    assertNoExecutableBranching(outgoing, nodeId);
  }

  assertIncoming(incoming, imageNode.id, [], 'invalid_image_inputs');
  assertIncoming(incoming, generateNode.id, [imageNode.id], 'invalid_generate_inputs');

  if (optimizeNode) {
    assertIncoming(incoming, optimizeNode.id, [generateNode.id], 'invalid_optimize_inputs');
  }

  if (exportNode) {
    assertIncoming(
      incoming,
      exportNode.id,
      [optimizeNode?.id ?? generateNode.id],
      'invalid_export_inputs',
    );
  }

  const imageTargets = outgoing.get(imageNode.id) ?? [];
  if (imageTargets.length !== 1 || imageTargets[0] !== generateNode.id) {
    throw toValidationError('imageNode must connect directly to the single generate step.', {
      field: 'edges',
      reason: 'invalid_image_outputs',
      from: imageNode.id,
      targets: imageTargets,
    });
  }

  const generateTargets = outgoing.get(generateNode.id) ?? [];
  const expectedGenerateTarget = optimizeNode?.id ?? exportNode?.id ?? null;

  if ((generateTargets[0] ?? null) !== expectedGenerateTarget) {
    throw toValidationError('Generate step wiring does not match the supported linear subset.', {
      field: 'edges',
      reason: 'invalid_generate_outputs',
      from: generateNode.id,
      targets: generateTargets,
    });
  }

  if (optimizeNode) {
    const optimizeTargets = outgoing.get(optimizeNode.id) ?? [];
    const expectedOptimizeTarget = exportNode?.id ?? null;

    if ((optimizeTargets[0] ?? null) !== expectedOptimizeTarget) {
      throw toValidationError('Optimize step wiring does not match the supported linear subset.', {
        field: 'edges',
        reason: 'invalid_optimize_outputs',
        from: optimizeNode.id,
        targets: optimizeTargets,
      });
    }
  }

  if (exportNode) {
    const exportTargets = outgoing.get(exportNode.id) ?? [];

    if (exportTargets.length !== 0) {
      throw toValidationError('Export step must be terminal in the supported subset.', {
        field: 'edges',
        reason: 'invalid_export_outputs',
        from: exportNode.id,
        targets: exportTargets,
      });
    }
  }

  const steps = ['generate_mesh'];

  if (optimizeNode) {
    steps.push('optimize_mesh');
  }

  if (exportNode) {
    steps.push('export_mesh');
  }

  return {
    displayName,
    modelId: MODEL_TYPE_TO_ID[generateNode.type],
    steps,
  };
}

export function deriveWorkflowRecipeSnapshot(document, sourceWorkflow) {
  const validated = validateWorkflowRecipeDocument(document);

  return {
    id: toRecipeId(validated.displayName),
    kind: 'derived',
    displayName: validated.displayName,
    modelId: validated.modelId,
    sourceWorkflow: {
      relativePath: sourceWorkflow.relativePath,
      name: validated.displayName,
      sha256: sourceWorkflow.sha256,
      mtimeMs: sourceWorkflow.mtimeMs,
      size: sourceWorkflow.size,
    },
    steps: validated.steps,
    limits: { ...SNAPSHOT_LIMITS },
  };
}

export async function deriveWorkflowRecipeSnapshotFromFile(filePath, { relativePath } = {}) {
  const resolvedPath = path.resolve(filePath);
  const [content, fileStat] = await Promise.all([readFile(resolvedPath, 'utf8'), stat(resolvedPath)]);
  const document = JSON.parse(content);

  return deriveWorkflowRecipeSnapshot(document, {
    relativePath: relativePath ?? path.basename(resolvedPath),
    sha256: createHash('sha256').update(content).digest('hex'),
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  });
}

export async function listDerivedRecipeCatalogEntries(catalogDir) {
  const resolvedDir = asNonEmptyString(catalogDir);

  if (!resolvedDir) {
    return [];
  }

  let entries;

  try {
    entries = await readdir(path.resolve(resolvedDir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return [];
    }

    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const snapshots = [];

  for (const fileName of files) {
    const filePath = path.join(resolvedDir, fileName);

    try {
      const snapshot = await deriveWorkflowRecipeSnapshotFromFile(filePath, { relativePath: fileName });

      if (!isEligibleWorkflowRecipeName(snapshot.displayName)) {
        continue;
      }

      snapshots.push(snapshot);
    } catch {
      continue;
    }
  }

  return snapshots;
}

export async function listWorkflowRecipeCatalog({ catalogDir } = {}) {
  return listDerivedRecipeCatalogEntries(catalogDir);
}

export async function revalidateDerivedRecipeSnapshot(snapshot, { catalogDir } = {}) {
  if (!snapshot || snapshot.kind !== 'derived' || !isWorkflowRecipeId(snapshot.id)) {
    throw buildDerivedRecipeValidationError('Derived recipe snapshot revalidation requires a validated workflow/* snapshot.', {
      field: 'recipe',
      reason: 'invalid_derived_recipe_snapshot',
      recipe: snapshot?.id ?? null,
    });
  }

  const resolvedDir = asNonEmptyString(catalogDir);

  if (!resolvedDir) {
    throw buildDerivedRecipeValidationError(`Derived workflow recipe ${snapshot.id} is unavailable because the catalog directory is disabled.`, {
      field: 'recipe',
      reason: 'derived_recipe_catalog_unavailable',
      recipe: snapshot.id,
    });
  }

  const relativePath = asNonEmptyString(snapshot.sourceWorkflow?.relativePath);

  if (!relativePath) {
    throw buildDerivedRecipeValidationError('Derived recipe snapshot is missing source workflow identity.', {
      field: 'recipe.sourceWorkflow.relativePath',
      reason: 'missing_derived_recipe_source_identity',
      recipe: snapshot.id,
    });
  }

  try {
    const refreshed = await deriveWorkflowRecipeSnapshotFromFile(path.join(resolvedDir, relativePath), { relativePath });

    if (!isEligibleWorkflowRecipeName(refreshed.displayName)) {
      throw buildDerivedRecipeValidationError(`Workflow-backed recipe ${snapshot.id} is no longer eligible for execution.`, {
        field: 'recipe',
        reason: 'derived_recipe_no_longer_eligible',
        recipe: snapshot.id,
        relativePath,
      });
    }

    if (refreshed.id !== snapshot.id || !fingerprintsMatch(snapshot.sourceWorkflow, refreshed.sourceWorkflow)) {
      throw buildDerivedRecipeValidationError(`Workflow-backed recipe ${snapshot.id} changed after catalog resolution; refresh modly.recipe.catalog before execution.`, {
        field: 'recipe',
        reason: 'derived_recipe_drift',
        recipe: snapshot.id,
        relativePath,
        expectedSourceWorkflow: snapshot.sourceWorkflow,
        actualSourceWorkflow: refreshed.sourceWorkflow,
      });
    }

    return refreshed;
  } catch (error) {
    if (error instanceof ValidationError && error.details?.reason === 'derived_recipe_drift') {
      throw error;
    }

    if (error instanceof ValidationError && error.details?.reason === 'derived_recipe_no_longer_eligible') {
      throw error;
    }

    throw buildDerivedRecipeValidationError(`Workflow-backed recipe ${snapshot.id} failed revalidation before execution.`, {
      field: 'recipe',
      reason: 'derived_recipe_revalidation_failed',
      recipe: snapshot.id,
      relativePath,
      cause: error instanceof ValidationError ? {
        code: error.code,
        message: error.message,
        details: error.details,
      } : undefined,
    });
  }
}

export async function resolveDerivedRecipeSnapshotForExecution(recipeId, { catalogDir } = {}) {
  if (!isWorkflowRecipeId(recipeId)) {
    throw buildDerivedRecipeValidationError(`Derived workflow recipe id is invalid: ${recipeId}.`, {
      field: 'recipe',
      reason: 'invalid_derived_recipe_id',
      recipe: recipeId ?? null,
    });
  }

  const catalog = await listDerivedRecipeCatalogEntries(catalogDir);
  const snapshot = catalog.find((entry) => entry.id === recipeId);

  if (!snapshot) {
    throw buildDerivedRecipeValidationError(`Derived workflow recipe ${recipeId} is not available in the validated catalog.`, {
      field: 'recipe',
      reason: 'unknown_derived_recipe',
      recipe: recipeId,
    });
  }

  return revalidateDerivedRecipeSnapshot(snapshot, { catalogDir });
}
