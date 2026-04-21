import { ModlyError } from '../../../core/errors.mjs';

const EXPERIMENTAL_RECIPE_TOOLS = new Set(['modly.recipe.catalog', 'modly.recipe.execute']);
const EXPERIMENTAL_RECIPE_FLAG = 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE';

function isExperimentalRecipeDisabled({ name, experimentalRecipeExecution }) {
  return EXPERIMENTAL_RECIPE_TOOLS.has(name) && experimentalRecipeExecution !== true;
}

function createExperimentalRecipeDisabledError(name) {
  return new ModlyError(`${name} requires explicit opt-in.`, {
    code: 'EXPERIMENTAL_FEATURE_DISABLED',
    details: {
      tool: name,
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

  throw createExperimentalRecipeDisabledError(name);
}
