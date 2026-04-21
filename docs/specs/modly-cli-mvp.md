# Modly CLI MVP Specification

## Status

Current observable contract.

## Goal

Describe the Modly CLI + MCP package exactly as it exists today, without inventing future orchestration, workflow CRUD, scene mutation, or unsupported installation paths.

## Scope

This spec covers the visible contract exposed by the shipped package binaries, the CLI help, the default public MCP catalog, and the supported installable integration modes for OpenCode and Codex.

## Installable binaries

- `modly`
- `modly-mcp`

## CLI groups in the public contract

- `capabilities`
- `health`
- `model`
- `generate`
- `job`
- `process-run`
- `workflow-run`
- `mesh`
- `ext`
- `ext-dev`
- `config`

These groups are the current observable top-level CLI contract. The CLI help is the canonical human-facing reference for their currently supported subcommands.

`ext` is the runtime-oriented extension surface.
`ext-dev` is the V1 plan-only extension development surface.

## Operational reality of extension installs

The observable contract for extension work must stay aligned with what real external-extension trials demonstrated:

- `modly ext stage github` is **preflight only**. It stages and inspects source material from GitHub, but does **not** install it and does **not** make the extension operational by itself.
- `modly ext apply` is the real install seam against a live target. It applies a **prepared** stage into the live extensions directory and may trigger live-target setup when the staged contract requires it.
- If that live-target setup fails after the apply seam already copied the staged extension, the terminal result may legitimately be `applied_degraded`.
- `modly ext repair` is reapply against an already prepared stage. It may trigger live-target setup, accepts the same relevant setup flags as `apply`, and currently defaults to backup mode `never` for the reapply path.
- `modly ext setup` runs an explicit, limited setup contract for a prepared stage. It is **not** a universal install manager and some extensions require explicit payload inputs such as `gpu_sm`.
- If a third-party `setup.py` ignores `PIP_*` variables or performs its own network/download logic, CLI-side resilience may be partial or absent.
- `modly ext setup-status` is a live-target observer only. `--wait` and `--follow` are local observation loops, `--timeout-ms` stops the observer rather than the setup process, and there is no general cancel/reattach/job-manager contract.
- Real ecosystem failures often come from the extension itself rather than the seam: broken `setup.py`, missing wheels, ABI issues, or Linux ARM64 incompatibilities.
- The CLI/MCP contract may diagnose seam failure vs extension failure reasonably well, but it does **not** promise universal compatibility and cannot repair a missing wheel by itself.

## `ext-dev` planning contract (V1)

`modly ext-dev` provides local, plan-only analysis for extension workspaces. It does **not** install, build, release, or repair, and it never claims Electron-only runtime behavior is available headlessly.

### Command purpose

- `bucket-detect` classifies the workspace and returns planning metadata
- `preflight` validates workspace boundaries and may attach FastAPI readiness evidence after `GET /health`
- `scaffold` emits a non-executing implementation plan
- `audit` reports gaps, risks, and optional bridge confirmation/collision evidence
- `release-plan` emits an ordered release checklist without publishing anything

### Scope and bucket heuristics

- V1 supports `manifest.json` only
- `model-simple` when the manifest has neither `setup` nor `process`
- `model-managed-setup` when the manifest declares `setup`
- `process-extension` when the manifest declares `process`

### Mandatory metadata

Every `ext-dev` plan returns:

- `resolution`
- `implementation_profile`
- `setup_contract`
- `support_state`
- `surface_owner`
- `headless_eligible`
- `linux_arm64_risk`

### Boundary limits

- FastAPI evidence is optional and bounded by readiness checks before backend-backed business operations
- Electron owns setup, workflow, install/repair, and other live extension operations
- bridge confirmation is optional and only confirms/collides with live identity; it does not replace planned identity
- V1 remains plan-only even when FastAPI or bridge evidence is available

### Linux ARM64 and heavy dependency reality

- Some third-party extensions on Linux ARM64 may require CPU fallbacks, ABI-specific packaging fixes, or extension-side patches.
- The CLI/MCP layer can improve staging, observation, and diagnostics around those failures.
- The CLI/MCP layer cannot create missing wheels, override broken upstream packaging, or guarantee GPU-path success for every external extension.

## Default public MCP catalog

- `modly.capabilities.get`
- `modly.capability.plan`
- `modly.capability.guide`
- `modly.diagnostic.guidance`
- `modly.capability.execute`
- `modly.health`
- `modly.model.list`
- `modly.model.current`
- `modly.model.params`
- `modly.ext.errors`
- `modly.config.paths.get`
- `modly.job.status`
- `modly.workflowRun.createFromImage`
- `modly.workflowRun.status`
- `modly.workflowRun.cancel`
- `modly.workflowRun.wait`
- `modly.processRun.create`
- `modly.processRun.status`
- `modly.processRun.wait`
- `modly.processRun.cancel`

The default public MCP catalog is intentionally smaller than the full CLI surface. In particular, the default catalog does **not** advertise hidden tools, workflow CRUD, scene mutation, or automatic multi-step chaining.

## Execution boundaries

### Read-only and discovery surfaces

