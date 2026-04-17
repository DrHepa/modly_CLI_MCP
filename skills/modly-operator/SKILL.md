---
name: modly-operator
description: >
  Operates Modly correctly in headless or assisted modes by respecting its real
  architecture boundaries: FastAPI for models, generation, jobs, and mesh ops;
  Electron IPC for setup, GitHub extension install/repair, logs, workflows, and
  app-level orchestration.
  Trigger: When the AI must use Modly, design or use a Modly CLI, integrate
  Modly with MCP/OpenCode, or operate Modly models, generation, jobs,
  extensions, or workflows.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

Use this skill when the user asks to:

- use Modly headlessly
- generate a 3D mesh/model with Modly
- inspect or operate Modly's FastAPI
- design or use a Modly CLI
- integrate Modly with MCP/OpenCode
- manage Modly models, jobs, exports, or extensions
- understand what is API-backed vs Electron/IPC-backed in Modly

## Critical Patterns

1. **Verify backend readiness first**
   - Always check `GET /health` before calling business endpoints.
   - If the backend is unavailable, say so clearly. Do NOT guess.

2. **Exception: capabilities discovery is intentionally partial**
   - `GET /automation/capabilities` can still be useful when `backend_ready=false`.
   - Do NOT preflight `/health` separately before capabilities discovery.
   - Treat partial discovery as useful information, not as a hard failure.

3. **Respect the architecture boundary**
   - **FastAPI owns**: model status/list/params/switch/unload, model file download via HF SSE, workflow-runs, job polling, and legacy runtime path APIs.
   - **Electron bridge owns**: capabilities discovery and process-runs.
   - **Electron IPC/UI owns**: setup, logs, GitHub extension install/repair/uninstall, workflow editing, native dialogs, app orchestration, and workspace UI metadata.

4. **Never invent headless support**
   - If an operation currently exists only in Electron IPC, do NOT present it as available through FastAPI or CLI MVP.
   - Examples: `extensions:installFromGitHub`, `extensions:repair`, `log:readAll`, `workflows:*`, `setup:*`.

5. **Use canonical IDs**
   - Model IDs come from `/model/all`.
   - Process IDs come from `/automation/capabilities` as `{extension_id}/{node_id}`.
   - Treat them as canonical API inputs.
   - Do NOT fabricate IDs from labels.

6. **Treat workspace paths as a contract**
   - Mesh operations use workspace-relative paths such as `Default/chair.glb`.
   - Validate paths before sending them.
   - Never allow traversal-like inputs.

7. **Prefer machine-readable output**
   - For automation, prefer JSON.
   - For human output, keep summaries short and factual.

8. **Handle long-running operations correctly**
   - Prefer `create -> status -> status -> ...` for agents.
   - Treat `wait` as a bounded convenience helper, not as the primary orchestration primitive.
   - Preserve `run` payloads and use `meta.operationState`, `meta.nextAction`, and polling metadata for recovery.

9. **Use planner-gated execution for known capabilities**
   - Use `modly.capability.plan` to inspect what is really supported.
   - `modly.capability.execute` must only execute when the planner result is `supported`.
   - If the planner says `known_but_unavailable` or `unknown`, stop and explain; do not execute optimistically.

10. **Be honest about persistence**
    - FastAPI `settings/paths` updates runtime registry paths only.
    - It does not persist Electron desktop settings.

11. **Treat recipe execution as experimental**
    - `modly.recipe.execute` is experimental, opt-in, hidden by default, and disabled unless `MODLY_EXPERIMENTAL_RECIPE_EXECUTE` is set.
    - Do NOT assume recipe execution is available in the public MCP catalog.
    - When guiding operators, name `MODLY_EXPERIMENTAL_RECIPE_EXECUTE` exactly; do not invent alternate flags.

## Allowed

