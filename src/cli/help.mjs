export function renderHelp() {
  return `modly — CLI headless para Modly

Uso:
  modly [--api-url <url>] [--json] <grupo> <subcomando>
  modly health [--api-url <url>] [--json]

Grupos disponibles:
  health                    Verifica GET /health
  model <subcomando>        list | current | params | switch | unload-all | download
  generate <subcomando>     from-image
  job <subcomando>          status | wait | cancel
  workflow-run <subcomando> from-image | status | cancel
  mesh <subcomando>         optimize | smooth | export
  ext <subcomando>          reload | errors
  config <subcomando>       paths get | paths set

Flags globales:
  --api-url <url>           Sobrescribe MODLY_API_URL
  --json                    Emite envelope JSON
  -h, --help                Muestra esta ayuda

Estado del bootstrap:
  - health, model, job, workflow-run, generate from-image, mesh, ext y config ya son funcionales
  - MCP real sigue diferido
`;
}

export function renderModelHelp() {
  return `modly model — operaciones de modelos

Uso:
  modly model list [--api-url <url>] [--json]
  modly model current [--api-url <url>] [--json]
  modly model params <model-id> [--api-url <url>] [--json]
  modly model switch <model-id> [--api-url <url>] [--json]
  modly model unload-all [--api-url <url>] [--json]
  modly model download --repo-id <hf-repo> --model-id <model-id> [--skip-prefix <prefix> ...] [--api-url <url>] [--json]

Subcomandos disponibles:
  list                      Lista modelos conocidos
  current                   Muestra el modelo activo
  params <model-id>         Devuelve parámetros del modelo
  switch <model-id>         Cambia el modelo activo
  unload-all                Descarga todos los modelos cargados
  download                  Descarga archivos de un modelo vía backend/SSE
`;
}

export function renderJobHelp() {
  return `modly job — operaciones sobre jobs de generación

Uso:
  modly job status <job-id> [--api-url <url>] [--json]
  modly job wait <job-id> [--interval-ms <n>] [--timeout-ms <n>] [--api-url <url>] [--json]
  modly job cancel <job-id> [--api-url <url>] [--json]

Subcomandos disponibles:
  status <job-id>            Muestra el estado actual de un job
  wait <job-id>              Hace polling hasta done, error o cancelled
  cancel <job-id>            Solicita la cancelación del job
`;
}

export function renderGenerateHelp() {
  return `modly generate — generación headless

Uso:
  modly generate from-image --image <path> --model <id> [--collection <name>] [--remesh quad|triangle|none] [--texture] [--texture-resolution <n>] [--params-json '<json>'] [--wait] [--api-url <url>] [--json]

Subcomandos disponibles:
  from-image                 Crea un job de generación desde una imagen
`;
}

export function renderWorkflowRunHelp() {
  return `modly workflow-run — runs headless desde imagen

Uso:
  modly workflow-run from-image --image <path> --model <id> [--params-json '{...}'] [--api-url <url>] [--json]
  modly workflow-run status <run-id> [--api-url <url>] [--json]
  modly workflow-run cancel <run-id> [--api-url <url>] [--json]

Subcomandos disponibles:
  from-image                Crea un workflow run desde una imagen
  status <run-id>           Muestra el estado actual del run
  cancel <run-id>           Solicita la cancelación del run
`;
}

export function renderMeshHelp() {
  return `modly mesh — operaciones de malla en workspace

Uso:
  modly mesh optimize --path <workspace-relative-path> --target-faces <n> [--api-url <url>] [--json]
  modly mesh smooth --path <workspace-relative-path> --iterations <n> [--api-url <url>] [--json]
  modly mesh export --path <workspace-relative-path> --format glb|obj|stl|ply [--out <file>] [--api-url <url>] [--json]

Subcomandos disponibles:
  optimize                   Decima una malla a un número objetivo de caras
  smooth                     Aplica smoothing Laplaciano
  export                     Descarga una malla exportada a un archivo local
`;
}

export function renderExtHelp() {
  return `modly ext — operaciones de extensiones

Uso:
  modly ext reload [--api-url <url>] [--json]
  modly ext errors [--api-url <url>] [--json]

Subcomandos disponibles:
  reload                    Recarga el registro de extensiones
  errors                    Muestra errores capturados al cargar extensiones
`;
}

export function renderConfigHelp() {
  return `modly config — configuración runtime del backend

Uso:
  modly config paths get [--api-url <url>] [--json]
  modly config paths set [--models-dir <dir>] [--workspace-dir <dir>] [--api-url <url>] [--json]

Subcomandos disponibles:
  paths get                 Lee rutas runtime actuales
  paths set                 Actualiza rutas runtime (NO persistente)
`;
}
