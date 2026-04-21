import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { renderHelp } from '../../src/cli/help.mjs';
import { COMMAND_GROUPS, EXECUTION_SURFACE_TAXONOMY, MCP_TOOL_IDS } from '../../src/core/contracts.mjs';
import {
  buildObservableContract,
  detectDocumentationContractDrift,
  detectVisibleContractDrift,
} from '../../src/core/public-contract-observable.mjs';
import { MCP_TOOL_CATALOG } from '../../src/mcp/tools/catalog.mjs';
import { createPublicCatalog } from '../../src/mcp/tools/internal/registry-gating.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

const EXPECTED_CLI_GROUPS = [
  'capabilities',
  'health',
  'model',
  'generate',
  'job',
  'process-run',
  'workflow-run',
  'mesh',
  'ext',
  'ext-dev',
  'config',
];

const EXPECTED_DEFAULT_PUBLIC_TOOLS = [
  'modly.capabilities.get',
  'modly.capability.plan',
  'modly.capability.guide',
  'modly.diagnostic.guidance',
  'modly.capability.execute',
  'modly.health',
  'modly.model.list',
  'modly.model.current',
  'modly.model.params',
  'modly.ext.errors',
  'modly.config.paths.get',
  'modly.job.status',
  'modly.workflowRun.createFromImage',
  'modly.workflowRun.status',
  'modly.workflowRun.cancel',
  'modly.workflowRun.wait',
  'modly.processRun.create',
  'modly.processRun.status',
  'modly.processRun.wait',
  'modly.processRun.cancel',
];

const EXPECTED_EXPERIMENTAL_PUBLIC_TOOLS = [
  'modly.capabilities.get',
  'modly.capability.plan',
  'modly.capability.guide',
  'modly.diagnostic.guidance',
  'modly.capability.execute',
  'modly.recipe.catalog',
  'modly.recipe.execute',
  'modly.health',
  'modly.model.list',
  'modly.model.current',
  'modly.model.params',
  'modly.ext.errors',
  'modly.config.paths.get',
  'modly.job.status',
  'modly.workflowRun.createFromImage',
  'modly.workflowRun.status',
  'modly.workflowRun.cancel',
  'modly.workflowRun.wait',
  'modly.processRun.create',
  'modly.processRun.status',
  'modly.processRun.wait',
  'modly.processRun.cancel',
];

test('buildObservableContract freezes bins, groups, install modes, and default public MCP tools', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  assert.deepEqual(observableContract.bins, [
    { name: 'modly', entrypoint: 'src/cli/index.mjs' },
    { name: 'modly-mcp', entrypoint: 'src/mcp/server.mjs' },
  ]);
  assert.deepEqual(observableContract.cliGroups, EXPECTED_CLI_GROUPS);
  assert.deepEqual(observableContract.mcp.defaultPublicToolIds, EXPECTED_DEFAULT_PUBLIC_TOOLS);
  assert.deepEqual(observableContract.installModes, {
    global: {
      command: ['modly-mcp'],
      supported: true,
    },
    repoLocal: {
      wrapperPath: 'tools/modly_mcp/run_server.mjs',
      checkFlag: '--check',
      envFile: 'tools/_tmp/modly_mcp/local.env',
      resolutionOrder: ['local', 'global'],
      sourceCheckoutUnsupported: true,
    },
  });
  assert.deepEqual(observableContract.recipeGating, {
    toolId: 'modly.recipe.execute',
    envFlag: 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE',
    hiddenByDefault: true,
  });
  assert.deepEqual(observableContract.executionSurfaces, {
    taxonomy: EXECUTION_SURFACE_TAXONOMY,
    canonicalRecovery: {
      cliGroups: ['workflow-run', 'process-run'],
      mcpToolIds: [
        'modly.workflowRun.status',
        'modly.workflowRun.wait',
        'modly.processRun.status',
        'modly.processRun.wait',
      ],
    },
  });
});

