# Repo-local installation for OpenCode

Use this guide when you want a consumer repository to control its own installation of `modly-cli-mcp`.

## Supported contract

The consumer repository should have:

- an `opencode.json`
- a local wrapper in `tools/modly_mcp/run_server.mjs`
- optionally `tools/_tmp/modly_mcp/local.env`

The wrapper resolves `node_modules/.bin/modly-mcp` in the consumer repository first and falls back to a global `modly-mcp` in `PATH` only if the local one is missing.

## Not supported

- pointing `opencode.json` to the source checkout of `modly_CLI_MCP`
- executing `node /path/to/checkout/src/mcp/server.mjs` from the consumer repository
- depending on OpenCode `cwd` to discover binaries or configuration files

## 1) Install the package in the consumer repository

Example with npm:

```bash
npm install -D modly-cli-mcp
```

If your internal distribution uses a tarball, install that `.tgz` instead of the registry package name.

## 2) Copy the canonical wrapper

Copy this file from the package into your consumer repository:

- source: [`templates/opencode/run_server.mjs`](../../templates/opencode/run_server.mjs)
- destination: `tools/modly_mcp/run_server.mjs`

The script computes the repository root from `import.meta.url`, **not** from `cwd`.

## 3) Create `opencode.json`

Configure OpenCode to invoke the local wrapper:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modly": {
      "type": "local",
      "enabled": true,
      "timeout": 30000,
      "command": [
        "node",
        "tools/modly_mcp/run_server.mjs"
      ]
    }
  }
}
```

That `opencode.json` lives in the consumer repository. It must **not** reference files inside the source checkout of `modly_CLI_MCP`.

## 4) Optional local configuration

If the consumer repository needs local-only variables, create this optional file:

```text
tools/_tmp/modly_mcp/local.env
```

Minimum supported format:

```dotenv
# comments and blank lines are ignored
MODLY_API_URL=http://127.0.0.1:8765
```

Important notes:

- The wrapper uses a minimal built-in parser; it does **not** use `dotenv`.
- It only accepts `KEY=VALUE` lines.
- It merges those variables over `process.env` only for the child process.
- The file is optional and local to the consumer repository.

## 5) Verify resolution without starting MCP

```bash
node tools/modly_mcp/run_server.mjs --check
```

`--check` only validates resolution/configuration and reports whether it would use `local` or `global` mode. It does **not** call `/health`, start the MCP server, install anything, or mutate files.

## Runtime notes

- FastAPI-backed surfaces use `MODLY_API_URL` (default `http://127.0.0.1:8765`).
- capabilities and process-runs use the Electron automation bridge on `:8766`.
- The installed package derives those bridge URLs automatically unless you override them explicitly.

## When to choose global vs repo-local

- **Global**: simpler if one environment uses a single installed version in `PATH`.
- **Repo-local**: better when each repository needs to pin its own package version.

If you want the global flow, use [`docs/install/global.md`](./global.md).
