#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveRuntimeConfig } from '../core/config.mjs';
import { UsageError, normalizeError } from '../core/errors.mjs';
import { createToolRegistry } from './tools/index.mjs';

function toZodSchema(schema, path = 'inputSchema') {
  if (!schema || typeof schema !== 'object') {
    throw new TypeError(`Expected JSON schema object at ${path}.`);
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) {
      throw new TypeError(`Enum at ${path} cannot be empty.`);
    }

    if (!schema.enum.every((value) => typeof value === 'string')) {
      throw new TypeError(`Only string enums are supported at ${path}.`);
    }

    return z.enum(schema.enum);
  }

  switch (schema.type) {
    case 'object': {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(properties).map(([key, value]) => {
        const propertySchema = toZodSchema(value, `${path}.properties.${key}`);
        return [key, required.has(key) ? propertySchema : propertySchema.optional()];
      });

      return z.object(Object.fromEntries(entries)).passthrough();
    }

    case 'array':
      return z.array(toZodSchema(schema.items ?? {}, `${path}.items`));

    case 'string': {
      let stringSchema = z.string();

      if (schema.minLength !== undefined) {
        stringSchema = stringSchema.min(schema.minLength);
      }

      if (schema.maxLength !== undefined) {
        stringSchema = stringSchema.max(schema.maxLength);
      }

      return stringSchema;
    }

    case 'integer': {
      let numberSchema = z.number().int();

      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }

      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }

      return numberSchema;
    }

    case 'number': {
      let numberSchema = z.number();

      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }

      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }

      return numberSchema;
    }

    case 'boolean':
      return z.boolean();

    default:
      throw new TypeError(`Unsupported JSON schema type at ${path}: ${schema.type ?? 'undefined'}`);
  }
}

function createMcpServer({ registry }) {
  const server = new McpServer({
    name: 'modly-cli-mcp',
    version: '0.1.0',
  });

  for (const tool of registry.catalog) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toZodSchema(tool.inputSchema, `tool:${tool.name}`),
      },
      async (args = {}) => registry.invoke(tool.name, args),
    );
  }

  return server;
}

async function main(argv = process.argv.slice(2)) {
  const config = resolveRuntimeConfig({ argv });

  if (config.help || config.positionals.length > 0) {
    throw new UsageError('The MCP server runs only over stdio. Start it with the installable `modly-mcp` bin (or `node ./src/mcp/server.mjs` for local development) and connect with an MCP client.');
  }

  const registry = createToolRegistry({
    apiUrl: config.apiUrl,
    experimentalRecipeExecution: config.experimentalRecipeExecution,
  });
  const server = createMcpServer({ registry });
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await Promise.allSettled([server.close(), transport.close()]);
  };

  process.once('SIGINT', () => {
    shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  });

  await server.connect(transport);

  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const normalized = normalizeError(error);
  process.stderr.write(`[${normalized.code}] ${normalized.message}\n`);
  process.exitCode = normalized.exitCode ?? 1;
}