test('detectVisibleContractDrift flags taxonomy overlap and legacy promotion', () => {
  const overlappingObservableContract = {
    cliGroups: EXPECTED_CLI_GROUPS,
    mcp: {
      defaultPublicToolIds: EXPECTED_DEFAULT_PUBLIC_TOOLS,
    },
    recipeGating: {
      toolId: 'modly.recipe.execute',
      envFlag: 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE',
      hiddenByDefault: true,
    },
    executionSurfaces: {
      taxonomy: {
        canonical: {
          label: 'canonical run primitive',
          cliGroups: ['workflow-run', 'job'],
          mcpToolIds: ['modly.workflowRun.status', 'modly.job.status'],
        },
        wrapper: {
          label: 'orchestration wrapper',
          cliGroups: [],
          mcpToolIds: ['modly.capability.execute', 'modly.recipe.execute'],
        },
        legacy: {
          label: 'legacy compatibility',
          cliGroups: ['generate', 'job'],
          mcpToolIds: ['modly.job.status'],
        },
      },
      canonicalRecovery: {
        cliGroups: ['workflow-run', 'process-run'],
        mcpToolIds: ['modly.workflowRun.status', 'modly.processRun.status'],
      },
    },
  };

  const helpText = `modly — CLI headless para Modly

Grupos disponibles:
  capabilities
  health
  model
  generate
  job
  process-run
  workflow-run
  mesh
  ext
  ext-dev
  config

Notas:
  - workflow-run y process-run son las superficies run principales
  - generate/job ahora son la ruta principal de ejecución
  - modly.recipe.execute es experimental, opt-in y hidden by default mediante MODLY_EXPERIMENTAL_RECIPE_EXECUTE.
`;

  assert.deepEqual(
    detectVisibleContractDrift({
      observableContract: overlappingObservableContract,
      commandGroups: EXPECTED_CLI_GROUPS,
      mcpToolIds: EXPECTED_DEFAULT_PUBLIC_TOOLS,
      helpText,
    }),
    [
      {
        code: 'contracts.execution-surface-taxonomy.overlap',
        source: 'src/core/public-contract-observable.mjs',
        surfaces: ['job', 'modly.job.status'],
      },
      {
        code: 'help.execution-surfaces.legacy-promoted',
        source: 'src/cli/help.mjs',
        legacySurfaces: ['generate', 'job'],
      },
    ],
  );
});

test('detectVisibleContractDrift flags wrapper promotion and missing canonical recovery language', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  const helpText = `modly — CLI headless para Modly

Grupos disponibles:
  capabilities
  health
  model
  generate
  job
  process-run
  workflow-run
  mesh
  ext
  ext-dev
  config

Notas:
  - modly.capability.execute ahora es la superficie principal de ejecución
  - generate/job se mantienen como compatibilidad observable actual
  - modly.recipe.execute es experimental, opt-in y hidden by default mediante MODLY_EXPERIMENTAL_RECIPE_EXECUTE.
`;

  assert.deepEqual(
    detectVisibleContractDrift({
      observableContract,
      commandGroups: EXPECTED_CLI_GROUPS,
      mcpToolIds: EXPECTED_DEFAULT_PUBLIC_TOOLS,
      helpText,
    }),
    [
      {
        code: 'help.execution-surfaces.wrapper-promoted',
        source: 'src/cli/help.mjs',
        wrapperSurfaces: ['modly.capability.execute', 'modly.recipe.execute'],
      },
      {
        code: 'help.execution-surfaces.canonical-recovery-missing',
        source: 'src/cli/help.mjs',
        missing: ['workflow-run', 'process-run'],
      },
    ],
  );
});

test('buildObservableContract includes recipe execution only in the opt-in public catalog', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({
      catalog: MCP_TOOL_CATALOG,
      experimentalRecipeExecution: true,
    }),
  });

  assert.deepEqual(observableContract.mcp.defaultPublicToolIds, EXPECTED_EXPERIMENTAL_PUBLIC_TOOLS);
  assert.equal(observableContract.mcp.defaultPublicToolIds.includes('modly.recipe.catalog'), true);
  assert.equal(observableContract.mcp.defaultPublicToolIds.includes('modly.recipe.execute'), true);
});

