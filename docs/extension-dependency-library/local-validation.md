# Optional Local Asset Validation

This repo-local validator is an **opt-in**, **presence-only** helper for checking whether public dependency-library entries have matching local extension and model asset folders. It is not part of the public package surface and it does not install, download, probe, repair, or execute anything.

## What it checks

The local layout observed for Modly assets is custom to Modly:

- extensions are installed primarily as `extensions/<manifest.id>`;
- models are installed primarily as `models/<extension-id>/<capability-or-weight-owner>/...`;
- hidden backup folders such as `.modly-backup-*` are ignored;
- model presence uses sentinel files such as `model_index.json`, `pipeline.json`, `pipeline.text-localized.json`, `config.json`, `config.yaml`, `*.safetensors`, `*.gguf`, and `*.ckpt`;
- empty model folders are reported as `unknown` or `missing`, not as complete;
- process extensions such as mesh repair or unirig process extensions do not require ML model assets;
- UltraShape remains excluded, non-public, and nonfunctional for this library.

## Candidate precedence

The validator is deterministic and conservative. It checks logical candidates in this order:

1. entry `local_assets.extension_id`, `local_assets.aliases`, `local_assets.manifest_ids`, and legacy `local_assets.manifest_id`;
2. entry `manifest.id` if present;
3. the canonical GitHub repository basename as a backwards-compatible fallback.

Model checks similarly prefer explicit `local_assets.model_assets` roots/subpaths/sentinel files, then fall back to the legacy `models/<extension-id>/<capability-or-weight-owner>` pattern. Examples of evidenced V1 logical model paths are `models/trellis-2/base-4b`, `models/trellis-text/text-base`, `models/hunyuan3d-mini/generate`, and `models/triposg/generate`.

Shared aliases are not automatic wins. If multiple public entries point at the same logical local alias, a directory is reported as `present` only when manifest/repository correspondence supports that entry. Missing or conflicting correspondence is reported as `unknown` or `invalid`, not as compatibility success.

## Usage

Use a runtime-supplied root. Do not commit the generated report if it contains local operational context.

```bash
node scripts/validate-extension-local-assets.mjs --modly-home <MODLY_HOME> --pretty
```

Root precedence is explicit:

1. `--modly-home <MODLY_HOME>`
2. `MODLY_HOME`
3. no root: emit a controlled `not_checked` JSON report and perform no filesystem checks

The report redacts the physical root by default. JSON output uses logical keys like `extensions/<manifest.id>` and `models/<extension-id>/<capability-or-weight-owner>` instead of host-local absolute paths.

`local_assets` metadata in the dependency library is path-safe and logical. It must not contain host-local absolute paths, URLs, traversal, or invented aliases for unsupported fast/turbo/part/GGUF/MV/fork variants. Presence metadata is evidence-only; it does not prove runtime support.

## Status glossary

- `present` — filesystem presence only; not runtime compatibility or success.
- `missing` — an expected logical candidate was absent.
- `unknown` — the local evidence was insufficient, for example an empty model placeholder.
- `not_checked` — the check was intentionally skipped, such as no supplied root or process-extension model assets.
- `invalid` — a descriptor or candidate key was unsafe or unsupported.

## Non-goals

This validator does not call `/health`, `/model/all`, Electron IPC, FastAPI, GitHub, Hugging Face, package managers, installers, downloads, auth checks, or local runtimes. Presence checks must never be presented as runtime/compatibility success.
