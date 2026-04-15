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
- capabilities discovery (`modly capabilities`, `modly.capabilities.get`)
- read-only capability planning (`modly.capability.plan`)

### Executable surfaces

- `workflow-run from-image`
- `workflow-run status`
- `workflow-run cancel`
- `workflow-run wait`
- `process-run create`
- `process-run status`
- `process-run cancel`
- `process-run wait`
- MCP tools:
  - `modly.workflowRun.createFromImage`
  - `modly.workflowRun.status`
  - `modly.workflowRun.cancel`
  - `modly.workflowRun.wait`
  - `modly.processRun.create`
  - `modly.processRun.status`
  - `modly.processRun.cancel`
  - `modly.processRun.wait`
  - `modly.capability.execute`

## Explicitly out of scope

This repository does **not** pretend to support:

- workflow management (`workflow_id`, list/save/import/export)
- Electron IPC automation
- real **Add to Scene** execution
- generic DAG workflow orchestration
- automatic wait during `workflow-run from-image`
- automatic multi-step chaining inside `modly.capability.execute`

`workflow-run wait` / `modly.workflowRun.wait` only wait on an already-created `workflow run` via the existing status surface. They do **not** imply workflow management, **Add to Scene**, or blocking `from-image` behavior.

`modly.capability.execute` is intentionally transparent and conservative. In the current cut it can execute:

- image → mesh via `workflowRun.createFromImage`
- mesh → mesh via `processRun.create` only for `mesh-optimizer/optimize`

It does **not** execute unknown capabilities, UI-only nodes, `UniRig`, or generic process chains.

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

Runtime note:

- FastAPI-backed surfaces use `MODLY_API_URL` (default `http://127.0.0.1:8765`)
- capabilities and process-runs use the Electron automation bridge on `:8766`
- by default the client derives those bridge URLs from `MODLY_API_URL`
- you may override them explicitly with `MODLY_AUTOMATION_URL` and `MODLY_PROCESS_URL`

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

## Wait capability boundaries

- `workflow-run wait <run-id>` waits for `done`, `error`, or `cancelled` on an existing run.
- `modly.workflowRun.wait({ runId, intervalMs?, timeoutMs? })` exposes the same capability over MCP.
- Both surfaces rely on the existing workflow-run status endpoint plus the required `GET /health` readiness check before business operations.
- This does **not** add workflow CRUD/management, real scene mutation, or `--wait` support to `workflow-run from-image`.

## Recommended long-running pattern

- For agents, prefer `create -> status -> status -> ...` instead of blocking on `wait`.
- MCP long-running tools keep `data.run` intact and add recovery hints in `data.meta` only.
- `modly.workflowRun.{createFromImage,status,wait}` and `modly.processRun.{create,status,wait}` expose `data.meta.operation`, `data.meta.operationState`, `data.meta.nextAction`, and non-terminal `data.meta.suggestedPollIntervalMs`.
- `workflow-run status` / `modly.workflowRun.status` expose `data.meta.terminal` so polling clients can stop without mutating `data.run`.
- `workflow-run wait` / `modly.workflowRun.wait` remain available as a bounded convenience wrapper over status polling; use short timeout windows when you cannot drive polling yourself.
- `data.meta.nextAction` always points back to the canonical status tool with the same `runId`; recovery MUST resume polling an existing run, not recreate it.
- Wait timeouts include bounded polling diagnostics in `error.details` (`timeoutMs`, `intervalMs`, `elapsedMs`, `attempts`, `lastObservedRun`).

## Architectural notes

- `src/core/modly-api.mjs` is the single HTTP source of truth for CLI and MCP.
- `src/core/modly-normalizers.mjs` keeps payload shapes stable across layers.
- `src/core/smart-capability-registry.mjs` and `src/core/smart-capability-planner.mjs` hold the read-only capability planner used by `modly.capability.plan` and `modly.capability.execute`.
- `src/mcp/*` stays intentionally small and reuses the same core logic instead of shelling out to the CLI.
- The CLI groups are named **`workflow-run`** and **`process-run`** on purpose, to avoid implying full workflow management.

## Status

This repository is now beyond a read-only MCP.

It already supports a practical execution path for:

`image -> workflow run create -> status -> status -> ...`

against the backend `workflow-runs` surface implemented in Modly.

`wait` is still supported for compatibility, but the preferred automation shape is polling-first with explicit `status` checks.
