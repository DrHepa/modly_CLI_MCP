# Instalación repo-local para OpenCode

Usa esta guía cuando quieras que un repositorio consumidor controle su propia instalación de `modly-cli-mcp`.

## Contrato soportado

El repo consumidor debe tener:

- un `opencode.json`
- un wrapper local en `tools/modly_mcp/run_server.mjs`
- opcionalmente `tools/_tmp/modly_mcp/local.env`

El wrapper resuelve primero `node_modules/.bin/modly-mcp` del repo consumidor y, si no existe, cae a `modly-mcp` global en `PATH`.

## Qué NO está soportado

- Apuntar `opencode.json` al checkout fuente de `modly_CLI_MCP`.
- Ejecutar `node /ruta/al/checkout/src/mcp/server.mjs` desde el repo consumidor.
- Depender del `cwd` de OpenCode para encontrar bins o archivos de config.

## 1) Instalar el paquete en el repo consumidor

Ejemplo con npm:

```bash
npm install -D modly-cli-mcp
```

Si tu distribución interna usa un tarball, instala ese `.tgz` en lugar del nombre del registry.

## 2) Copiar el wrapper canónico

Copia este archivo del paquete a tu repo consumidor:

- origen: [`templates/opencode/run_server.mjs`](../../templates/opencode/run_server.mjs)
- destino: `tools/modly_mcp/run_server.mjs`

El script calcula el repo root desde `import.meta.url`, NO desde `cwd`.

## 3) Crear `opencode.json`

Configura OpenCode para invocar el wrapper local:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modly": {
      "type": "local",
      "enabled": true,
      "timeout": 30000,
      "command": [
        "node",
        "tools/modly_mcp/run_server.mjs"
      ]
    }
  }
}
```

Ese `opencode.json` vive en el repo consumidor. NO debe referenciar archivos dentro del checkout fuente de `modly_CLI_MCP`.

## 4) Configuración local opcional

Si el repo consumidor necesita variables sólo locales, crea este archivo opcional:

```text
tools/_tmp/modly_mcp/local.env
```

Formato mínimo soportado:

```dotenv
# comentarios y líneas vacías se ignoran
MODLY_API_URL=http://127.0.0.1:8765
```

Notas importantes:

- El wrapper usa parser mínimo propio; NO usa `dotenv`.
- Sólo acepta líneas `KEY=VALUE`.
- Mezcla esas variables sobre `process.env` únicamente para el child process.
- El archivo es opcional y local al repo consumidor.

## 5) Verificar resolución sin arrancar MCP

```bash
node tools/modly_mcp/run_server.mjs --check
```

`--check` sólo valida resolución/configuración y reporta si usaría modo `local` o `global`. NO llama `/health`, NO arranca el servidor MCP, NO instala nada y NO muta archivos.

## Cuándo usar global vs repo-local

- **Global**: más simple si un mismo entorno usa una única versión instalada en `PATH`.
- **Repo-local**: mejor si cada repo necesita fijar su propia versión del paquete.

Si quieres el flujo global, usa [`docs/install/global.md`](./global.md).
