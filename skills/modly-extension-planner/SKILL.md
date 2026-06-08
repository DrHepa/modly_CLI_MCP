---
name: modly-extension-planner
description: >
  Plans Modly extension development through `modly ext-dev` and evidence-based
  dependency/model/platform-risk review without inventing runtime execution.
  Trigger: When the AI must analyze or draft an extension development plan from
  a local `manifest.json` workspace, classify `ext-dev` buckets, explain
  metadata, consult repo-local dependency-library evidence, or produce a
  JSON-first extension plan aligned with Modly CLI V1 boundaries.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "2.1"
---

## When to Use

Use this skill when the user asks to:

- analyze a local Modly extension workspace with `manifest.json`
- classify an extension as `model-simple`, `model-managed-setup`, or `process-extension`
- explain or use `modly ext-dev`
- draft a scaffold, audit, preflight, dependency review, model-weight plan, or release-plan without executing runtime actions
- reason about extension metadata, platform risks, dependency lanes, model refs, gaps, and boundaries in V1
- use repo-local `docs/extension-dependency-library/` evidence to inform a plan

## Critical Rules

1. **Plan-only means plan-only**
   - `modly ext-dev` does **not** install, build, download, probe, release, repair, mutate runtime state, call Electron IPC, call FastAPI, or run network fetches.
   - Do not execute setup, package managers, model downloads, runtime probes, Electron-only workflows, or FastAPI business operations from this skill.
   - If a future explicit command asks for operations, switch to operator boundaries first and check `GET /health` before backend-backed business operations.

2. **Dependency library is evidence, not an oracle**
   - `docs/extension-dependency-library/` is repo-local, evidence-only, non-packaged planning input.
   - It is not a compatibility oracle, not a compatibility guarantee, not an installer, and not proof that an extension is functional.
   - Missing, stale, or unavailable entries become `unknowns`, `assumptions`, or fallback review tasks.

3. **Use canonical identities only**
   - Planned extension identity comes from local `manifest.json`.
   - Modly backend model IDs must come from `/model/all`; never fabricate model IDs from labels, repo names, or UI text.
   - Public repo/ref inputs must stay public placeholders or user-provided public identifiers; do not expose private identifiers.

4. **Preserve V1 bucket semantics**
   - V1 supports local workspaces with `manifest.json` only.
   - Classify exactly one bucket:
     - `model-simple`: no `setup`, no `process`
     - `model-managed-setup`: `setup` exists
     - `process-extension`: `process` exists

5. **Always emit mandatory metadata**
   - `resolution`
   - `implementation_profile`
   - `setup_contract`
   - `support_state`
   - `surface_owner`
   - `headless_eligible`
   - `linux_arm64_risk`

6. **Respect architecture boundaries**
   - FastAPI owns models, jobs, mesh operations, runtime paths, backend readiness, and backend-backed evidence boundaries.
   - Electron owns setup, workflows, GitHub extension install/repair, logs, and live extension execution.
   - Never invent headless support for Electron-only operations.

7. **Block unsafe claims instead of softening them**
   - No AMD/ROCm support claims without explicit evidence.
   - UltraShape remains excluded, non-public, and nonfunctional for this evidence path.
   - Reject local absolute paths, `file://`, traversal such as `..`, and private identifiers in user-facing plans.

8. **Prefer JSON-first output**
   - For automation, return JSON data first.
   - Human summaries must stay short and factual.

## Functional Modly Extension Contract

Use this section when the user wants to create a working extension, not only audit one. Keep it plan-only, but plan against the real Modly seams.

### GitHub install and setup seam

- `modly ext stage github` is preflight/staging only. It inspects a candidate snapshot and must find a root `manifest.json`; it does not make the extension operational.
- `modly ext apply` is the live install seam. It applies a prepared stage into the real extension directory and may trigger setup against the live target.
- `modly ext repair` reapplies an already prepared stage and may trigger the same setup contract.
- `modly ext setup` runs an explicit, limited setup contract; it is not a universal installer and cannot force a broken third-party `setup.py` to respect `PIP_*`, mirrors, CUDA lanes, or local caches.
- `modly ext setup-status` observes local setup state only. `--wait`, `--follow`, and `--timeout-ms` are observer controls, not a job manager or cancellation layer.
- An install can legitimately become `applied_degraded`: files were applied, but extension-owned setup failed. Plans must separate Modly seam success from extension setup/runtime failure.

### Repository root contract

A functional GitHub-installable extension plan should account for these root-level artifacts:

