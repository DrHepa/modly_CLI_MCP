# Global installation for Codex

Use this guide when you want Codex to invoke `modly-mcp` globally from `PATH`.

## Supported contract

- `modly` and `modly-mcp` installed as package binaries from `modly-cli-mcp`
- either:
  - a `~/.codex/config.toml` entry that invokes `modly-mcp`, or
  - the equivalent `codex mcp add modly -- modly-mcp` setup

## Not supported

- pointing Codex at the source checkout of `modly_CLI_MCP`
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

## Configure Codex

### Option A: add the server with the Codex CLI

```bash
codex mcp add modly -- modly-mcp
```

### Option B: edit `~/.codex/config.toml`

Copy the canonical template or replicate this content:

```toml
[mcp_servers.modly]
command = "modly-mcp"
```

Template shipped in this package:

- [`templates/codex/global.config.toml`](../../templates/codex/global.config.toml)

### Optional environment overrides

If you need local environment overrides for the Codex-launched server, add them under `[mcp_servers.modly.env]` in `~/.codex/config.toml`:

```toml
[mcp_servers.modly]
command = "modly-mcp"

[mcp_servers.modly.env]
MODLY_API_URL = "http://127.0.0.1:8765"
# MODLY_AUTOMATION_URL = "http://127.0.0.1:8766"
# MODLY_PROCESS_URL = "http://127.0.0.1:8766"
# MODLY_EXPERIMENTAL_RECIPE_EXECUTE = "1"
```

## Runtime notes

- Execution surface taxonomy:
  - `workflow-run` / `process-run` and `modly.workflowRun.*` / `modly.processRun.*` are the visible **canonical run primitive** surfaces.
  - `modly.capability.execute` and `modly.recipe.execute` are **orchestration wrapper** surfaces over those run primitives; recovery/polling stays on the canonical run status surfaces.
  - `generate` / `job` and `modly.job.status` remain **legacy compatibility** surfaces.
- `modly-mcp` is the supported MCP stdio binary.
- Codex stores global user-level MCP configuration in `~/.codex/config.toml`.
- FastAPI-backed surfaces use `MODLY_API_URL` (default `http://127.0.0.1:8765`).
- capabilities and process-runs use the Electron automation bridge on `:8766`.
- By default the installed package derives those bridge URLs from `MODLY_API_URL`.
- Override bridge endpoints only when needed with `MODLY_AUTOMATION_URL` and `MODLY_PROCESS_URL`.
- `modly.recipe.execute` is experimental, opt-in, hidden by default, and disabled unless the Codex-launched server environment sets `MODLY_EXPERIMENTAL_RECIPE_EXECUTE=1`.
- Without `MODLY_EXPERIMENTAL_RECIPE_EXECUTE`, the recipe tool is not advertised in the MCP catalog.
- Consumer repositories and user configs must **not** point Codex at the source checkout of `modly_CLI_MCP`; they should use an installed package available in `PATH`.
- If you want each repository to control its own installation, use the repo-local guide in [`docs/install/codex-repo-local.md`](./codex-repo-local.md).
