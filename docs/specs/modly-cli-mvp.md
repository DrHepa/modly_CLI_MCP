# Modly CLI MVP Specification

## Status

Proposed

## Goal

Define a minimal, headless, API-first CLI for Modly that is immediately useful for agents and humans without pretending Electron-only capabilities are already available headlessly.

## Scope

This MVP includes only commands backed directly by the current FastAPI surface:

- health
- model list/current/params/switch/unload-all/download
- generate from-image
- job status/wait/cancel
- mesh optimize/smooth/export
- ext reload/errors
- config paths get/set

## Non-Goals

The MVP explicitly excludes commands that currently depend on Electron IPC:

- extension install from GitHub
- extension repair/uninstall/list
- logs
- setup
- workflows
- workspace metadata operations
- native dialogs
- updater/window/app controls

It also excludes a durable `mesh import` command because the current endpoint only serves or converts an external file temporarily and does not import it into the workspace.

---

## 1. CLI Contract

### Binary name

`modly`

### Global flags

- `--api-url <url>`
  - Default: `MODLY_API_URL`
  - Fallback: `http://127.0.0.1:8765`

- `--json`
  - Emit a single JSON object to stdout.
  - Progress and diagnostics go to stderr.

### Global output rules

#### Human mode
- Short status line or compact table to stdout
- Errors to stderr
- Progress to stderr

#### JSON mode
All commands emit this envelope:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "apiUrl": "http://127.0.0.1:8765"
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "BACKEND_UNAVAILABLE",
    "message": "GET /health failed"
  },
  "meta": {
    "apiUrl": "http://127.0.0.1:8765"
  }
}
```

### Exit codes

- `0` success
- `1` generic operation failure
- `2` invalid CLI usage or invalid input
- `3` backend unavailable
- `4` resource not found
- `5` unsupported in current headless MVP
- `6` timeout
- `7` validation or path safety failure

### Long-running agent guidance

- Prefer `create -> status -> status -> ...` for agent-driven automation.
- Treat `wait` as a bounded convenience wrapper for short windows or backwards compatibility, not as the primary coordination primitive.
- Where long-running run surfaces expose JSON metadata, keep the resource payload stable and add polling hints alongside it (for example `data.meta.terminal` on `status`, `data.meta.polling` on `wait`, and bounded timeout diagnostics in `error.details`).

---

## 2. Command Groups

## 2.1 `modly health`

### Purpose
Verify that the Modly FastAPI backend is reachable and ready.

### Syntax

```bash
modly health [--api-url <url>] [--json]
```

### Transport mapping
- `GET /health`

### Success output

#### Human
```text
Backend OK — http://127.0.0.1:8765
```

#### JSON
```json
{
  "ok": true,
  "data": {
    "status": "ok"
  },
  "meta": {
    "apiUrl": "http://127.0.0.1:8765"
  }
}
```

### Failure
- Backend unreachable → exit `3`

## 2.2 `modly model list`

### Purpose
List all known models in the current registry.

### Syntax

```bash
modly model list [--api-url <url>] [--json]
```

### Transport mapping
- `GET /model/all`

### Success output

#### Human
Compact table with `id`, `name`, `active`, `downloaded`, `loaded`, `vram_gb`.

#### JSON
```json
{
  "ok": true,
  "data": {
    "models": []
  },
  "meta": {
    "apiUrl": "http://127.0.0.1:8765"
  }
}
```

## 2.3 `modly model current`

### Purpose
Show the active model and its loaded/downloaded status.

### Syntax

```bash
modly model current [--api-url <url>] [--json]
```

### Transport mapping
- `GET /model/status`

### Success output

#### Human
```text
Active model: trellis2/main (downloaded=true, loaded=false)
```

#### JSON
```json
{
  "ok": true,
  "data": {
    "model": {
      "id": "trellis2/main",
      "name": "TRELLIS.2",
      "downloaded": true,
      "loaded": false
    }
  },
  "meta": {
    "apiUrl": "http://127.0.0.1:8765"
  }
}
```

## 2.4 `modly model params`

### Purpose
Return the parameter schema for a model.

### Syntax

```bash
modly model params <model-id> [--api-url <url>] [--json]
```

### Transport mapping
- `GET /model/params?model_id=<model-id>`

### Validation
- `<model-id>` is required

### Failure
- Unknown model → `4`

## 2.5 `modly model switch`

### Purpose
Set the active model.

### Syntax

```bash
modly model switch <model-id> [--api-url <url>] [--json]
```

### Transport mapping
- `POST /model/switch?model_id=<model-id>`

### Failure
- Unknown model → `4`

## 2.6 `modly model unload-all`

### Purpose
Unload all loaded models to free VRAM/RAM.

### Syntax

```bash
modly model unload-all [--api-url <url>] [--json]
```

### Transport mapping
- `POST /model/unload-all`

## 2.7 `modly model download`

### Purpose
Download model files from Hugging Face into `MODELS_DIR/<model-id>`.

### Syntax

```bash
modly model download \
  --repo-id <hf-repo> \
  --model-id <model-id> \
  [--skip-prefix <prefix> ...] \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- `GET /model/hf-download?repo_id=<hf-repo>&model_id=<model-id>&skip_prefixes=<json-list>`

### Behavior
- Reads SSE events from the backend
- Prints progress to stderr
- Emits one final result to stdout
- Downloads files only; it does **not** install an extension or register a missing generator

## 2.8 `modly generate from-image`

### Purpose
Create a generation job from an input image.

### Syntax

