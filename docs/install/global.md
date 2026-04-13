# Instalación global para OpenCode

Usa esta guía cuando quieras que OpenCode invoque `modly-mcp` desde `PATH`.

## Qué sí está soportado

- `modly` y `modly-mcp` como bins instalados del paquete `modly-cli-mcp`.
- Un `opencode.json` que invoque directamente `modly-mcp`.

## Qué NO está soportado

- Apuntar OpenCode al checkout fuente de `modly_CLI_MCP`.
- Configurar comandos tipo `node /ruta/al/checkout/src/mcp/server.mjs`.
- Inventar soporte headless adicional fuera de los bins reales del paquete.

## Instalar el paquete

Instálalo globalmente desde TU canal de distribución válido del paquete (por ejemplo, registry privada o artefacto `.tgz`). El nombre del paquete es `modly-cli-mcp` y los bins publicados son `modly` y `modly-mcp`.

Ejemplo con npm:

```bash
npm install -g modly-cli-mcp
```

Si tu equipo distribuye un tarball del paquete, usa el archivo `.tgz` correspondiente en lugar del nombre de registry.

## Verificar bins instalados

```bash
modly --help
modly-mcp --help
```

## Verificar backend antes de operar

Antes de ejecutar operaciones de negocio desde CLI/MCP, valida que el backend responde en `GET /health`. No asumas readiness.

Ejemplo:

```bash
modly health --json --api-url http://127.0.0.1:8765
```

## `opencode.json` canónico

Copia el template canónico o replica este contenido:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modly": {
      "type": "local",
      "enabled": true,
      "timeout": 30000,
      "command": ["modly-mcp"]
    }
  }
}
```

Template incluido en el paquete:

- [`templates/opencode/opencode.json`](../../templates/opencode/opencode.json)

## Notas operativas

- `modly-mcp` es el bin soportado para stdio MCP.
- OpenCode usa la clave raíz `mcp`, NO `mcpServers`.
- El campo `command` debe ser un array JSON, incluso cuando sólo hay un bin.
- Si necesitas configuración adicional del sistema, resuélvela en el entorno donde vive el bin global.
- El repo consumidor NO debe apuntar al checkout fuente de `modly_CLI_MCP`; debe usar un paquete instalado disponible en `PATH`.
- Si prefieres que cada repo controle su propia instalación, usa la guía repo-local en [`docs/install/repo-local.md`](./repo-local.md).
