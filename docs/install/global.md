# Global installation for OpenCode

Use this guide when you want OpenCode to invoke `modly-mcp` directly from `PATH`.

## Supported contract

- `modly` and `modly-mcp` installed as package binaries from `modly-cli-mcp`
- an `opencode.json` that invokes `modly-mcp` directly

## Not supported

- pointing OpenCode at the source checkout of `modly_CLI_MCP`
- configuring commands such as `node /path/to/checkout/src/mcp/server.mjs`
- inventing additional headless support outside the real package binaries

## Install the package

Install it globally from your valid distribution channel for this package (for example a private registry or a `.tgz` artifact). The package name is `modly-cli-mcp`, and the published binaries are `modly` and `modly-mcp`.

Example with npm:

```bash
npm install -g modly-cli-mcp
```

If your team distributes a tarball, use the corresponding `.tgz` file instead of the registry package name.

## Verify installed binaries

```bash
modly --help
modly-mcp --help
```

## Verify the backend before business operations

Before running business operations from CLI/MCP, verify that FastAPI responds on `GET /health`. Do not assume readiness.

Example:

```bash
modly health --json --api-url http://127.0.0.1:8765
```

## Canonical `opencode.json`

Copy the canonical template or replicate this content:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modly": {
      "type": "local",
      "enabled": true,
      "timeout": 30000,
      "command": ["modly-mcp"]
    }
  }
}
```

Template shipped in this package:

- [`templates/opencode/opencode.json`](../../templates/opencode/opencode.json)

## Runtime notes

- Execution surface taxonomy:
  - `workflow-run` / `process-run` and `modly.workflowRun.*` / `modly.processRun.*` are the visible **canonical run primitive** surfaces.
  - `modly.capability.execute` and `modly.recipe.execute` are **orchestration wrapper** surfaces over those run primitives; recovery/polling stays on the canonical run status surfaces.
  - `generate` / `job` and `modly.job.status` remain **legacy compatibility** surfaces.
- `modly-mcp` is the supported MCP stdio binary.
- OpenCode uses the top-level `mcp` key, **not** `mcpServers`.
- `command` must be a JSON array, even when it contains only one binary.
- FastAPI-backed surfaces use `MODLY_API_URL` (default `http://127.0.0.1:8765`).
- capabilities and process-runs use the Electron automation bridge on `:8766`.
- By default the installed package derives those bridge URLs from `MODLY_API_URL`.
- Override bridge endpoints only when needed with `MODLY_AUTOMATION_URL` and `MODLY_PROCESS_URL`.
- `modly.recipe.execute` is experimental, opt-in, hidden by default, and disabled unless you set `MODLY_EXPERIMENTAL_RECIPE_EXECUTE=1` before starting `modly-mcp`.
- Without `MODLY_EXPERIMENTAL_RECIPE_EXECUTE`, the recipe tool is not advertised in the MCP catalog.
- If you need additional system configuration, resolve it in the environment where the global binary lives.
- Consumer repositories must **not** point to the source checkout of `modly_CLI_MCP`; they should use an installed package available in `PATH`.
- If you want each repository to control its own installation, use the repo-local guide in [`docs/install/repo-local.md`](./repo-local.md).

Example opt-in:

```bash
MODLY_EXPERIMENTAL_RECIPE_EXECUTE=1 modly-mcp
```
