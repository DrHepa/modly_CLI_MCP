import { ModlyError } from '../../../core/errors.mjs';

const EXPERIMENTAL_RECIPE_TOOL = 'modly.recipe.execute';
const EXPERIMENTAL_RECIPE_FLAG = 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE';

function isExperimentalRecipeDisabled({ name, experimentalRecipeExecution }) {
  return name === EXPERIMENTAL_RECIPE_TOOL && experimentalRecipeExecution !== true;
}

function createExperimentalRecipeDisabledError() {
  return new ModlyError(`${EXPERIMENTAL_RECIPE_TOOL} requires explicit opt-in.`, {
    code: 'EXPERIMENTAL_FEATURE_DISABLED',
    details: {
      tool: EXPERIMENTAL_RECIPE_TOOL,
      flag: EXPERIMENTAL_RECIPE_FLAG,
      reason: 'experimental_feature_disabled',
    },
  });
}

export function createPublicCatalog({ catalog, experimentalRecipeExecution = false }) {
  return catalog.filter(
    (tool) => !isExperimentalRecipeDisabled({ name: tool.name, experimentalRecipeExecution }),
  );
}

export function ensureToolEnabled({ name, experimentalRecipeExecution }) {
  if (!isExperimentalRecipeDisabled({ name, experimentalRecipeExecution })) {
    return;
  }

  throw createExperimentalRecipeDisabledError();
}
