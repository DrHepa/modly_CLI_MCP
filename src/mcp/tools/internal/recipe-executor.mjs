import { ValidationError } from '../../../core/errors.mjs';
import { toProcessRun, toWorkflowRun } from '../../../core/modly-normalizers.mjs';
import { prepareProcessRunCreateInput } from '../../../core/process-run-input.mjs';
import { planSmartCapability } from '../../../core/smart-capability-planner.mjs';
import { prepareAutomationContext } from './automation-context.mjs';
import { resolveProcessCapabilityExecutionInput } from './capability-execute.mjs';
import {
  dispatchProcessRun,
  dispatchWorkflowRunFromImage,
} from './run-dispatch.mjs';
import {
  assertRecipeBackendReady,
  assertSupportedRecipePlan,
  buildRecipeResult,
  buildRecipeSteps,
  getRecipeStepDefinition,
  getRequiredRecipeMeshPath,
  markRecipeStepBoundaryFailure,
  markRecipeStepRunning,
  normalizeGuidedRecipeInput,
  normalizeRecipeModelParams,
  parseRecipeResume,
  resolveRecipeRuntime,
  updateRecipeStepFromRun,
} from './recipe-runtime.mjs';
import { resolveDerivedRecipeSnapshotForExecution as resolveDerivedRecipeSnapshotForExecutionDefault } from './workflow-recipe-catalog.mjs';

const EXPORTER_PROCESS_ID = 'mesh-exporter/export';

async function launchRecipeStep(modlyClient, { recipeRuntime, recipeInput, step, steps, capabilities }) {
  const stepDefinition = getRecipeStepDefinition(recipeRuntime, step.id);

  if (stepDefinition.id === 'generate_mesh') {
    const { run } = await dispatchWorkflowRunFromImage(modlyClient, {
      imagePath: recipeInput.imagePath,
      modelId: recipeInput.modelId,
      params: normalizeRecipeModelParams(recipeInput.modelParams),
    });

    return markRecipeStepRunning(step, stepDefinition, run);
  }

  if (stepDefinition.id === 'optimize_mesh') {
    const meshPath = getRequiredRecipeMeshPath(steps, recipeRuntime.id, step.id);
    const plan = planSmartCapability({
      capability: 'mesh optimizer',
      params: recipeInput.optimize?.params,
    }, capabilities);

    assertSupportedRecipePlan(plan, {
      recipe: recipeRuntime.id,
      stepId: step.id,
      expectedSurface: 'processRun.create',
      expectedTargetKind: 'process',
    });

    const resolvedExecution = resolveProcessCapabilityExecutionInput({
      kind: 'mesh',
      meshPath,
      ...(recipeInput.optimize?.outputPath !== undefined ? { outputPath: recipeInput.optimize.outputPath } : {}),
    }, plan);
    const payload = prepareProcessRunCreateInput(resolvedExecution.payload, { capabilities });
    const { run } = await dispatchProcessRun(modlyClient, capabilities, payload, { prepared: true });

    return markRecipeStepRunning(step, stepDefinition, run);
  }

  if (stepDefinition.id === 'export_mesh') {
    const meshPath = getRequiredRecipeMeshPath(steps, recipeRuntime.id, step.id);
    const exporterParams = recipeInput.export?.outputFormat
      ? { output_format: recipeInput.export.outputFormat }
      : {};
    const plan = planSmartCapability({
      capability: 'mesh exporter',
      params: exporterParams,
    }, capabilities);

    assertSupportedRecipePlan(plan, {
      recipe: recipeRuntime.id,
      stepId: step.id,
      expectedSurface: 'processRun.create',
      expectedTargetKind: 'process',
    });

    if (Object.hasOwn(plan.params ?? {}, 'output_path') || Object.hasOwn(plan.params ?? {}, 'outputPath')) {
      throw new ValidationError('mesh-exporter/export must stay in default_output_only mode for guided recipes.', {
        details: {
          field: Object.hasOwn(plan.params ?? {}, 'output_path') ? 'params.output_path' : 'outputPath',
          reason: 'unsupported_output_path_mvp',
          recipe: recipeRuntime.id,
          stepId: step.id,
          capability: EXPORTER_PROCESS_ID,
        },
      });
    }

    const resolvedExecution = resolveProcessCapabilityExecutionInput({
      kind: 'mesh',
      meshPath,
    }, plan);
    const payload = prepareProcessRunCreateInput(resolvedExecution.payload, { capabilities });
    const { run } = await dispatchProcessRun(modlyClient, capabilities, payload, { prepared: true });

    return markRecipeStepRunning(step, stepDefinition, run);
  }

  throw new ValidationError(`Unsupported recipe step launch: ${stepDefinition.id}.`, {
    details: { field: 'step.id', reason: 'unsupported_recipe_step_launch', stepId: stepDefinition.id },
  });
}

