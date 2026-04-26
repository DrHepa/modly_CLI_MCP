export function renderHelp() {
  return `modly — headless CLI for Modly

Usage:
  modly [--api-url <url>] [--json] <group> [subcommand]
  modly health [--api-url <url>] [--json]
  modly capabilities [--api-url <url>] [--json]

Available groups:
  capabilities              Discovers automation capabilities
  health                    Checks GET /health
  model <subcommand>        list | current | params | switch | unload-all | download
  process-run <subcommand>  create | status | wait | cancel
  workflow-run <subcommand> from-image | status | wait | cancel
  generate <subcommand>     from-image
  job <subcommand>          status | wait | cancel
  mesh <subcommand>         optimize | smooth | export
  scene <subcommand>        import-mesh
  ext <subcommand>          reload | errors | stage github | apply | setup | setup-status | repair
  ext-dev <subcommand>      bucket-detect | preflight | scaffold | audit | release-plan
  config <subcommand>       paths get | paths set | launcher locate | launcher open

Launcher note:
  launcher open runs in the background by default; use --foreground for foreground mode

Global flags:
  --api-url <url>           Overrides MODLY_API_URL
  --json                    Emits a JSON envelope
  -h, --help                Shows this help

Bootstrap status:
  - capabilities, health, model, generate, job, workflow-run, process-run, mesh, scene, ext, ext-dev, and config are already functional
  - workflow-run and process-run are the primary canonical run surfaces for recovery/polling
  - modly.capability.execute and modly.recipe.execute are presented as convenience/orchestration wrappers over workflow-run/process-run.
  - generate/job remain current observable compatibility
  - modly.recipe.execute is experimental, opt-in, and hidden by default via MODLY_EXPERIMENTAL_RECIPE_EXECUTE.
  - ext stage github             Stage/preflight only from GitHub; prepares and inspects, does NOT install or apply live.
  - ext apply                    Installs an already prepared stage onto the live target; requires explicit --extensions-dir, may trigger live-target setup if the stage requires it, and may finish as applied_degraded when that setup fails.
  - ext setup                    Runs ONLY an explicit contract on an already prepared stage; cataloged/limited support, not universal; some extensions require explicit inputs such as gpu_sm and PIP_* resilience may provide partial benefit or none if setup.py ignores those variables or performs its own downloads.
  - ext setup-status             Reads ONLY the installed target journal from the last observable setup; --wait/--follow observe locally, --timeout-ms does not kill the process, and there is no general reattach/cancel/job control.
  - ext repair                   Reapplies an already prepared stage; may trigger live-target setup if the stage requires it, accepts the same relevant setup flags as apply, and by default no longer creates a backup when the extension exists. Does NOT perform GitHub fetch, install, build, or general health-fix.
  - ext-dev                      Local plan-only planner visible in V1; optional /health only with backend evidence and optional bridge only for confirmation/collision.
`;
}

export function renderCapabilitiesHelp() {
  return `modly capabilities — canonical discovery for automation

Usage:
  modly capabilities [--api-url <url>] [--json]

Description:
  Queries GET /automation/capabilities without a separate /health preflight.
  In JSON, preserves the canonical payload inside data.
  In human mode, summarizes readiness, counts, and partiality when applicable.

Schema enrichment:
  - When backend/runtime provides a verified contract, JSON separates declared_inputs, supplemental_inputs, and enriched_inputs.
  - supplemental_inputs carry provenance; do not guess hidden params from labels, names, or vague hints.
  - trellis2/refine is a verified backend-runtime model: it may accept params.mesh_path and params.image_path with provenance verified_runtime_behavior even when params_schema may not include them.
  - capability.execute is not supported for trellis2/refine unless a future explicit implementation adds it.
`;
}

export function renderModelHelp() {
  return `modly model — model operations

Usage:
  modly model list [--api-url <url>] [--json]
  modly model current [--api-url <url>] [--json]
  modly model params <model-id> [--api-url <url>] [--json]
  modly model switch <model-id> [--api-url <url>] [--json]
  modly model unload-all [--api-url <url>] [--json]
  modly model download --repo-id <hf-repo> --model-id <model-id> [--skip-prefix <prefix> ...] [--api-url <url>] [--json]

Available subcommands:
  list                      Lists known models
  current                   Shows the active model
  params <model-id>         Returns model parameters
  switch <model-id>         Switches the active model
  unload-all                Unloads all loaded models
  download                  Downloads model files via backend/SSE
`;
}

export function renderJobHelp() {
  return `modly job — generation job operations

Usage:
  modly job status <job-id> [--api-url <url>] [--json]
  modly job wait <job-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]
  modly job cancel <job-id> [--api-url <url>] [--json]

Available subcommands:
  status <job-id>            Shows the current job status
  wait <job-id>              Polls until done, error, or cancelled
  cancel <job-id>            Requests job cancellation

Notes:
  - Visible legacy compatibility surface; does not replace workflow-run/process-run as the canonical path
`;
}

