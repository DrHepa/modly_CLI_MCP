# Modly CLI + MCP

External headless tooling for **Modly**.

This repository keeps the operational automation layer **outside** the upstream Modly desktop app so CLI, MCP, OpenCode integration, and packaging concerns do not pollute the product repository.

## What this package provides

- **`modly`** — installable headless CLI
- **`modly-mcp`** — installable MCP server over stdio
- **`src/core/*`** — shared HTTP client, contracts, normalizers, and error handling used by both CLI and MCP

## Current capabilities

### Read-only surfaces

- backend health
- model listing / current model / model params
- extension errors
- runtime paths
- job status

### Executable surfaces

- `workflow-run from-image`
- `workflow-run status`
- `workflow-run cancel`
- MCP tools:
  - `modly.workflowRun.createFromImage`
  - `modly.workflowRun.status`
  - `modly.workflowRun.cancel`

## Explicitly out of scope

This repository does **not** pretend to support:

- workflow management (`workflow_id`, list/save/import/export)
- Electron IPC automation
- real **Add to Scene** execution
- generic DAG workflow orchestration
- a `wait` operation for workflow-runs in the current MVP

`scene_candidate` is treated as **descriptive output only**, not as a scene mutation.

## Repository structure

```text
.
├── docs/
│   ├── install/
│   └── specs/
├── skills/
│   └── modly-operator/
├── src/
│   ├── cli/
│   ├── core/
│   └── mcp/
├── templates/
│   └── opencode/
└── test/
    ├── cli/
    ├── core/
    ├── mcp/
    └── packaging/
```

## Development commands

These commands are for **developing this source repository**, not for consumer-project integration.

```bash
node src/cli/index.mjs --help
node src/mcp/server.mjs --help
node --test test/core/modly-api.test.mjs test/cli/workflow-run.test.mjs test/mcp/*.test.mjs
```

## Installable usage

The installable contract of this package exposes two real binaries:

- `modly`
- `modly-mcp`

Consumer repositories should use those installed binaries directly, or the documented repo-local wrapper.

They should **not** point OpenCode at the source checkout of this repository as a supported integration model.

## OpenCode integration

The verified OpenCode config shape is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modly": {
      "type": "local",
      "enabled": true,
      "timeout": 30000,
      "command": ["..."]
    }
  }
}
```

### Global installation

See:

- [`docs/install/global.md`](docs/install/global.md)

### Repo-local installation

See:

- [`docs/install/repo-local.md`](docs/install/repo-local.md)
- [`templates/opencode/opencode.json`](templates/opencode/opencode.json)
- [`templates/opencode/run_server.mjs`](templates/opencode/run_server.mjs)

## Architectural notes

- `src/core/modly-api.mjs` is the single HTTP source of truth for CLI and MCP.
- `src/core/modly-normalizers.mjs` keeps payload shapes stable across layers.
- `src/mcp/*` stays intentionally small and reuses the same core logic instead of shelling out to the CLI.
- The CLI group is named **`workflow-run`** on purpose, to avoid implying full workflow management.

## Status

This repository is now beyond a read-only MCP.

It already supports a practical execution path for:

`image -> workflow run create -> status -> cancel`

against the backend `workflow-runs` surface implemented in Modly.