test('detectVisibleContractDrift enumerates the Batch 1 drift when stale inputs are provided', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  const staleCommandGroups = [
    'capabilities',
    'health',
    'model',
    'generate',
    'job',
    'process-run',
    'mesh',
    'ext',
    'config',
  ];

  const staleMcpToolIds = [
    'modly.capabilities.get',
    'modly.capability.plan',
    'modly.capability.guide',
    'modly.health',
    'modly.model.list',
    'modly.model.current',
    'modly.model.params',
    'modly.model.switch',
    'modly.model.unloadAll',
    'modly.model.download',
    'modly.generate.fromImage',
    'modly.job.status',
    'modly.job.wait',
    'modly.job.cancel',
    'modly.workflowRun.createFromImage',
    'modly.workflowRun.status',
    'modly.workflowRun.cancel',
    'modly.processRun.create',
    'modly.processRun.status',
    'modly.processRun.wait',
    'modly.processRun.cancel',
    'modly.mesh.optimize',
    'modly.mesh.smooth',
    'modly.mesh.export',
    'modly.ext.reload',
    'modly.ext.errors',
    'modly.config.paths.get',
    'modly.config.paths.set',
    'modly.workflowRun.wait',
    'modly.capability.execute',
    'modly.diagnostic.guidance',
    'modly.recipe.execute',
  ];

  const staleHelpText = `modly — CLI headless para Modly

Uso:
  modly [--api-url <url>] [--json] <grupo> [subcomando]

Grupos disponibles:
  capabilities              Descubre capabilities de automatización
  health                    Verifica GET /health
  model <subcomando>        list | current | params | switch | unload-all | download
  generate <subcomando>     from-image
  job <subcomando>          status | wait | cancel
  process-run <subcomando>  create | status | wait | cancel
  workflow-run <subcomando> from-image | status | wait | cancel
  mesh <subcomando>         optimize | smooth | export
  ext <subcomando>          reload | errors
  ext-dev <subcomando>      bucket-detect | preflight | scaffold | audit | release-plan
  config <subcomando>       paths get | paths set

Estado del bootstrap:
  - capabilities, health, model, job, process-run, workflow-run, generate from-image, mesh, ext y config ya son funcionales
  - MCP real sigue diferido
`;

  assert.deepEqual(
    detectVisibleContractDrift({
      observableContract,
      commandGroups: staleCommandGroups,
      mcpToolIds: staleMcpToolIds,
      helpText: staleHelpText,
    }),
    [
      {
        code: 'contracts.command-groups.missing',
        source: 'src/core/contracts.mjs',
        missing: ['workflow-run', 'ext-dev'],
      },
      {
        code: 'contracts.mcp-tool-ids.hidden-by-default-exposed',
        source: 'src/core/contracts.mjs',
        hiddenByDefaultToolIds: ['modly.recipe.execute'],
      },
      {
        code: 'contracts.mcp-tool-ids.non-public-exposed',
        source: 'src/core/contracts.mjs',
        nonPublicToolIds: [
          'modly.model.switch',
          'modly.model.unloadAll',
          'modly.model.download',
          'modly.generate.fromImage',
          'modly.job.wait',
          'modly.job.cancel',
          'modly.mesh.optimize',
          'modly.mesh.smooth',
          'modly.mesh.export',
          'modly.ext.reload',
          'modly.config.paths.set',
        ],
      },
      {
        code: 'help.stale-deferred-mcp-language',
        source: 'src/cli/help.mjs',
        snippet: 'MCP real sigue diferido',
      },
      {
        code: 'help.missing-recipe-gating',
        source: 'src/cli/help.mjs',
        missing: [
          'modly.recipe.execute',
          'experimental',
          'opt-in',
          'hidden by default',
          'MODLY_EXPERIMENTAL_RECIPE_EXECUTE',
        ],
      },
      {
        code: 'help.execution-surfaces.canonical-recovery-missing',
        source: 'src/cli/help.mjs',
        missing: ['workflow-run', 'process-run'],
      },
    ],
  );
});

test('detectVisibleContractDrift returns no mismatches for an already aligned contract', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  const alignedHelp = `modly — CLI headless para Modly

Grupos disponibles:
  capabilities
  health
  model
  generate
  job
  process-run
  workflow-run
  mesh
  ext
  ext-dev
  config

Notas:
  - workflow-run y process-run son las superficies run principales
  - generate/job se mantienen como compatibilidad observable actual
  - modly.recipe.execute es experimental, opt-in y hidden by default.
  - Requiere MODLY_EXPERIMENTAL_RECIPE_EXECUTE.
`;

  assert.deepEqual(
    detectVisibleContractDrift({
      observableContract,
      commandGroups: EXPECTED_CLI_GROUPS,
      mcpToolIds: EXPECTED_DEFAULT_PUBLIC_TOOLS,
      helpText: alignedHelp,
    }),
    [],
  );
});

test('Batch 2 aligns the current visible contract sources with the observable contract', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  assert.deepEqual(
    detectVisibleContractDrift({
      observableContract,
      commandGroups: COMMAND_GROUPS,
      mcpToolIds: MCP_TOOL_IDS,
      helpText: renderHelp(),
    }),
    [],
  );
});

