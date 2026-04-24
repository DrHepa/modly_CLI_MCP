import { createModlyApiClient } from '../../core/modly-api.mjs';
import { analyzeDiagnosticGuidance } from '../../core/diagnostic-guidance.mjs';
import {
  normalizeErrors,
  normalizePaths,
  toAutomationCapabilities,
  toCurrentModel,
  toJob,
  toModelList,
  toProcessRun,
  toWorkflowRun,
} from '../../core/modly-normalizers.mjs';
import { evaluateCapabilityGuidance, planSmartCapability } from '../../core/smart-capability-planner.mjs';
import { importSceneMeshWithBridge } from '../../core/scene-import.mjs';
import { waitForProcessRun } from '../../core/process-run-wait.mjs';
import { waitForWorkflowRun } from '../../core/workflow-run-wait.mjs';
import { loadAutomationCapabilities, prepareAutomationContext } from './internal/automation-context.mjs';
import {
  createCapabilityExecuteHandler,
} from './internal/capability-execute.mjs';
import { createRecipeExecuteHandler } from './internal/recipe-executor.mjs';
import { listDerivedRecipeCatalogEntries } from './internal/workflow-recipe-catalog.mjs';
import {
  assertCanonicalModelId,
  dispatchProcessRun,
  dispatchWorkflowRunFromImage,
} from './internal/run-dispatch.mjs';
import {
  buildRunMeta,
  summarizeProcessRun,
  summarizeWorkflowRun,
} from './internal/run-meta.mjs';

export {
  RECIPE_V1_ALLOWLIST,
  buildRecipeEnvelope,
  buildRecipeLimits,
  buildRecipeNextAction,
  buildRecipeOutputs,
  buildRecipeSteps,
  deriveRecipeStatusFromSteps,
  parseRecipeResume,
  resolveRecipeRuntime,
} from './internal/recipe-runtime.mjs';

function getModelId(model) {
  return model?.id ?? model?.model_id ?? model?.modelId ?? 'unknown';
}

function summarizeHealth(payload) {
  const status = payload?.status ?? payload?.state ?? 'unknown';
  return `Backend health: ${status}.`;
}

function summarizeCapabilities(capabilities) {
  const backendReady = capabilities?.backend_ready === true;
  const models = Array.isArray(capabilities?.models) ? capabilities.models.length : 0;
  const processes = Array.isArray(capabilities?.processes) ? capabilities.processes.length : 0;
  const errors = Array.isArray(capabilities?.errors) ? capabilities.errors.length : 0;

  return `Automation capabilities: backend_ready=${backendReady}, models=${models}, processes=${processes}, errors=${errors}.`;
}

function summarizeCapabilityPlan(plan) {
  return `Capability plan: ${plan.status}${plan.cap?.key ? ` (${plan.cap.key})` : ''}.`;
}

function summarizeCapabilityGuidance(guidance) {
  return `Capability guidance: ${guidance.status}${guidance.capability_key ? ` (${guidance.capability_key})` : ''}.`;
}

function summarizeModelList(models) {
  return models.length === 0 ? 'No models found.' : `Models available: ${models.length}.`;
}

function summarizeCurrentModel(model) {
  return model ? `Active model: ${getModelId(model)}.` : 'No active model.';
}

function summarizeModelParams(modelId) {
  return `Model params read for ${modelId}.`;
}

function summarizeExtensionErrors(errors) {
  const count = Array.isArray(errors) ? errors.length : Object.keys(errors).length;
  return count === 0 ? 'No extension load errors.' : `Extension load errors: ${count}.`;
}

function summarizeJob(jobId, job) {
  const status = typeof job?.status === 'string' ? job.status : 'unknown';
  return `Job ${jobId}: ${status}.`;
}

function summarizeDiagnosticGuidance(result) {
  return `Diagnostic guidance: ${result.status}/${result.category}/${result.confidence}.`;
}

function summarizeRecipeCatalog(recipes) {
  return recipes.length === 0 ? 'Derived recipe catalog is empty.' : `Derived recipe catalog entries: ${recipes.length}.`;
}

function summarizeSceneMeshImport(result) {
  const parts = [`Scene import ${result.status} for ${result.meshPath}`];

  if (result.sceneId) parts.push(`sceneId=${result.sceneId}`);
  if (result.objectId) parts.push(`objectId=${result.objectId}`);
  if (result.runId) parts.push(`runId=${result.runId}`);
  if (result.statusUrl) parts.push(`statusUrl=${result.statusUrl}`);

  return `${parts.join('; ')}.`;
}


