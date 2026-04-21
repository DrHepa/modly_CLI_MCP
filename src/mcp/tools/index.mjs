import { ModlyError, UnsupportedOperationError } from '../../core/errors.mjs';
import { createModlyApiClient } from '../../core/modly-api.mjs';
import { MCP_TOOL_CATALOG } from './catalog.mjs';
import { createToolHandlers } from './handlers.mjs';
import { assertBackendReady, PREFLIGHT_EXEMPT_TOOLS } from './internal/registry-preflight.mjs';
import { createErrorResult, createSuccessResult } from './internal/registry-results.mjs';
import { createPublicCatalog, ensureToolEnabled } from './internal/registry-gating.mjs';
import {
  sanitizeArguments,
} from './internal/registry-validation.mjs';

export { OPEN_INPUT_PATH_ALLOWLIST, matchesOpenInputPath } from './internal/registry-validation.mjs';

export function createToolRegistry({
  apiUrl,
  experimentalRecipeExecution = false,
  recipeWorkflowCatalogDir = null,
  resolveDerivedRecipeSnapshotForExecution,
}) {
  const client = createModlyApiClient({ apiUrl });
  const handlers = createToolHandlers({
    client,
    apiUrl,
    recipeWorkflowCatalogDir,
    resolveDerivedRecipeSnapshotForExecution,
  });
  const catalogByName = new Map(MCP_TOOL_CATALOG.map((tool) => [tool.name, tool]));
  const publicCatalog = createPublicCatalog({ catalog: MCP_TOOL_CATALOG, experimentalRecipeExecution });

  return {
    catalog: publicCatalog,
    client,
    async invoke(name, args = {}) {
      const tool = catalogByName.get(name);

      if (!tool) {
        return createErrorResult({
          toolName: name,
          error: new UnsupportedOperationError(`Unknown MCP tool: ${name}`, { code: 'UNSUPPORTED_OPERATION' }),
        });
      }

      try {
        ensureToolEnabled({ name, experimentalRecipeExecution });
        const input = sanitizeArguments(tool, args);
        const handler = handlers[name];

        if (!handler) {
          throw new UnsupportedOperationError(`${name} is not available in this MVP batch.`, {
            code: 'UNSUPPORTED_OPERATION',
          });
        }

        if (!PREFLIGHT_EXEMPT_TOOLS.has(name)) {
          await assertBackendReady({ client, toolName: name });
        }

        const result = await handler(input);

        if (result === null || typeof result !== 'object' || !Object.hasOwn(result, 'data')) {
          throw new ModlyError(`Handler for ${name} returned an invalid result.`, {
            code: 'INVALID_HANDLER_RESULT',
          });
        }

        return createSuccessResult({
          toolName: name,
          data: result.data,
          text: result.text,
        });
      } catch (error) {
        return createErrorResult({ toolName: name, error });
      }
    },
  };
}