```bash
modly generate from-image \
  --image <absolute-image-path> \
  --model <model-id> \
  [--collection <name>] \
  [--remesh quad|triangle|none] \
  [--texture] \
  [--texture-resolution <int>] \
  [--params-json '<json-object>'] \
  [--wait] \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- `POST /generate/from-image` as multipart form with `image`, `model_id`, `collection`, `remesh`, `enable_texture`, `texture_resolution`, `params`

### Validation
- `--image` is required and must exist
- `--model` is required
- `--collection` must not contain `/ : * ? " < > | \\`
- `--remesh` must be `quad`, `triangle`, or `none`
- `--params-json` must parse as a JSON object

### Behavior
- Without `--wait`: returns immediately with `job_id`
- With `--wait`: internally polls job status until terminal state or timeout as bounded convenience; agents should still prefer explicit `job status` polling when coordinating long-running work

## 2.9 `modly job status`

### Purpose
Fetch the current status of a generation job.

### Syntax

```bash
modly job status <job-id> [--api-url <url>] [--json]
```

### Transport mapping
- `GET /generate/status/<job-id>`

### Failure
- Job not found → `4`

## 2.10 `modly job wait`

### Purpose
Wait for a generation job to reach a terminal state.

### Syntax

```bash
modly job wait <job-id> \
  [--interval-ms 1000] \
  [--timeout-ms 600000] \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- repeated `GET /generate/status/<job-id>`

### Behavior
- Polls until `done`, `error`, or `cancelled`
- Prints progress changes to stderr
- Returns final job object
- Intended as convenience for short bounded windows; polling-first clients should prefer repeated `job status`

### Failure
- Job not found → `4`
- Timeout → `6`
- Terminal status `error` → `1`

## 2.11 `modly job cancel`

### Purpose
Cancel a running or pending generation job.

### Syntax

```bash
modly job cancel <job-id> [--api-url <url>] [--json]
```

### Transport mapping
- `POST /generate/cancel/<job-id>`

### Failure
- Job not found → `4`

## 2.12 `modly mesh optimize`

### Purpose
Decimate a workspace mesh to a target face count.

### Syntax

```bash
modly mesh optimize \
  --path <workspace-relative-path> \
  --target-faces <int> \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- `POST /optimize/mesh`

### Validation
- `--path` is required
- `--path` must be workspace-relative and must not contain traversal
- `--target-faces` must be in range `100..500000`

## 2.13 `modly mesh smooth`

### Purpose
Apply Laplacian smoothing to a workspace mesh.

### Syntax

```bash
modly mesh smooth \
  --path <workspace-relative-path> \
  --iterations <int> \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- `POST /optimize/smooth`

### Validation
- `--path` is required
- `--path` must be workspace-relative and must not contain traversal
- `--iterations` must be in range `1..20`

## 2.14 `modly mesh export`

### Purpose
Export a workspace mesh to a local file.

### Syntax

```bash
modly mesh export \
  --path <workspace-relative-path> \
  --format glb|obj|stl|ply \
  [--out <output-file>] \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- `GET /export/<fmt>?path=<workspace-relative-path>`

### Behavior
- Downloads the exported content from the backend
- If `--out` is omitted, writes to `./<input-stem>.<format>`
- Returns the written local file path

## 2.15 `modly ext reload`

### Purpose
Reload the extension registry from the configured `EXTENSIONS_DIR`.

### Syntax

```bash
modly ext reload [--api-url <url>] [--json]
```

### Transport mapping
- `POST /extensions/reload`

## 2.16 `modly ext errors`

### Purpose
Show extension loading errors captured by the registry.

### Syntax

```bash
modly ext errors [--api-url <url>] [--json]
```

### Transport mapping
- `GET /extensions/errors`

## 2.17 `modly config paths get`

### Purpose
Read current backend runtime paths.

### Syntax

```bash
modly config paths get [--api-url <url>] [--json]
```

### Transport mapping
- `GET /settings/paths`

## 2.18 `modly config paths set`

### Purpose
Update backend runtime paths for models and workspace.

### Syntax

```bash
modly config paths set \
  [--models-dir <dir>] \
  [--workspace-dir <dir>] \
  [--api-url <url>] \
  [--json]
```

### Transport mapping
- `POST /settings/paths`

### Important note
This is **runtime-only** in the current backend.
It does **not** persist Electron desktop settings.

---

## 3. Explicitly Deferred Commands

These commands are intentionally out of MVP:

```bash
modly ext list
modly ext install <github-url>
modly ext repair <ext-id>
modly ext uninstall <ext-id>
modly ext setup <ext-id>

modly logs read
modly logs sessions

modly workflow list
modly workflow save
modly workflow delete
modly workflow import
modly workflow export

modly setup check
modly setup run

modly workspace list
modly workspace create
modly workspace rename
modly workspace delete
```

### Reason
They currently rely on Electron IPC or desktop-specific behavior and should not be exposed as if they were already stable headless commands.

---

## 4. Implementation Order

### Phase 1
Implement:
- `health`
- `model list`
- `model current`
- `model params`
- `model switch`
- `model unload-all`
- `model download`
- `generate from-image`
- `job status`
- `job wait`
- `job cancel`
- `mesh optimize`
- `mesh smooth`
- `mesh export`
- `ext reload`
- `ext errors`
- `config paths get`
- `config paths set`

### Phase 2
Add a clean backend bootstrap command:
- `modly serve`

### Phase 3
Extract reusable services from Electron main:
- extensions service
- logs service
- workflows service
- workspace service
- setup service

### Phase 4
Add deferred command groups on top of those extracted services.