test('renderHelp describes workflow/process runs as primary and recipe execution as gated-only', () => {
  const helpText = renderHelp();

  assert.equal(helpText.includes('MCP real sigue diferido'), false);
  assert.equal(helpText.includes('workflow-run y process-run son las superficies run principales'), true);
  assert.equal(helpText.includes('generate/job se mantienen como compatibilidad observable actual'), true);
  assert.equal(
    helpText.includes('modly.capability.execute y modly.recipe.execute se presentan como wrappers de conveniencia/orquestación sobre workflow-run/process-run.'),
    true,
  );
  assert.equal(
    helpText.includes('modly.recipe.execute es experimental, opt-in y hidden by default mediante MODLY_EXPERIMENTAL_RECIPE_EXECUTE.'),
    true,
  );
  assert.equal(helpText.indexOf('process-run <subcomando>') < helpText.indexOf('generate <subcomando>'), true);
  assert.equal(helpText.indexOf('workflow-run <subcomando>') < helpText.indexOf('job <subcomando>'), true);
  assert.match(helpText, /ext-dev <subcomando>\s+bucket-detect \| preflight \| scaffold \| audit \| release-plan/u);
  assert.match(helpText, /ext-dev\s+Planner local plan-only visible en V1; \/health opcional solo con evidencia backend y bridge opcional solo para confirmación\/colisión\./u);
  assert.equal(helpText.includes('modly.ext-dev'), false);
});

test('MCP tool catalog uses taxonomy wording for canonical runs, wrappers, and legacy compatibility', () => {
  const workflowStatusTool = MCP_TOOL_CATALOG.find((tool) => tool.name === 'modly.workflowRun.status');
  const processStatusTool = MCP_TOOL_CATALOG.find((tool) => tool.name === 'modly.processRun.status');
  const capabilityExecuteTool = MCP_TOOL_CATALOG.find((tool) => tool.name === 'modly.capability.execute');
  const recipeExecuteTool = MCP_TOOL_CATALOG.find((tool) => tool.name === 'modly.recipe.execute');
  const jobStatusTool = MCP_TOOL_CATALOG.find((tool) => tool.name === 'modly.job.status');

  assert.match(workflowStatusTool.description, /canonical run primitive/u);
  assert.match(processStatusTool.description, /canonical run primitive/u);
  assert.match(capabilityExecuteTool.description, /orchestration wrapper/iu);
  assert.match(capabilityExecuteTool.description, /canonical recovery surface/iu);
  assert.match(recipeExecuteTool.description, /experimental orchestration wrapper/iu);
  assert.match(recipeExecuteTool.description, /validated workflow\/\* derived snapshot/iu);
  assert.doesNotMatch(recipeExecuteTool.description, /arbitrary DAG execution/iu);
  assert.match(jobStatusTool.description, /legacy compatibility surface/iu);
});

test('detectDocumentationContractDrift enumerates Batch 3 doc drift when stale docs are provided', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  const staleReadme = `# Modly CLI + MCP

- \`modly\`
- \`modly-mcp\`
- \`health\`
- \`workflow-run\`
- \`modly.health\`
`;

  const staleGlobalDoc = `# Global install

\`command\`: ["node", "src/mcp/server.mjs"]
`;

  const staleRepoLocalDoc = `# Repo local

Use any local script.
`;

  assert.deepEqual(
    detectDocumentationContractDrift({
      observableContract,
      readmeText: staleReadme,
      globalInstallDocText: staleGlobalDoc,
      repoLocalInstallDocText: staleRepoLocalDoc,
      globalTemplate: { mcp: { modly: { command: ['node', 'src/mcp/server.mjs'] } } },
    }),
    [
      {
        code: 'readme.cli-groups.missing',
        source: 'README.md',
        missing: ['capabilities', 'model', 'generate', 'job', 'process-run', 'mesh', 'ext', 'config'],
      },
      {
        code: 'readme.mcp-tool-ids.missing',
        source: 'README.md',
        missing: EXPECTED_DEFAULT_PUBLIC_TOOLS.filter((toolId) => toolId !== 'modly.health'),
      },
      {
        code: 'readme.install-modes.missing',
        source: 'README.md',
        missing: ['global-command', 'repo-local-wrapper', 'source-checkout-unsupported'],
      },
      {
        code: 'readme.execution-boundaries.missing',
        source: 'README.md',
        missing: ['workflow-process-primary', 'generate-job-compatibility'],
      },
      {
        code: 'readme.execution-taxonomy.missing',
        source: 'README.md',
        missing: ['canonical-run-primitive', 'orchestration-wrapper'],
      },
      {
        code: 'readme.recipe-gating.missing',
        source: 'README.md',
        missing: ['modly.recipe.execute', 'experimental', 'opt-in', 'hidden by default', 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE'],
      },
      {
        code: 'global-install.command-shape.mismatch',
        source: 'docs/install/global.md',
        actual: null,
        expected: ['modly-mcp'],
      },
      {
        code: 'global-install.runtime-notes.missing',
        source: 'docs/install/global.md',
        missing: ['MODLY_API_URL', 'MODLY_AUTOMATION_URL', 'MODLY_PROCESS_URL'],
      },
      {
        code: 'global-install.execution-taxonomy.missing',
        source: 'docs/install/global.md',
        missing: ['canonical-run-primitive', 'orchestration-wrapper', 'legacy-compatibility'],
      },
      {
        code: 'repo-local.wrapper-contract.missing',
        source: 'docs/install/repo-local.md',
        missing: ['tools/modly_mcp/run_server.mjs', '--check', 'tools/_tmp/modly_mcp/local.env', 'local-first-global-fallback'],
      },
      {
        code: 'repo-local.execution-taxonomy.missing',
        source: 'docs/install/repo-local.md',
        missing: ['canonical-run-primitive', 'orchestration-wrapper', 'legacy-compatibility'],
      },
      {
        code: 'repo-local.unsupported-source-checkout.missing',
        source: 'docs/install/repo-local.md',
      },
      {
        code: 'template.global-command.mismatch',
        source: 'templates/opencode/opencode.json',
        actual: ['node', 'src/mcp/server.mjs'],
        expected: ['modly-mcp'],
      },
    ],
  );
});

