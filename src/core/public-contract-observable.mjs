const DEFAULT_REPO_LOCAL_WRAPPER_PATH = 'tools/modly_mcp/run_server.mjs';
const DEFAULT_LOCAL_ENV_PATH = 'tools/_tmp/modly_mcp/local.env';
const DEFAULT_GLOBAL_COMMAND = ['modly-mcp'];
const DEFAULT_RECIPE_TOOL_ID = 'modly.recipe.execute';
const DEFAULT_RECIPE_FLAG = 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE';
const WRAPPER_ENV_PATH_FRAGMENTS = ["'tools'", "'_tmp'", "'modly_mcp'", "'local.env'"];

function extractObjectLiteralBlock(source, declarationName) {
  const declarationIndex = source.indexOf(`const ${declarationName} = {`);

  if (declarationIndex === -1) {
    throw new Error(`Could not find ${declarationName} declaration.`);
  }

  const openBraceIndex = source.indexOf('{', declarationIndex);
  let depth = 0;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(openBraceIndex + 1, index);
      }
    }
  }

  throw new Error(`Could not parse ${declarationName} object literal.`);
}

function extractObjectKeys(source, declarationName) {
  return extractObjectLiteralBlock(source, declarationName)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^('([^']+)'|([a-z][a-z-]*))\s*:/u))
    .filter(Boolean)
    .map((match) => match[2] ?? match[3]);
}

function hasWrapperFeature(wrapperSource, fragments) {
  return fragments.every((fragment) => wrapperSource.includes(fragment));
}

function extractHelpGroups(helpText) {
  const lines = helpText.split('\n');
  const groupHeaderIndex = lines.findIndex((line) => line.trim() === 'Grupos disponibles:');

  if (groupHeaderIndex === -1) {
    return [];
  }

  const groups = [];

  for (let index = groupHeaderIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      break;
    }

    const match = line.match(/^\s{2}([a-z-]+)\b/u);
    if (match) {
      groups.push(match[1]);
    }
  }

  return groups;
}

function difference(expected, actual) {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value));
}