- `manifest.json` — required identity and Modly contract source. `manifest.id` must be safe, non-empty, path-safe, and stable.
- `generator.py` — required for model extensions that declare `generator_class`; heavy CUDA/HF imports should stay behind `load()`/`generate()` boundaries.
- process entrypoints — required for process extensions that declare `manifest.process`; plan command/runtime ownership, input/output files, logs, and artifact expectations separately from model generator contracts.
- `setup.py` — required when `manifest.setup` exists. It should accept Modly-injected JSON context such as extension directory and Python executable payloads, support JSON observations, and fail with actionable machine-readable errors.
- optional package/runtime modules — importable from the extension venv, with native alias shims only when the exact lane requires them.
- documentation — must distinguish extension code from model assets and stable lanes from candidates.

### Manifest planning checklist

When drafting or reviewing `manifest.json`, plan these fields explicitly:

- identity: `id`, `name`, `version`, `author`, `description`
- bucket signals: `setup`, `process`, `kind`/`type`, `entrypoints`, `generator_class`
- I/O: `inputs`, `outputs`, node type, node id, formats, PBR expectations
- process contract: when `process` exists, planned command/runtime ownership, workspace inputs, workspace outputs, progress/log behavior, and failure reporting
- UI params: use UI-safe schemas; for booleans that Modly serializes as strings, prefer explicit `select` values and parse them explicitly in runtime
- model refs: public `hf_repo` or model source references, sentinel `download_check`, `weight_owner_id`, and model ownership
- `asset_requirements`: sentinel files, logical `models/<extension-id>/...` paths, public substitutions, and readiness metadata
- `platforms`: status per OS/arch/GPU lane; do not mark a platform supported until setup and runtime have evidence
- `assets`: logical extension/model roots only; never host paths

### Setup contract checklist

For `model-managed-setup` plans, require an extension-owned setup plan with:

- venv location and ownership, normally below the extension directory
- exact Python ABI assumptions, especially Modly packaged-app `cp311` on Windows
- torch/CUDA index and native ABI lane, separated from generic helper requirements
- release-backed wheelhouse or other reproducible binary source for native packages when source build is not acceptable
- checksum verification before extraction/install
- `pip install --no-index --find-links <verified-wheelhouse>` for native wheelhouse packages when wheelhouse policy is required
- no silent PyPI fallback for native packages that must be exact-stack
- `pip check` and import probes for critical native packages
- setup readiness JSON with `status`, failure code, `downloads_started`, `installs_started`, `next_steps`, and path conflict diagnostics
- safe logical path creation; reject traversal, drive letters, absolute paths, hidden backup prefixes, and Windows reserved segments such as `AUX`, `CON`, `NUL`, `PRN`, `COM1-9`, and `LPT1-9`

### Runtime contract checklist

For model generation plans, require:

- root `generator.py` exposes the manifest `generator_class`
- constructor accepts Modly-provided model/workspace paths without assuming host-specific paths
- `is_downloaded()`/readiness checks use sentinel files and do not confuse empty helper folders with missing primary weights
- `generate()` writes outputs under the provided workspace/output directory and returns the final artifact path
- runtime errors return structured JSON where possible; fatal native crashes need diagnostic checkpoints, not speculative fixes
- stdout/stderr behavior is considered so progress logs do not corrupt JSON protocol expectations
- final output validation checks the actual generated artifact, e.g. GLB exists, loads, has nonzero geometry, and is fetched from workspace when applicable

For process-extension plans, keep the same discipline but use the declared process contract instead of inventing a model generator: explicit inputs, outputs, logs, progress, cancellation expectations, and artifact validation.

### Release and validation ladder

Before recommending publication, plan a ladder:

1. static contract checks: manifest, setup, dependency evidence, safe paths
2. setup dry run or setup observation without downloads where supported
3. full setup on target lane with checksum/pip/import probes
4. model asset download/readiness checks using logical model roots
5. first real generation smoke test with representative low-resource settings
6. artifact validation and workspace fetch
7. docs/About/topics/release notes
8. stable release only after validation; candidate/pre-release lanes remain opt-in and outside the stable manifest

If validation is community-provided, record it as validation evidence with platform/GPU/driver/VRAM/context and keep candidate lanes out of the stable manifest until confirmed.

## Input Contract

Ask for or clearly mark these fields as unknown before making plan claims:

- `os`: target operating system and version/family
- `arch`: CPU architecture, for example `x64` or `arm64`
- `gpu_vendor`: `nvidia`, `amd`, `apple`, `intel`, `none`, or `unknown`
- `public_repo`: public repository owner/name or public URL text supplied by the user
- `public_ref`: branch, tag, commit, or release ref
- `extension_category`: `model-simple`, `model-managed-setup`, `process-extension`, or `unknown` until `manifest.json` is reviewed
- `install_strategy`: planned strategy such as source checkout, wheel, prebuilt artifact, or unknown
- `model_refs`: public model IDs, repositories, filenames, or explicit unknowns
- `auth_policy`: public, gated, user-provided token required, or unknown