export function renderProcessRunHelp() {
  return `modly process-run — canonical mesh-only process runs

Usage:
  modly process-run create --process-id <id> --params-json '{...}' [--workspace-path <path>] [--output-path <path>] [--api-url <url>] [--json]
  modly process-run status <run-id> [--api-url <url>] [--json]
  modly process-run wait <run-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]
  modly process-run cancel <run-id> [--api-url <url>] [--json]

Available subcommands:
  create                    Creates a process run with canonical process_id and params object
  status <run-id>           Shows the current process run status
  wait <run-id>             Polls until succeeded, failed, or canceled
  cancel <run-id>           Requests process run cancellation

Notes:
  - Canonical execution primitive for published processes
  - status/wait preserve the recovery/polling path on the same runId
  - Performs a GET /health preflight before business operations
  - Supports only mesh-only processes already published by capabilities.processes
  - --workspace-path and --output-path must be workspace-relative
  - For mesh-optimizer/optimize and mesh-exporter/export, --workspace-path is normalized to the mesh file; if the parent directory is provided and params.mesh_path identifies the local basename, it is autocorrected
  - Do not use Trellis2/refine as a process-run contract: it is a backend-runtime model; process-run does not promise to execute its supplemental inputs
`;
}

export function renderGenerateHelp() {
  return `modly generate — headless generation

Usage:
  modly generate from-image --image <path> --model <id> [--collection <name>] [--remesh quad|triangle|none] [--texture] [--texture-resolution <n>] [--params-json '<json>'] [--wait] [--api-url <url>] [--json]

Available subcommands:
  from-image                 Creates a generation job from an image

Notes:
  - Observable legacy compatibility surface; workflow-run is the canonical run path for new recovery/polling
`;
}

export function renderWorkflowRunHelp() {
  return `modly workflow-run — canonical headless image runs

Usage:
  modly workflow-run from-image --image <path> --model <id> [--params-json '{...}'] [--api-url <url>] [--json]
  modly workflow-run status <run-id> [--api-url <url>] [--json]
  modly workflow-run wait <run-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]
  modly workflow-run cancel <run-id> [--api-url <url>] [--json]

Available subcommands:
  from-image                Creates a workflow run from an image
  status <run-id>           Shows the current run status
  wait <run-id>             Polls until done, error, or cancelled
  cancel <run-id>           Requests run cancellation

Notes:
  - Canonical execution primitive for image-based runs
  - status/wait preserve the recovery/polling path on the same runId
`;
}

export function renderMeshHelp() {
  return `modly mesh — workspace mesh operations

Usage:
  modly mesh optimize --path <workspace-relative-path> --target-faces <n> [--api-url <url>] [--json]
  modly mesh smooth --path <workspace-relative-path> --iterations <n> [--api-url <url>] [--json]
  modly mesh export --path <workspace-relative-path> --format glb|obj|stl|ply [--out <file>] [--api-url <url>] [--json]

Available subcommands:
  optimize                   Decimates a mesh to a target face count
  smooth                     Applies Laplacian smoothing
  export                     Downloads an exported mesh to a local file
`;
}

export function renderSceneHelp() {
  return `modly scene — explicit Modly Desktop scene operations

Usage:
  modly scene import-mesh <mesh-path> [--api-url <url>] [--json]

Available subcommands:
  import-mesh <mesh-path>    Imports a workspace-relative mesh through the explicit Desktop bridge

Notes:
  - Performs a GET /health preflight before business operations
  - Requires the Desktop bridge to advertise scene.import_mesh; otherwise, it fails closed
  - Accepts .glb, .obj, .stl, and .ply, or the subset advertised by the Desktop bridge
  - Does not automate file pickers, menus, clicks, or system dialogs
  - --json emits the existing JSON envelope with ok/data|error/meta
`;
}

