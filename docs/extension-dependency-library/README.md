# Extension Dependency Library

This directory is a V1 **evidence-only** library for public extension dependency, model-weight, and platform-risk inventory. It is intentionally conservative: repository presence, package names, and model ids never mean an extension is installable, functional, or platform-compatible.

## Files

- `library.json` — curated entries with dependency inventory, model-weight metadata, optional upstream requirement pilots, evidence records, clusters, and explicit unknowns.
- `schema.json` — draft-agnostic structural contract and controlled enums used by the focused semantic validation test.
- `local-validation.md` — opt-in, repo-local, presence-only local asset validation notes using redacted logical paths.
- `README.md` — maintenance rules and scope boundaries.

## Local asset aliases

Some entries include optional `local_assets` metadata. These values are **logical Modly identifiers only**: extension folder ids under `extensions/` and model roots/subpaths under `models/`. They are not host paths, install instructions, runtime contracts, or compatibility claims.

Local aliases are evidence-gated:

- add `extension_id`, `manifest_ids`, `aliases`, `model_roots`, and `model_assets` only when public/reviewed evidence supports the exact logical id;
- keep `status`, `confidence`, and `evidence_ids` on the local asset record and each model asset record;
- use `unknowns` for deferred variants such as fast, turbo, part, GGUF, MV, or ambiguous forks; do not place guessed candidate strings in deferred records;
- never add host-local absolute paths, `file://` URLs, traversal, drive-letter paths, or slash-bearing segment aliases;
- remember that local presence remains **presence-only** and must not be presented as runtime compatibility, auth success, model completeness, installation success, or generation success.

V1 intentionally includes only evidenced logical aliases for `hunyuan3d-mini`, `trellis-2`/`trellis2`, `triposg`, and `trellis-text`. UltraShape remains excluded and must not be reintroduced through local alias metadata.

## Real dependency fields

Each entry now includes semantic dependency data, not only claims:

- `dependency_summary` — inventory status, package/model counts, confidence, and short notes.
- `dependency_groups` — grouped records for Python/system/node/model dependencies. Package records include `name`, `ecosystem`, `specifier` or `unknown_reason`, `source.type`, optional/fallback flags, build mode, native ABI risk, confidence, and `evidence_ids`.
- `model_weights` — Hugging Face or upstream model records with provider, `repo_id` or `unknown_reason`, file globs or explicit unknowns, auth status, download owner, large-download risk, and evidence.
- `upstream_requirements` — optional evidence-backed upstream install contract notes for exact stack lanes, wrapper/upstream references, dependency source URLs, setup inputs, and validation state. It remains documentation only, not runtime setup enforcement.
- `cluster_refs` — references into top-level `shared_clusters` such as `trellis-family`, `hunyuan-instantmesh-family`, `triposg-diso-family`, `pytorch-lanes`, `pyg-sparse-conv-family`, and `gated-weights`.
- `no_dependencies_reason` — reserved for non-ML or registry-only entries with no dependency/model records. It is mutually exclusive with `dependency_groups` and `model_weights`.

Consumers must read package inventory from `entry.dependency_groups[].packages[]`. Do not expect, synthesize, or duplicate a flat `dependencies` field unless a future external contract explicitly requires one.

When rendering dependency evidence for planning, include group metadata from `dependency_groups[]` (`id`, `kind`, `scope`, `purpose`, `accelerator_lanes`) and package metadata from `packages[]` (`name`, `specifier`, `native_abi_risk`, `source`, `confidence`, `evidence_ids`, `optional`, `fallback`, `build_mode`).

If `upstream_requirements.stack_lanes[].packages[]` exists, treat those packages as exact-stack lane context only. They are not a replacement for the entry dependency inventory and must stay visually/logically separate from `dependency_groups[].packages[]`.

## Semantic validation

The focused test performs **semantic validation**, not just JSON shape checks. It rejects the old claim-only failure mode by requiring every entry to have a real dependency inventory, model-weight metadata, or a valid evidence-backed `no_dependencies_reason`. It also checks cluster resolution, package record completeness, model-weight explicitness, core package coverage, optional `upstream_requirements` lane completeness, AMD/ROCm evidence guards, source sanitization, and UltraShape exclusion.

Run only the focused contract test for this document library:

```bash
node --test test/docs/extension-dependency-library.test.mjs
```

## Confidence and unknowns

Each material claim carries its own confidence:

- `confirmed` — directly supported by a public project artifact or canonical registry record.
- `strong` — backed by public upstream documentation or source with low ambiguity.
- `partial` — evidence covers part of the claim, but important unknowns remain.
- `weak` — public identifier/source exists, but no install, download, or runtime probe was performed.
- `unknown` — not evidenced; do not infer support.

Use `unknown_reason` and `unknowns` instead of inference. For example, a torch CUDA index does not prove CUDA runtime success, Linux ARM64 support, AMD/ROCm support, or working native wheels.

## Maintenance workflow

1. Add only public/verifiable entries or public registry records.
2. Record package/model claims with evidence ids and public sources.
3. Keep unsupported or unverified platform states as `unknown` or `not-evidenced`; do not upgrade AMD/ROCm, Linux ARM64, CUDA, gated-model, or native-ABI claims without explicit public evidence.
4. Prefer concrete package and model records with explicit unknowns over broad compatibility claims.
5. For `local_assets`, prefer absence or `deferred_no_evidence` unknowns over inferred aliases. Shared aliases, such as `hunyuan3d-mini`, require repo/manifest correspondence before any local presence is treated as present.
6. For `upstream_requirements`, keep stack lanes conservative: prefer `experimental` or `unknown`, record wheel/native ABI risk explicitly, and leave `evidence_ids` empty when only source URLs are stable.
7. Manually review each source for freshness and scope before changing confidence.

## Repository identity accuracy

Use the canonical public GitHub `owner/repo` for each extension identity; do not create label-inferred repository ids from display names, ComfyUI naming conventions, or local folder names. `identity.public_url` must be derived from `identity.repo` as `https://github.com/${identity.repo}` exactly.

GitHub evidence must point to the same repo as `identity.repo` unless a future change adds a narrow, documented exception keyed by entry and evidence id. UltraShape remains excluded from this V1 library and must not be introduced through identity or evidence fields.

## Source sanitization

Entries and evidence must not contain host-local absolute paths, `file://` host paths, traversal segments, or inaccessible project identifiers that imply public availability. Use public repository identifiers, public URLs, neutral names, and explicit unknowns.

## Non-goals

This library is **not** planner skill v2. It is **not an installer**, downloader, runtime probing system, Electron IPC operation, FastAPI integration, compatibility oracle, GitHub fetcher, Hugging Face fetcher, or extension repair mechanism. It does not call `/health`, `/model/all`, Electron, FastAPI, GitHub, Hugging Face, package managers, or local runtimes.

Optional `upstream_requirements` records are still **evidence-only/document-only**. They describe the best currently supported upstream or wrapper contract visible from public sources, but they do not execute setup, enforce pins, inject runtime parameters, or prove the lane works in Modly today.

## Packaging behavior

V1 is **repo-local/document-only**. The library is not intentionally included in the npm package surface, and `package.json.files` should not include `docs/extension-dependency-library/**` unless a future design explicitly changes that packaging contract.

## Manual review duties

Before using an entry for automation, a reviewer must verify the public source, validate exact model and dependency requirements, check gated/auth requirements, and confirm platform evidence. If evidence is absent, keep the claim unknown. This file is a map, not the territory.