- Check backend health
- List models and inspect active model status
- Inspect model parameter schema
- Switch active model
- Unload all loaded models
- Download model files through the HF download endpoint
- Generate from image
- Poll or cancel jobs
- Create / poll / cancel workflow-runs
- Create / poll / cancel process-runs
- Discover capabilities
- Plan capabilities
- Execute supported capabilities transparently
- Optimize or smooth workspace meshes
- Export meshes
- Reload extension registry
- Inspect extension load errors
- Read runtime backend paths
- Update runtime backend paths

## Forbidden

- Claiming GitHub extension install works through FastAPI
- Claiming full workflow management exists in the CLI/MCP MVP
- Claiming desktop setup/logs are headless today
- Performing unsafe arbitrary filesystem mutation
- Pretending native dialogs exist in CLI/MCP flows
- Treating every discovered capability as executable
- Hiding planner decisions or backend rejections from the user
- Treating runtime path updates as persistent app configuration

## Operating Guide

### Health
- `GET /health`

### Models
- `GET /model/status`
- `GET /model/all`
- `GET /model/params?model_id=<id>`
- `POST /model/switch?model_id=<id>`
- `POST /model/unload-all`
- `GET /model/hf-download?repo_id=<hf-repo>&model_id=<model-id>&skip_prefixes=<json-list>`

### Generation
- `POST /generate/from-image` (multipart form)
- `GET /generate/status/{job_id}`
- `POST /generate/cancel/{job_id}`

### Workflow runs
- `POST /workflow-runs/from-image`
- `GET /workflow-runs/{run_id}`
- `POST /workflow-runs/{run_id}/cancel`

### Capabilities discovery
- `GET http://127.0.0.1:8766/automation/capabilities`

### Process runs
- `POST http://127.0.0.1:8766/process-runs`
- `GET http://127.0.0.1:8766/process-runs/{run_id}`
- `POST http://127.0.0.1:8766/process-runs/{run_id}/cancel`

### Mesh operations
- `POST /optimize/mesh`
- `POST /optimize/smooth`
- `GET /export/{fmt}?path=<workspace-relative-path>`

### Extensions
- `POST /extensions/reload`
- `GET /extensions/errors`

### Runtime paths
- `GET /settings/paths`
- `POST /settings/paths`

## Decision Rules

If the requested operation touches any of these, assume it is **Electron/IPC-bound or UI-only** unless the repo has been explicitly refactored:

- setup
- logs
- workflows
- GitHub extension install/repair/uninstall
- native dialogs
- workspace UI metadata
- app updater/window controls

If the requested operation is about capabilities discovery or process-runs, prefer the **Electron bridge**.

If the requested operation is about workflow-runs, model status, or legacy model APIs, prefer **FastAPI**.

If the requested operation is about selecting what to execute, prefer:

1. `capabilities.get`
2. `capability.plan`
3. execute only if `supported`

## Commands

```bash
# Health
curl -s http://127.0.0.1:8765/health

# List models
curl -s http://127.0.0.1:8765/model/all

# Active model status
curl -s http://127.0.0.1:8765/model/status

# Model params
curl -s "http://127.0.0.1:8765/model/params?model_id=trellis2/main"

# Switch model
curl -X POST "http://127.0.0.1:8765/model/switch?model_id=trellis2/main"

# Unload all
curl -X POST "http://127.0.0.1:8765/model/unload-all"

# Reload extension registry
curl -X POST "http://127.0.0.1:8765/extensions/reload"

# Extension load errors
curl -s http://127.0.0.1:8765/extensions/errors

# Capabilities discovery via bridge
curl -s http://127.0.0.1:8766/automation/capabilities

# Process run status via bridge
curl -s http://127.0.0.1:8766/process-runs/<run-id>
```

## Resources

- `api/main.py`
- `api/routers/status.py`
- `api/routers/model.py`
- `api/routers/generation.py`
- `api/routers/optimize.py`
- `api/routers/export.py`
- `api/routers/settings.py`
- `api/routers/extensions.py`
- `electron/main/python-bridge.ts`
- `electron/main/ipc-handlers.ts`
- `src/shared/types/electron.d.ts`