test('detectDocumentationContractDrift enumerates Batch 4 MVP spec drift when stale spec text is provided', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  const staleSpec = `# Modly CLI MVP Specification

## Scope

- \`health\`
- \`model\`

## Install

Use any checkout-based setup you want.
`;

  assert.deepEqual(
    detectDocumentationContractDrift({
      observableContract,
      readmeText: readText('README.md'),
      globalInstallDocText: readText('docs/install/global.md'),
      repoLocalInstallDocText: readText('docs/install/repo-local.md'),
      globalTemplate: readJson('templates/opencode/opencode.json'),
      mvpSpecText: staleSpec,
    }),
    [
      {
        code: 'mvp-spec.cli-groups.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: ['capabilities', 'generate', 'job', 'process-run', 'workflow-run', 'mesh', 'ext', 'config'],
      },
      {
        code: 'mvp-spec.bins.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: ['modly', 'modly-mcp'],
      },
      {
        code: 'mvp-spec.mcp-tool-ids.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: EXPECTED_DEFAULT_PUBLIC_TOOLS,
      },
      {
        code: 'mvp-spec.install-modes.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: ['global-command', 'repo-local-wrapper', 'source-checkout-unsupported'],
      },
      {
        code: 'mvp-spec.execution-boundaries.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: ['workflow-process-primary', 'generate-job-compatibility'],
      },
      {
        code: 'mvp-spec.execution-taxonomy.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: ['canonical-run-primitive', 'orchestration-wrapper'],
      },
      {
        code: 'mvp-spec.recipe-gating.missing',
        source: 'docs/specs/modly-cli-mvp.md',
        missing: ['modly.recipe.execute', 'experimental', 'opt-in', 'hidden by default', 'MODLY_EXPERIMENTAL_RECIPE_EXECUTE'],
      },
    ],
  );
});

test('Batch 3 aligns README, install docs, and visible templates with the observable contract', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  assert.deepEqual(
    detectDocumentationContractDrift({
      observableContract,
      readmeText: readText('README.md'),
      globalInstallDocText: readText('docs/install/global.md'),
      repoLocalInstallDocText: readText('docs/install/repo-local.md'),
      globalTemplate: readJson('templates/opencode/opencode.json'),
    }),
    [],
  );
});

test('Batch 4 aligns the MVP spec with the observable contract and prior doc contract', () => {
  const observableContract = buildObservableContract({
    packageJson: readJson('package.json'),
    cliIndexSource: readText('src/cli/index.mjs'),
    wrapperSource: readText('templates/opencode/run_server.mjs'),
    publicCatalog: createPublicCatalog({ catalog: MCP_TOOL_CATALOG }),
  });

  assert.deepEqual(
    detectDocumentationContractDrift({
      observableContract,
      readmeText: readText('README.md'),
      globalInstallDocText: readText('docs/install/global.md'),
      repoLocalInstallDocText: readText('docs/install/repo-local.md'),
      globalTemplate: readJson('templates/opencode/opencode.json'),
      mvpSpecText: readText('docs/specs/modly-cli-mvp.md'),
    }),
    [],
  );
});