export function renderExtHelp() {
  return `modly ext — extension operations

Usage:
  modly ext reload [--api-url <url>] [--json]
  modly ext errors [--api-url <url>] [--json]
  modly ext stage github --repo <owner/name> [--ref <ref>] [--staging-dir <workspace-relative-path>] [--api-url <url>] [--json]
  modly ext apply --stage-path <path> --extensions-dir <abs-path> [--source-repo <owner/name> --source-ref <ref> --source-commit <sha>] [--python-exe <exe>] [--allow-third-party] [--setup-payload-json '{...}'] [--api-url <url>] [--json]
  modly ext setup --stage-path <path> --python-exe <exe> --allow-third-party [--setup-payload-json '{...}'] [--api-url <url>] [--json]
  modly ext setup-status --extensions-dir <abs-path> (--manifest-id <id> | --stage-path <path>) [--wait] [--follow] [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]
  modly ext repair --stage-path <path> --extensions-dir <abs-path> [--source-repo <owner/name> --source-ref <ref> --source-commit <sha>] [--python-exe <exe>] [--allow-third-party] [--setup-payload-json '{...}'] [--api-url <url>] [--json]

Available subcommands:
  reload                    Reloads the extension registry
  errors                    Shows captured extension loading errors
  stage github              staging/preflight only from GitHub; Does NOT install or apply live
  apply                     installs an already prepared stage onto the live target; requires explicit --stage-path and --extensions-dir, and forwards live-target setup flags when needed
  setup                     CLI-only setup on an already prepared stage; requires --stage-path, --python-exe, and --allow-third-party
  setup-status              reads ONLY the installed target's live-target journal; requires explicit --extensions-dir and (--manifest-id or --stage-path only to resolve manifest.id)
  repair                    repair as CLI-only reapply over an already prepared stage; requires explicit --stage-path and --extensions-dir

Notes:
  - This CLI surface prepares an isolated, inspectable stage or installs an already prepared stage onto a live target.
  - ext stage github performs fetch+inspect as preflight only; it never reports the extension as installed.
  - ext apply installs only an already prepared stage into the real extensions directory, requires explicit --extensions-dir, and may trigger live-target setup if the stage contract requires it.
  - ext apply accepts --python-exe, --allow-third-party, and --setup-payload-json to forward them to the live-target setup already supported by core.
  - if that live-target setup fails after copy/apply, the result may remain observable as applied_degraded.
  - ext setup runs ONLY a supported explicit contract; cataloged and limited support; does not promise universal compatibility; it requires explicit consent because it executes third-party code.
  - some extensions require explicit payload inputs, for example gpu_sm, and the CLI validates them when the known catalog declares them.
  - PIP_*-based network resilience may provide partial benefit or none if setup.py ignores those variables or performs its own downloads.
  - ext setup: python_exe and ext_dir are auto-injected by the CLI and the stage; the JSON payload must not try to override them.
  - ext setup-status reads ONLY the live-target journal reconciled from the installed target; --stage-path only helps resolve manifest.id.
  - ext setup-status --wait waits locally until an observable terminal journal state.
  - ext setup-status --follow follows the logPath of the most recent observable run locally.
  - ext setup-status --timeout-ms only cuts off CLI wait/follow; it does NOT kill or cancel the underlying setup.
  - ext setup-status does NOT reattach, does NOT cancel, and is NOT a general job manager; no background manager, reattach, or general-purpose resume.
  - ext repair reapplies only an already prepared stage to the real extensions directory.
  - ext repair accepts --python-exe, --allow-third-party, and --setup-payload-json to forward them to live-target setup when the stage requires it.
  - ext repair may trigger live-target setup if the stage requires it.
  - ext repair uses reapply mode over an already prepared stage and by default no longer creates a backup when the target exists.
  - Does NOT perform GitHub fetch, install, build, or general health-fix.
  - The CLI/MCP helps distinguish seam failure vs the extension's own failure, but third-party extensions may still fail because of setup.py, wheels, ABI, or Linux ARM64 limits.
  - On Linux ARM64, some heavy extensions may require CPU fallback or patches in the extension itself; the CLI cannot invent a nonexistent wheel.
  - Does not expose a stable MCP capability or perform headless install/apply from GitHub.
`;
}

export function renderExtDevHelp() {
  return `modly ext-dev — observable planning CLI surface

Usage:
  modly ext-dev bucket-detect [--api-url <url>] [--json]
  modly ext-dev preflight [--api-url <url>] [--json]
  modly ext-dev scaffold [--api-url <url>] [--json]
  modly ext-dev audit [--api-url <url>] [--json]
  modly ext-dev release-plan [--api-url <url>] [--json]

Summary:
  bucket-detect | preflight | scaffold | audit | release-plan

Available subcommands:
  bucket-detect              Plan-only; visible contractual surface
  preflight                  Plan-only; local validation with optional /health check
  scaffold                   Plan-only; non-executable implementation plan by bucket
  audit                      Plan-only; gaps/risks with optional bridge confirmation
  release-plan               Plan-only; ordered release and documentation checklist
`;
}

export function renderConfigHelp() {
  return `modly config — backend runtime configuration

Usage:
  modly config paths get [--api-url <url>] [--json]
  modly config paths set [--models-dir <dir>] [--workspace-dir <dir>] [--api-url <url>] [--json]
  modly config launcher locate [--json]
  modly config launcher open [--foreground] [--json]

Available subcommands:
  paths get                 Reads current runtime paths
  paths set                 Updates runtime paths (NOT persistent)
  launcher locate           Locates valid Modly launch.sh/launch.bat files
  launcher open             Opens the resolved launcher (background by default; --foreground keeps it in the foreground)
`;
}