export function createToolHandlers({
  client,
  apiUrl,
  workspaceRoot = process.cwd(),
  recipeWorkflowCatalogDir = null,
  resolveDerivedRecipeSnapshotForExecution,
} = {}) {
  const modlyClient = client ?? createModlyApiClient({ apiUrl });
  const capabilityExecuteHandler = createCapabilityExecuteHandler(modlyClient);
  const recipeExecuteHandler = createRecipeExecuteHandler(modlyClient, {
    recipeWorkflowCatalogDir,
    ...(resolveDerivedRecipeSnapshotForExecution ? { resolveDerivedRecipeSnapshotForExecution } : {}),
  });

  return {
    async 'modly.capabilities.get'() {
      const response = await modlyClient.getAutomationCapabilities();
      const capabilities = toAutomationCapabilities(response);
      return { data: capabilities, text: summarizeCapabilities(capabilities) };
    },

    async 'modly.capability.plan'({ capability, params }) {
      const { capabilities } = await prepareAutomationContext(modlyClient);
      const plan = planSmartCapability({ capability, params }, capabilities);
      return { data: plan, text: summarizeCapabilityPlan(plan) };
    },

    async 'modly.capability.guide'({ capability, params }) {
      const { capabilities } = await prepareAutomationContext(modlyClient);
      const guidance = evaluateCapabilityGuidance({ capability, params }, capabilities);
      return { data: guidance, text: summarizeCapabilityGuidance(guidance) };
    },

    async 'modly.diagnostic.guidance'(input) {
      await prepareAutomationContext(modlyClient);
      const guidance = analyzeDiagnosticGuidance(input);

      return { data: guidance, text: summarizeDiagnosticGuidance(guidance) };
    },

    'modly.capability.execute': capabilityExecuteHandler,

    async 'modly.scene.importMesh'({ meshPath }) {
      const capabilities = await modlyClient.getAutomationCapabilities();
      const result = await importSceneMeshWithBridge({
        workspaceRoot,
        meshPath,
        capabilities,
        importSceneMesh: (payload) => modlyClient.importSceneMesh(payload),
      });

      return { data: result, text: summarizeSceneMeshImport(result) };
    },

    async 'modly.recipe.catalog'() {
      const recipes = await listDerivedRecipeCatalogEntries(recipeWorkflowCatalogDir);
      return { data: { recipes }, text: summarizeRecipeCatalog(recipes) };
    },

    'modly.recipe.execute': recipeExecuteHandler,

    async 'modly.health'() {
      const data = await modlyClient.health();
      return { data, text: summarizeHealth(data) };
    },

    async 'modly.model.list'() {
      const response = await modlyClient.listModels();
      const models = toModelList(response);
      return { data: { models }, text: summarizeModelList(models) };
    },

    async 'modly.model.current'() {
      const response = await modlyClient.getCurrentModel();
      const model = toCurrentModel(response);
      return { data: { model }, text: summarizeCurrentModel(model) };
    },

    async 'modly.model.params'({ modelId }) {
      const modelsResponse = await modlyClient.listModels();
      const models = toModelList(modelsResponse);

      assertCanonicalModelId(modelId, models);

      const params = await modlyClient.getModelParams(modelId);
      return { data: { modelId, params }, text: summarizeModelParams(modelId) };
    },

    async 'modly.ext.errors'() {
      const result = await modlyClient.getExtensionErrors();
      const errors = normalizeErrors(result);
      return { data: { errors, result }, text: summarizeExtensionErrors(errors) };
    },

    async 'modly.config.paths.get'() {
      const result = await modlyClient.getRuntimePaths();
      const paths = normalizePaths(result);
      return { data: { paths, runtimeOnly: true }, text: 'Runtime paths read.' };
    },

    async 'modly.job.status'({ jobId }) {
      const response = await modlyClient.getJobStatus(jobId);
      const job = toJob(jobId, response);
      return { data: { jobId, job }, text: summarizeJob(jobId, job) };
    },

    async 'modly.workflowRun.createFromImage'({ imagePath, modelId, params }) {
      const { run, polling } = await dispatchWorkflowRunFromImage(modlyClient, { imagePath, modelId, params });
      return {
        data: {
          run,
          meta: polling,
        },
        text: summarizeWorkflowRun(undefined, run, 'created'),
      };
    },

    async 'modly.workflowRun.status'({ runId }) {
      const response = await modlyClient.getWorkflowRun(runId);
      const run = toWorkflowRun(runId, response);
      return {
        data: {
          run,
          meta: buildRunMeta('workflowRun', run, 'modly.workflowRun.status'),
        },
        text: summarizeWorkflowRun(runId, run),
      };
    },

    async 'modly.workflowRun.cancel'({ runId }) {
      const response = await modlyClient.cancelWorkflowRun(runId);
      const run = toWorkflowRun(runId, response);
      return { data: { run }, text: summarizeWorkflowRun(runId, run, 'cancelled') };
    },

    async 'modly.workflowRun.wait'({ runId, intervalMs, timeoutMs }) {
      const { run, polling } = await waitForWorkflowRun({
        client: modlyClient,
        runId,
        intervalMs,
        timeoutMs,
      });

      return {
        data: {
          run,
          meta: buildRunMeta('workflowRun', run, 'modly.workflowRun.status', { polling }),
        },
        text: summarizeWorkflowRun(runId, run),
      };
    },

    async 'modly.processRun.create'({ process_id, params, workspace_path, outputPath }) {
      const capabilities = await loadAutomationCapabilities(modlyClient);
      const { run, polling } = await dispatchProcessRun(modlyClient, capabilities, {
        process_id,
        params,
        workspace_path,
        outputPath,
      });

      return {
        data: {
          run,
          meta: polling,
        },
        text: summarizeProcessRun(undefined, run, 'created'),
      };
    },

    async 'modly.processRun.status'({ runId }) {
      const response = await modlyClient.getProcessRun(runId);
      const run = toProcessRun(runId, response);
      return {
        data: {
          run,
          meta: buildRunMeta('processRun', run, 'modly.processRun.status'),
        },
        text: summarizeProcessRun(runId, run),
      };
    },

    async 'modly.processRun.wait'({ runId, intervalMs, timeoutMs }) {
      const { run, polling } = await waitForProcessRun({
        client: modlyClient,
        runId,
        intervalMs,
        timeoutMs,
      });

      return {
        data: {
          run,
          meta: buildRunMeta('processRun', run, 'modly.processRun.status', { polling }),
        },
        text: summarizeProcessRun(runId, run),
      };
    },

    async 'modly.processRun.cancel'({ runId }) {
      const response = await modlyClient.cancelProcessRun(runId);
      const run = toProcessRun(runId, response);
      return { data: { run }, text: summarizeProcessRun(runId, run, 'cancelled') };
    },
  };
}