- `modly health`
- `modly capabilities`
- `modly model list`
- `modly model current`
- `modly model params`
- `modly ext errors`
- `modly config paths get`
- `modly job status`
- `modly.capabilities.get`
- `modly.capability.plan`
- `modly.capability.guide`
- `modly.diagnostic.guidance`
- `modly.health`
- `modly.model.list`
- `modly.model.current`
- `modly.model.params`
- `modly.ext.errors`
- `modly.config.paths.get`
- `modly.job.status`

### Executable run surfaces

- `modly workflow-run from-image`
- `modly workflow-run status`
- `modly workflow-run cancel`
- `modly workflow-run wait`
- `modly process-run create`
- `modly process-run status`
- `modly process-run cancel`
- `modly process-run wait`
- `modly.capability.execute`
- `modly.workflowRun.createFromImage`
- `modly.workflowRun.status`
- `modly.workflowRun.cancel`
- `modly.workflowRun.wait`
- `modly.processRun.create`
- `modly.processRun.status`
- `modly.processRun.cancel`
- `modly.processRun.wait`

`workflow-run` / `process-run` are the primary run surfaces.

### Execution surface taxonomy

- `workflow-run` / `process-run` and `modly.workflowRun.*` / `modly.processRun.*` are the visible **canonical run primitive** surfaces.
- `modly.capability.execute` is an **orchestration wrapper** over those run primitives; recovery/polling remains on the canonical run status surfaces.
- `modly.recipe.execute` is an experimental **orchestration wrapper** over the same run primitives and stays opt-in/hidden by default.
- `generate` / `job` and `modly.job.status` remain visible **legacy compatibility** surfaces.

`generate` / `job` remain observable compatibility surfaces.

`wait` remains a bounded convenience wrapper over status polling. Polling-first agents should prefer create/status loops over long blocking waits.

### Explicit contract limits

This MVP does **not** add or imply:

- workflow management (`workflow_id`, list/save/import/export/delete)
- generic DAG orchestration
- automatic multi-step chaining beyond the existing bounded capability wrappers
- real scene mutation or **Add to Scene** execution
- hidden support for Electron-only actions
- unsupported install modes such as a source checkout integration

`scene_candidate` is descriptive output only, not a scene mutation.

## Supported installable integration modes

There are exactly two supported installable integration modes:

1. global installed binary
2. repo-local wrapper

Those modes are supported for these clients:

- OpenCode
- Codex

Pointing OpenCode or Codex at the source checkout of this repository is unsupported. Any source checkout or checkout fuente invocation such as `node /path/to/checkout/src/mcp/server.mjs` is outside the contract.

### OpenCode global installed binary

Canonical shape:

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

Runtime notes:

- FastAPI-backed surfaces use `MODLY_API_URL` (default `http://127.0.0.1:8765`)
- capabilities and process-runs derive bridge endpoints from `MODLY_API_URL` unless overridden with `MODLY_AUTOMATION_URL` and `MODLY_PROCESS_URL`

### OpenCode repo-local wrapper

Canonical wrapper path: `tools/modly_mcp/run_server.mjs`

Repo-local checks and boundaries:

- `node tools/modly_mcp/run_server.mjs --check` validates wrapper resolution without starting MCP
- resolution order is local-first with global-fallback
- optional local environment file: `tools/_tmp/modly_mcp/local.env`
- the wrapper contract is for consumer repositories, not direct source checkout execution

### Codex global installed binary

Global Codex configuration lives in `~/.codex/config.toml`.

Canonical shape:

```toml
[mcp_servers.modly]
command = "modly-mcp"
```

The equivalent CLI flow is `codex mcp add modly -- modly-mcp`.

### Codex repo-local wrapper

Repo-local Codex configuration lives in `.codex/config.toml`.

Canonical shape:

```toml
[mcp_servers.modly]
command = "node"
args = ["tools/modly_mcp/run_server.mjs"]
```

Repo-local Codex configuration is loaded only in a trusted project.

## Experimental recipe surface

`modly.recipe.execute` is experimental, opt-in, and hidden by default.

It is disabled unless `MODLY_EXPERIMENTAL_RECIPE_EXECUTE` is set.

Without that flag, `modly.recipe.execute` is absent from the default public MCP catalog.

When enabled, it remains intentionally constrained:

- recipes v1 only: `image_to_mesh`, `image_to_mesh_optimized`, `image_to_mesh_exported`
- polling-first resume model via `options.resume`
- `maxNewRunsPerCall=1`
- exporter support remains `default_output_only`
- no free-form goals, no branching, no hidden waits, no workflow CRUD

## Observable source anchors

This document must stay aligned with these observable sources:

- `package.json` for package binaries
- `src/cli/index.mjs` and `src/cli/help.mjs` for CLI groups and help wording
- `src/core/contracts.mjs` for visible contract constants
- `src/mcp/tools/catalog.mjs` plus gating in `src/mcp/tools/internal/registry-gating.mjs` for the public MCP catalog
- `templates/opencode/opencode.json` and `templates/opencode/run_server.mjs` for supported OpenCode integration shapes
- `templates/codex/global.config.toml` and `templates/codex/repo-local.config.toml` for supported Codex integration shapes

If those observable sources change, this spec must follow the shipped truth instead of documenting an aspirational future.
