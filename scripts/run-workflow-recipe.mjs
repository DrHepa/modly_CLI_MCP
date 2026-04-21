#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    recipe: null,
    imagePath: null,
    modelId: null,
    iterations: 120,
    pollCapMs: 2000,
    catalogDir: process.env.MODLY_RECIPE_WORKFLOW_CATALOG_DIR ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--recipe') {
      args.recipe = next;
      index += 1;
      continue;
    }

    if (token === '--image-path') {
      args.imagePath = next;
      index += 1;
      continue;
    }

    if (token === '--model-id') {
      args.modelId = next;
      index += 1;
      continue;
    }

    if (token === '--catalog-dir') {
      args.catalogDir = next;
      index += 1;
      continue;
    }

    if (token === '--iterations') {
      args.iterations = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === '--poll-cap-ms') {
      args.pollCapMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === '--help' || token === '-h') {
      console.log(`Usage:
  node scripts/run-workflow-recipe.mjs \
    --recipe workflow/<slug> \
    --image-path /abs/path/to/image.png \
    --model-id <canonical-model-id> \
    [--catalog-dir /abs/path/to/workflows] \
    [--iterations 120] \
    [--poll-cap-ms 2000]

Notes:
  - Usa exactamente el resume devuelto por modly.recipe.execute.
  - Requiere MODLY_EXPERIMENTAL_RECIPE_EXECUTE=true.
  - Si no pasas --catalog-dir, usa MODLY_RECIPE_WORKFLOW_CATALOG_DIR del entorno.
`);
      process.exit(0);
    }

    fail(`Unknown option: ${token}`);
  }

  if (!args.recipe || !args.imagePath || !args.modelId) {
    fail('Missing required flags. Use --help for usage.');
  }

  if (!args.catalogDir) {
    fail('Missing workflow catalog dir. Pass --catalog-dir or set MODLY_RECIPE_WORKFLOW_CATALOG_DIR.');
  }

  return args;
}

function summarizeResult(result) {
  const structured = result?.structuredContent;
  const data = structured?.data;

  if (!data) {
    return {
      isError: true,
      raw: structured ?? null,
    };
  }

  return {
    isError: Boolean(result?.isError),
    recipe: data.recipe,
    status: data.status,
    steps: Array.isArray(data.steps)
      ? data.steps.map((step) => ({
          id: step.id,
          status: step.status,
          run: step.run ?? null,
          error: step.error ?? null,
        }))
      : null,
    runIds: data.runIds ?? null,
    outputs: data.outputs ?? null,
    nextAction: data.nextAction ?? null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = parseArgs(process.argv.slice(2));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./src/mcp/server.mjs'],
  cwd: process.cwd(),
  stderr: 'pipe',
  env: {
    ...process.env,
    MODLY_EXPERIMENTAL_RECIPE_EXECUTE: 'true',
    MODLY_RECIPE_WORKFLOW_CATALOG_DIR: args.catalogDir,
  },
});

const client = new Client({ name: 'workflow-recipe-runner', version: '0.1.0' });

try {
  await client.connect(transport);

  let resume;
  const trace = [];
  let final = null;

  for (let i = 0; i < args.iterations; i += 1) {
    const request = {
      recipe: args.recipe,
      input: {
        imagePath: args.imagePath,
        modelId: args.modelId,
      },
    };

    if (resume) {
      request.options = { resume };
    }

    const result = await client.callTool({
      name: 'modly.recipe.execute',
      arguments: request,
    });

    const summary = summarizeResult(result);
    trace.push({ iteration: i + 1, summary });

    if (summary.isError || ['succeeded', 'failed', 'partial_failed'].includes(summary.status)) {
      final = { terminal: true, result: summary };
      break;
    }

    const next = summary.nextAction;

    if (!next?.input?.options?.resume) {
      final = { terminal: false, reason: 'missing_resume', result: summary };
      break;
    }

    resume = next.input.options.resume;
    const interval = next.poll?.intervalMs ?? 1000;
    await sleep(Math.min(interval, args.pollCapMs));
  }

  if (!final) {
    final = {
      terminal: false,
      reason: 'max_iterations_reached',
      result: trace.at(-1)?.summary ?? null,
    };
  }

  console.log(JSON.stringify({
    recipeId: args.recipe,
    modelId: args.modelId,
    trace,
    final,
  }, null, 2));
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
