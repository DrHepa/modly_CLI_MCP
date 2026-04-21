---
name: modly-extension-planner
description: >
  Plans local Modly extension development through `modly ext-dev` without
  inventing runtime execution. Trigger: When the AI must analyze or draft an
  extension development plan from a local `manifest.json` workspace, classify
  `ext-dev` buckets, explain metadata, or keep extension planning aligned with
  Modly CLI V1 boundaries.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

Use this skill when the user asks to:

- analyze a local Modly extension workspace
- classify an extension as `model-simple`, `model-managed-setup`, or `process-extension`
- explain or use `modly ext-dev`
- draft a scaffold, audit, preflight, or release-plan without executing runtime actions
- reason about extension metadata, risks, gaps, and boundaries in V1

## Critical Rules

1. **Keep V1 plan-only**
   - `modly ext-dev` does **not** install, build, release, or repair.
   - It does **not** mutate runtime state.
   - Do not promise setup execution, publish flows, or Electron-only runtime actions.

2. **Local scope is `manifest.json` only**
   - V1 supports local workspaces with `manifest.json`.
   - Do not invent alternate manifest filenames for V1.

3. **Classify exactly one bucket**
   - `model-simple`: no `setup`, no `process`
   - `model-managed-setup`: `setup` exists
   - `process-extension`: `process` exists

4. **Always emit mandatory metadata**
   - `resolution`
   - `implementation_profile`
   - `setup_contract`
   - `support_state`
   - `surface_owner`
   - `headless_eligible`
   - `linux_arm64_risk`

5. **Separate planned identity from live identity**
   - planned identity comes from local `manifest.json`
   - live identity is optional confirmation only
   - live confirmation must never overwrite planned identity semantics

6. **Respect architecture boundaries**
   - FastAPI owns backend readiness and backend-backed evidence boundaries.
   - Check `GET /health` before backend-backed business operations.
   - Electron owns setup, workflows, install/repair, and other live extension execution.
   - Never invent headless support for Electron-only operations.

7. **Optional checks stay optional**
   - `preflight` may attach FastAPI readiness evidence.
   - `audit` may attach bridge confirmation/collision evidence.
   - Missing FastAPI or bridge support does not invalidate the local plan by itself.

8. **Prefer JSON-first output**
   - For automation, return JSON data first.
   - Human summaries must stay short and factual.

## Command Intent

- `bucket-detect` — classify bucket and metadata
- `preflight` — validate workspace and attach optional FastAPI readiness evidence
- `scaffold` — emit a non-executing implementation plan
- `audit` — emit gaps, risks, and optional bridge confirmation/collision
- `release-plan` — emit an ordered release checklist only

## Forbidden

- claiming `ext-dev` performs install/build/release/repair
- claiming Electron-only setup or workflow execution works headlessly
- treating bridge confirmation as canonical planned identity
- skipping required metadata keys
- using anything other than `manifest.json` for V1 scope

## Output Checklist

- one bucket only
- all mandatory metadata keys present
- `plan_only: true`
- evidence grouped as observed / derived / assumed
- concise human summary plus JSON-ready data