function extractInlineCodeTokens(markdown) {
  return Array.from(markdown.matchAll(/`([^`]+)`/gu), (match) => match[1]);
}

function extractCommandArray(markdown) {
  const commandMatch = markdown.match(/"command"\s*:\s*\[(.*?)\]/su);

  if (!commandMatch) {
    return null;
  }

  return Array.from(commandMatch[1].matchAll(/"([^"]+)"/gu), (match) => match[1]);
}

function includesSourceCheckoutUnsupported(text) {
  return /source checkout|checkout fuente/iu.test(text);
}

function includesLocalFirstGlobalFallback(text) {
  return /local-first/iu.test(text) && /global-fallback|falls back to a global|fallback to a global/iu.test(text);
}

export function buildObservableContract({
  packageJson,
  cliIndexSource,
  wrapperSource,
  publicCatalog,
  repoLocalWrapperPath = DEFAULT_REPO_LOCAL_WRAPPER_PATH,
}) {
  return {
    bins: Object.entries(packageJson.bin ?? {}).map(([name, entrypoint]) => ({ name, entrypoint })),
    cliGroups: extractObjectKeys(cliIndexSource, 'commandHandlers'),
    mcp: {
      defaultPublicToolIds: publicCatalog.map((tool) => tool.name),
    },
    installModes: {
      global: {
        command: DEFAULT_GLOBAL_COMMAND,
        supported: Boolean(packageJson.bin?.['modly-mcp']),
      },
      repoLocal: {
        wrapperPath: repoLocalWrapperPath,
        checkFlag: hasWrapperFeature(wrapperSource, ["argv.includes('--check')"]) ? '--check' : null,
        envFile: hasWrapperFeature(wrapperSource, WRAPPER_ENV_PATH_FRAGMENTS) ? DEFAULT_LOCAL_ENV_PATH : null,
        resolutionOrder: hasWrapperFeature(wrapperSource, ["mode: 'local'", "mode: 'global'"])
          ? ['local', 'global']
          : [],
        sourceCheckoutUnsupported: hasWrapperFeature(wrapperSource, ['source checkout', 'tools/modly_mcp/run_server.mjs']),
      },
    },
    recipeGating: {
      toolId: DEFAULT_RECIPE_TOOL_ID,
      envFlag: DEFAULT_RECIPE_FLAG,
      hiddenByDefault: !publicCatalog.some((tool) => tool.name === DEFAULT_RECIPE_TOOL_ID),
    },
  };
}

export function detectVisibleContractDrift({
  observableContract,
  commandGroups,
  mcpToolIds,
  helpText,
}) {
  const drifts = [];
  const missingCommandGroups = difference(observableContract.cliGroups, commandGroups);

  if (missingCommandGroups.length > 0) {
    drifts.push({
      code: 'contracts.command-groups.missing',
      source: 'src/core/contracts.mjs',
      missing: missingCommandGroups,
    });
  }

  const hiddenByDefaultToolIds = mcpToolIds.filter(
    (toolId) => !observableContract.mcp.defaultPublicToolIds.includes(toolId) && toolId === DEFAULT_RECIPE_TOOL_ID,
  );

  if (hiddenByDefaultToolIds.length > 0) {
    drifts.push({
      code: 'contracts.mcp-tool-ids.hidden-by-default-exposed',
      source: 'src/core/contracts.mjs',
      hiddenByDefaultToolIds,
    });
  }

  const nonPublicToolIds = mcpToolIds.filter(
    (toolId) => !observableContract.mcp.defaultPublicToolIds.includes(toolId) && toolId !== DEFAULT_RECIPE_TOOL_ID,
  );

  if (nonPublicToolIds.length > 0) {
    drifts.push({
      code: 'contracts.mcp-tool-ids.non-public-exposed',
      source: 'src/core/contracts.mjs',
      nonPublicToolIds,
    });
  }

  const helpGroups = extractHelpGroups(helpText);
  const missingHelpGroups = difference(observableContract.cliGroups, helpGroups);

  if (missingHelpGroups.length > 0) {
    drifts.push({
      code: 'help.command-groups.missing',
      source: 'src/cli/help.mjs',
      missing: missingHelpGroups,
    });
  }

  const staleDeferredSnippet = 'MCP real sigue diferido';
  if (helpText.includes(staleDeferredSnippet)) {
    drifts.push({
      code: 'help.stale-deferred-mcp-language',
      source: 'src/cli/help.mjs',
      snippet: staleDeferredSnippet,
    });
  }

  const recipeGatingTokens = [
    DEFAULT_RECIPE_TOOL_ID,
    'experimental',
    'opt-in',
    'hidden by default',
    DEFAULT_RECIPE_FLAG,
  ];
  const missingRecipeGatingTokens = recipeGatingTokens.filter((token) => !helpText.includes(token));

  if (missingRecipeGatingTokens.length > 0) {
    drifts.push({
      code: 'help.missing-recipe-gating',
      source: 'src/cli/help.mjs',
      missing: missingRecipeGatingTokens,
    });
  }

  return drifts;
}

export function detectDocumentationContractDrift({
  observableContract,
  readmeText,
  globalInstallDocText,
  repoLocalInstallDocText,
  globalTemplate,
  mvpSpecText,
}) {
  const drifts = [];
  const readmeTokens = extractInlineCodeTokens(readmeText);
  const missingReadmeGroups = difference(observableContract.cliGroups, readmeTokens);

  if (missingReadmeGroups.length > 0) {
    drifts.push({
      code: 'readme.cli-groups.missing',
      source: 'README.md',
      missing: missingReadmeGroups,
    });
  }

  const missingReadmeToolIds = difference(observableContract.mcp.defaultPublicToolIds, readmeTokens);

  if (missingReadmeToolIds.length > 0) {
    drifts.push({
      code: 'readme.mcp-tool-ids.missing',
      source: 'README.md',
      missing: missingReadmeToolIds,
    });
  }

  const missingReadmeInstallModes = [];
  if (!readmeText.includes('"command": ["modly-mcp"]')) {
    missingReadmeInstallModes.push('global-command');
  }
  if (!readmeText.includes(observableContract.installModes.repoLocal.wrapperPath)) {
    missingReadmeInstallModes.push('repo-local-wrapper');
  }
  if (!includesSourceCheckoutUnsupported(readmeText)) {
    missingReadmeInstallModes.push('source-checkout-unsupported');
  }

  if (missingReadmeInstallModes.length > 0) {
    drifts.push({
      code: 'readme.install-modes.missing',
      source: 'README.md',
      missing: missingReadmeInstallModes,
    });
  }

  const missingReadmeExecutionBoundaries = [];
  if (!readmeText.includes('workflow-run` / `process-run` are the primary run surfaces')) {
    missingReadmeExecutionBoundaries.push('workflow-process-primary');
  }
  if (!readmeText.includes('`generate` / `job` remain observable compatibility surfaces')) {
    missingReadmeExecutionBoundaries.push('generate-job-compatibility');
  }

  if (missingReadmeExecutionBoundaries.length > 0) {
    drifts.push({
      code: 'readme.execution-boundaries.missing',
      source: 'README.md',
      missing: missingReadmeExecutionBoundaries,
    });
  }

  const readmeRecipeTokens = [
    observableContract.recipeGating.toolId,
    'experimental',
    'opt-in',
    'hidden by default',
    observableContract.recipeGating.envFlag,
  ];
  const missingReadmeRecipeTokens = readmeRecipeTokens.filter((token) => !readmeText.includes(token));

  if (missingReadmeRecipeTokens.length > 0) {
    drifts.push({
      code: 'readme.recipe-gating.missing',
      source: 'README.md',
      missing: missingReadmeRecipeTokens,
    });
  }

  const globalCommand = extractCommandArray(globalInstallDocText);
  if (JSON.stringify(globalCommand) !== JSON.stringify(observableContract.installModes.global.command)) {
    drifts.push({
      code: 'global-install.command-shape.mismatch',
      source: 'docs/install/global.md',
      actual: globalCommand,
      expected: observableContract.installModes.global.command,
    });
  }

  const missingGlobalRuntimeNotes = [
    'MODLY_API_URL',
    'MODLY_AUTOMATION_URL',
    'MODLY_PROCESS_URL',
  ].filter((token) => !globalInstallDocText.includes(token));

  if (missingGlobalRuntimeNotes.length > 0) {
    drifts.push({
      code: 'global-install.runtime-notes.missing',
      source: 'docs/install/global.md',
      missing: missingGlobalRuntimeNotes,
    });
  }

  const missingRepoLocalContract = [];
  if (!repoLocalInstallDocText.includes(observableContract.installModes.repoLocal.wrapperPath)) {
    missingRepoLocalContract.push(observableContract.installModes.repoLocal.wrapperPath);
  }
  if (!repoLocalInstallDocText.includes(observableContract.installModes.repoLocal.checkFlag)) {
    missingRepoLocalContract.push(observableContract.installModes.repoLocal.checkFlag);
  }
  if (!repoLocalInstallDocText.includes(observableContract.installModes.repoLocal.envFile)) {
    missingRepoLocalContract.push(observableContract.installModes.repoLocal.envFile);
  }
  if (!includesLocalFirstGlobalFallback(repoLocalInstallDocText)) {
    missingRepoLocalContract.push('local-first-global-fallback');
  }

  if (missingRepoLocalContract.length > 0) {
    drifts.push({
      code: 'repo-local.wrapper-contract.missing',
      source: 'docs/install/repo-local.md',
      missing: missingRepoLocalContract,
    });
  }

  if (!includesSourceCheckoutUnsupported(repoLocalInstallDocText)) {
    drifts.push({
      code: 'repo-local.unsupported-source-checkout.missing',
      source: 'docs/install/repo-local.md',
    });
  }

  const templateCommand = globalTemplate?.mcp?.modly?.command ?? null;
  if (JSON.stringify(templateCommand) !== JSON.stringify(observableContract.installModes.global.command)) {
    drifts.push({
      code: 'template.global-command.mismatch',
      source: 'templates/opencode/opencode.json',
      actual: templateCommand,
      expected: observableContract.installModes.global.command,
    });
  }

  if (typeof mvpSpecText === 'string') {
    const specTokens = extractInlineCodeTokens(mvpSpecText);
    const missingSpecGroups = difference(observableContract.cliGroups, specTokens);

    if (missingSpecGroups.length > 0) {
      drifts.push({
        code: 'mvp-spec.cli-groups.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: missingSpecGroups,
      });
    }

    const missingSpecBins = difference(observableContract.bins.map(({ name }) => name), specTokens);

    if (missingSpecBins.length > 0) {
      drifts.push({
        code: 'mvp-spec.bins.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: missingSpecBins,
      });
    }

    const missingSpecToolIds = difference(observableContract.mcp.defaultPublicToolIds, specTokens);

    if (missingSpecToolIds.length > 0) {
      drifts.push({
        code: 'mvp-spec.mcp-tool-ids.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: missingSpecToolIds,
      });
    }

    const missingSpecInstallModes = [];
    if (!mvpSpecText.includes('"command": ["modly-mcp"]')) {
      missingSpecInstallModes.push('global-command');
    }
    if (!mvpSpecText.includes(observableContract.installModes.repoLocal.wrapperPath)) {
      missingSpecInstallModes.push('repo-local-wrapper');
    }
    if (!includesSourceCheckoutUnsupported(mvpSpecText)) {
      missingSpecInstallModes.push('source-checkout-unsupported');
    }

    if (missingSpecInstallModes.length > 0) {
      drifts.push({
        code: 'mvp-spec.install-modes.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: missingSpecInstallModes,
      });
    }

    const missingSpecExecutionBoundaries = [];
    if (!mvpSpecText.includes('workflow-run` / `process-run` are the primary run surfaces')) {
      missingSpecExecutionBoundaries.push('workflow-process-primary');
    }
    if (!mvpSpecText.includes('`generate` / `job` remain observable compatibility surfaces')) {
      missingSpecExecutionBoundaries.push('generate-job-compatibility');
    }

    if (missingSpecExecutionBoundaries.length > 0) {
      drifts.push({
        code: 'mvp-spec.execution-boundaries.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: missingSpecExecutionBoundaries,
      });
    }

    const specRecipeTokens = [
      observableContract.recipeGating.toolId,
      'experimental',
      'opt-in',
      'hidden by default',
      observableContract.recipeGating.envFlag,
    ];
    const missingSpecRecipeTokens = specRecipeTokens.filter((token) => !mvpSpecText.includes(token));

    if (missingSpecRecipeTokens.length > 0) {
      drifts.push({
        code: 'mvp-spec.recipe-gating.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: missingSpecRecipeTokens,
      });
    }
  }

  return drifts;
}