Conditional inputs:

- For NVIDIA planning, request CUDA toolkit/runtime, driver version, Python version, PyTorch version, and desired compute capability when native packages or torch lanes matter.
- For non-NVIDIA planning, do **not** imply AMD/ROCm support; record GPU capability as unknown unless explicit public evidence exists.

## Workflow

1. **Classify intent**
   - Determine whether the user wants bucket detection, preflight planning, scaffold planning, audit, dependency review, model-weight planning, or release-plan output.
   - Keep all intents non-executing.

2. **Collect environment inputs**
   - Apply the Input Contract.
   - Missing required or conditional values become `assumptions`, `risks_unknowns`, or `next_steps`.

3. **Read local planning evidence when available**
   - Use `manifest.json` for V1 planned identity and bucket classification.
   - Keep live identity optional and never let live confirmation overwrite planned identity semantics.

4. **Consult dependency-library evidence when available**
    - Use `docs/extension-dependency-library/README.md` for scope and limitations.
    - Use `docs/extension-dependency-library/schema.json` for field meanings.
    - Use `docs/extension-dependency-library/library.json` for public evidence entries, model weights, platform inventory, shared clusters, evidence IDs, `observed_at`, and confidence.
    - Read dependency inventory from `entry.dependency_groups[].packages[]`; do not expect or invent a flat `dependencies` field.
    - When presenting dependency inventory, include group metadata from each `dependency_groups[]` record: `id`, `kind`, `scope`, `purpose`, and `accelerator_lanes`.
    - When presenting package facts, carry package metadata from each `packages[]` record: `name`, `specifier`, `native_abi_risk`, `source`, `confidence`, `evidence_ids`, `optional`, `fallback`, and `build_mode`.
    - If `upstream_requirements.stack_lanes[].packages[]` exists, present it only as exact-stack lane context. Keep it separate from inventory packages so lane-specific pins do not get confused with the entry dependency inventory.

5. **Build the plan**
    - Produce platform matrix rows as supported, blocked, risky, or unknown only when evidence justifies that classification.
    - Produce dependency lanes from evidence-backed package groups or mark them unknown.
    - Produce model weight actions as ownership/auth/evidence tasks, not implicit Modly downloads.
    - For creation plans, include install/setup/runtime/release contract tasks from the Functional Modly Extension Contract.

6. **Block unsupported claims**
   - Put unsafe or unevidenced statements into `blocked_claims` instead of stating them as facts.

7. **Return JSON first**
   - Emit the Output Contract object first, then a short human summary if useful.

## Evidence Lookup

Use `docs/extension-dependency-library/` only when this repository checkout is available. The library is evidence-only and non-packaged; installed skill consumers may not have it.

Lookup order:

1. Read the README for scope, limits, and freshness rules.
2. Read the schema to understand fields and enums before interpreting entries.
3. Match library entries by public repo/ref/category/model clues.
4. For each non-unknown claim copied into a plan, cite:
    - entry id
    - evidence id(s)
    - public source type and public locator
    - `observed_at`
    - confidence
5. When building `dependency_lanes`, summarize `entry.dependency_groups[]` first and use `upstream_requirements.stack_lanes[]` only as labeled exact-stack examples.

If evidence is unavailable, absent, stale, incomplete, private, or not specific to the requested platform, do not fetch, install, download, probe, or guess. Record a fallback review task and keep `not_a_compatibility_guarantee: true`.

## Reference Extension Patterns

Use entries in `docs/extension-dependency-library/library.json` as pattern references, not as copy-paste guarantees.

| Pattern | Reference entries | What to learn | What not to claim |
| --- | --- | --- | --- |
| Release-backed CUDA model extension | `drhepa-pixal3d` | `model-managed-setup`, exact-stack torch/CUDA lanes, checksum wheelhouse, native import probes, model assets below `models/pixal3d`, runtime GLB validation | Do not generalize its wheelhouse to other GPUs/CUDA lanes; candidate Blackwell lanes stay opt-in until validated |
| Heavy native CUDA family with unknown lanes | TRELLIS, TripoSG, Hunyuan3D entries | native ABI risk, torch lane coupling, model-weight ownership, unknown platform states | Do not infer Windows/Linux/AMD support from family similarity |
| Process/animation/rig extension | `drhepa-kimodo`, `drhepa-unirig` | process-extension/runtime ownership, external tool or rig pipeline risk, experimental platform status | Do not convert process contracts into model-simple contracts |
| Upstream model candidate | `sd15`, `sdxl-base`, `flux-schnell` | model weight/auth/gating planning without extension install claims | Do not treat upstream model presence as a Modly extension |

