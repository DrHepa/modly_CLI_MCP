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

2. **Respect the architecture boundary**
   - **FastAPI owns**: model status/list/params/switch/unload, model file download via HF SSE, generation jobs, mesh optimize/smooth/export, extension registry reload/errors, runtime path updates.
   - **Electron IPC owns**: setup, logs, GitHub extension install/repair/uninstall, workflows, native dialogs, app orchestration, workspace UI metadata.

3. **Never invent headless support**
   - If an operation currently exists only in Electron IPC, do NOT present it as available through FastAPI or CLI MVP.
   - Examples: `extensions:installFromGitHub`, `extensions:repair`, `log:readAll`, `workflows:*`, `setup:*`.

4. **Use canonical IDs**
   - Model IDs come from `/model/all`.
   - Treat them as canonical API inputs.
   - Do NOT fabricate IDs from labels.

5. **Treat workspace paths as a contract**
   - Mesh operations use workspace-relative paths such as `Default/chair.glb`.
   - Validate paths before sending them.
   - Never allow traversal-like inputs.

6. **Prefer machine-readable output**
   - For automation, prefer JSON.
   - For human output, keep summaries short and factual.

7. **Handle long-running operations correctly**
   - Generation is job-based: create job, then poll status.
   - HF model downloads are SSE/progress-based.
   - Do not block blindly without progress or timeout handling.

8. **Be honest about persistence**
   - FastAPI `settings/paths` updates runtime registry paths only.
   - It does not persist Electron desktop settings.

## Allowed

- Check backend health
- List models and inspect active model status
- Inspect model parameter schema
- Switch active model
- Unload all loaded models
- Download model files through the HF download endpoint
- Generate from image
- Poll or cancel jobs
- Optimize or smooth workspace meshes
- Export meshes
- Reload extension registry
- Inspect extension load errors
- Read runtime backend paths
- Update runtime backend paths

## Forbidden

- Claiming GitHub extension install works through FastAPI
- Claiming full workflow management exists in the CLI MVP
- Claiming desktop setup/logs are headless today
- Performing unsafe arbitrary filesystem mutation
- Pretending native dialogs exist in CLI/MCP flows
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

If the requested operation touches any of these, assume it is **Electron/IPC-bound** unless the repo has been explicitly refactored:

- setup
- logs
- workflows
- GitHub extension install/repair/uninstall
- native dialogs
- workspace UI metadata
- app updater/window controls

If the requested operation is about models, jobs, or mesh processing, prefer **FastAPI first**.

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