async function pollRecipeStepRun(modlyClient, recipeRuntime, step) {
  const stepDefinition = getRecipeStepDefinition(recipeRuntime, step.id);
  const runId = step.run?.runId;

  if (!runId) {
    throw new ValidationError(`Recipe step ${step.id} is missing run.runId for resume polling.`, {
      details: { field: `steps.${step.id}.run.runId`, reason: 'missing_recipe_run_id', recipe: recipeRuntime.id },
    });
  }

  if (stepDefinition.runKind === 'workflowRun') {
    const response = await modlyClient.getWorkflowRun(runId);
    return updateRecipeStepFromRun(step, stepDefinition, toWorkflowRun(runId, response));
  }

  const response = await modlyClient.getProcessRun(runId);
  return updateRecipeStepFromRun(step, stepDefinition, toProcessRun(runId, response));
}

function isWorkflowRecipeId(recipe) {
  return typeof recipe === 'string' && recipe.trim().startsWith('workflow/');
}

async function resolveRecipeForExecution(recipe, {
  recipeWorkflowCatalogDir,
  resolveDerivedRecipeSnapshotForExecution,
}) {
  if (isWorkflowRecipeId(recipe)) {
    return resolveDerivedRecipeSnapshotForExecution(recipe, { catalogDir: recipeWorkflowCatalogDir });
  }

  return recipe;
}

export function createRecipeExecuteHandler(modlyClient, {
  recipeWorkflowCatalogDir = null,
  resolveDerivedRecipeSnapshotForExecution = resolveDerivedRecipeSnapshotForExecutionDefault,
} = {}) {
  return async function recipeExecuteHandler({ recipe, input, options }) {
    const resolvedRecipe = await resolveRecipeForExecution(recipe, {
      recipeWorkflowCatalogDir,
      resolveDerivedRecipeSnapshotForExecution,
    });
    const recipeRuntime = resolveRecipeRuntime(resolvedRecipe);
    const recipeId = recipeRuntime.id;
    const recipeInput = normalizeGuidedRecipeInput(recipeRuntime, input);
    const resume = parseRecipeResume(options?.resume);
    const { health, capabilities } = await prepareAutomationContext(modlyClient);
    const steps = buildRecipeSteps(recipeRuntime, resume);
    const activeStepIndex = steps.findIndex((step) => step.status === 'running' && step.run?.runId);

    try {
      assertRecipeBackendReady({ health, capabilities, recipe: recipeRuntime.id });
    } catch (error) {
      const fallbackStepIndex = activeStepIndex >= 0
        ? activeStepIndex
        : Math.max(steps.findIndex((step) => step.status === 'pending'), 0);
      markRecipeStepBoundaryFailure(steps, fallbackStepIndex, error);
      return buildRecipeResult({ recipe: recipeId, recipeRuntime, input: recipeInput, steps });
    }

    if (activeStepIndex >= 0) {
      steps[activeStepIndex] = await pollRecipeStepRun(modlyClient, recipeRuntime, steps[activeStepIndex]);

      if (steps[activeStepIndex].status === 'succeeded') {
        const nextPendingStep = steps.find((step) => step.status === 'pending');

        if (nextPendingStep) {
          const nextIndex = steps.findIndex((step) => step.id === nextPendingStep.id);
          try {
            steps[nextIndex] = await launchRecipeStep(modlyClient, {
              recipeRuntime,
              recipeInput,
              step: steps[nextIndex],
              steps,
              capabilities,
            });
          } catch (error) {
            markRecipeStepBoundaryFailure(steps, nextIndex, error);
          }
        }
      }

      return buildRecipeResult({ recipe: recipeId, recipeRuntime, input: recipeInput, steps });
    }

    if (steps.some((step) => step.status === 'failed' || step.status === 'partial_failed' || step.status === 'cancelled')) {
      return buildRecipeResult({ recipe: recipeId, recipeRuntime, input: recipeInput, steps });
    }

    const nextPendingIndex = steps.findIndex((step) => step.status === 'pending');

    if (nextPendingIndex === -1) {
      return buildRecipeResult({ recipe: recipeId, recipeRuntime, input: recipeInput, steps });
    }

    try {
      steps[nextPendingIndex] = await launchRecipeStep(modlyClient, {
        recipeRuntime,
        recipeInput,
        step: steps[nextPendingIndex],
        steps,
        capabilities,
      });
    } catch (error) {
      markRecipeStepBoundaryFailure(steps, nextPendingIndex, error);
    }

    return buildRecipeResult({ recipe: recipeId, recipeRuntime, input: recipeInput, steps });
  };
}