When the user asks "what extensions exist?", list entry ids, repo identities, relationship, platform statuses, dependency summary, and the contract pattern above. If a user asks to build a new extension similar to one entry, extract the pattern and validation ladder, but keep exact pins and support states evidence-specific.

## Fallback Public-Source Review Checklist

When dependency-library evidence is missing or insufficient, produce review tasks only:

- inspect public README/install docs for declared Python, Node, system, and GPU requirements
- inspect public dependency files such as `requirements.txt`, `pyproject.toml`, lock files, package manifests, setup scripts, and model cards
- identify native/ABI-risk packages and torch/CUDA coupling risks
- identify model weight locations, filenames, auth/gating, license notes, and expected ownership
- identify public platform notes for OS, arch, GPU vendor, CUDA, and Python version
- record unknowns instead of executing installs, downloads, runtime probes, Electron IPC, FastAPI operations, or network fetches

## Output Contract

Return JSON first with exactly these top-level keys unless the caller asks for a narrower contract:

```json
{
  "plan": {
    "intent": "audit",
    "plan_only": true,
    "bucket": "unknown",
    "mandatory_metadata": {
      "resolution": "unknown",
      "implementation_profile": "unknown",
      "setup_contract": "unknown",
      "support_state": "unknown",
      "surface_owner": "unknown",
      "headless_eligible": false,
      "linux_arm64_risk": "unknown"
    }
  },
  "human_summary": "Plan-only review; missing evidence is listed as unknown.",
  "evidence_trace": [],
  "platform_matrix": [],
  "dependency_lanes": [],
  "model_weights_plan": [],
  "risks_unknowns": [],
  "blocked_claims": [],
  "assumptions": [],
  "next_steps": [],
  "not_a_compatibility_guarantee": true
}
```

Rules for values:

- Use public placeholder examples only, such as `public-owner/public-repo` and `v1.2.3`.
- Do not include local absolute paths, `file://`, traversal paths, secrets, private repository names, private branches, or private identifiers.
- `evidence_trace` entries must distinguish observed, derived, and assumed facts.
- `human_summary` must be short, factual, and subordinate to the JSON object.

## V1 ext-dev Boundaries

Command intent remains V1 plan-only:

- `bucket-detect` — classify bucket and mandatory metadata
- `preflight` — validate workspace and attach optional FastAPI readiness evidence without executing backend business operations
- `scaffold` — emit a non-executing implementation plan
- `audit` — emit gaps, risks, dependency/model/platform unknowns, and optional bridge confirmation/collision evidence
- `release-plan` — emit an ordered release checklist only

Optional checks stay optional:

- `preflight` may attach FastAPI readiness evidence, but must check `GET /health` before backend-backed business operations if a future operation is explicitly requested.
- `audit` may attach bridge confirmation/collision evidence.
- Missing FastAPI or bridge support does not invalidate the local plan by itself.

## Forbidden Claims

Never state these as supported facts; place them in `blocked_claims`, `risks_unknowns`, or `next_steps` instead:

- `ext-dev` performs install/build/download/release/repair or runtime mutation
- Electron-only setup, workflow, install/repair, or UI operations work headlessly
- dependency-library entries are a compatibility guarantee or compatibility oracle
- AMD/ROCm support exists without explicit evidence
- UltraShape is public, functional, supported, or usable through this evidence path
- model IDs are valid unless they come from canonical `/model/all` evidence
- fabricated model IDs inferred from labels, repo names, screenshots, or UI text
- local absolute paths are safe for user-facing plans
- `file://` locators are acceptable in user-facing plans
- traversal paths such as `..` are acceptable
- private identifiers, private refs, private repository names, secrets, or tokens can be exposed
- FastAPI owns Electron setup/install/repair/workflow operations
- Electron IPC is available from headless CLI/MCP planning unless a future explicit operator command proves and uses that boundary

## Output Checklist

- JSON-first object includes `plan`, `human_summary`, `evidence_trace`, `platform_matrix`, `dependency_lanes`, `model_weights_plan`, `risks_unknowns`, `blocked_claims`, `assumptions`, `next_steps`, and `not_a_compatibility_guarantee`
- `plan.plan_only` is `true`
- one bucket only when bucket evidence exists; otherwise `unknown`
- all mandatory metadata keys present
- dependency library cited only as evidence-only, non-packaged input
- evidence grouped as observed / derived / assumed
- unsupported AMD/ROCm, UltraShape, fabricated ID, local path, `file://`, traversal, private identifier, headless Electron, and compatibility guarantee claims are blocked
- concise human summary plus JSON-ready data
