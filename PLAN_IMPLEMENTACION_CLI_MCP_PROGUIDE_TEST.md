# Plan de implementacion - ProGuide Test

## 1. Objetivo

ProGuide Test debe permitir que un QA use Codex, Claude Code, Cursor, Copilot u otro agente para generar casos de prueba y ejecutarlos contra una aplicacion real sin tener que copiar archivos manualmente ni operar una UI de carga.

La herramienta se distribuira como una CLI local. Esa CLI expondra comandos pensados para humanos y agentes, y tambien podra levantar un servidor MCP para integraciones nativas.

El resultado visible para el QA sera un visor web local que muestra la ejecucion, estado de los tests, codigo Python Playwright generado, evidencia y resultado final.

## 2. Decision de arquitectura

La arquitectura objetivo queda asi:

```text
Agente IA
  | genera casos de prueba en Markdown
  |
  | opcion A: CLI
  v
proguide run --stdin --base-url ... --json

  | opcion B: MCP
  v
proguide mcp
  |
  v
ProGuide Core
  | parsea casos Markdown aprobados por QA
  | genera codigo Python Playwright con LLM
  | ejecuta pytest/Playwright
  | persiste eventos, resultados y evidencia
  |
  v
Visor Fastify local
  http://127.0.0.1:8787/runs/<run_id>
```

Principio clave: la CLI no debe duplicar logica de negocio. La CLI solo distribuye, arranca y orquesta. La logica real vive en el core compartido.

## 3. Alcance

Incluido:

- CLI instalable localmente.
- Comandos no interactivos con salida JSON estable.
- Soporte para recibir Markdown por archivo o por stdin.
- MCP local por stdio, arrancado por la CLI.
- Visor Fastify local para runs y resultados.
- Arranque automatico o reutilizacion del visor desde CLI/MCP.
- Generacion de codigo Python Playwright desde casos QA ya definidos.
- Ejecucion con pytest/Playwright.
- Consulta de estado, resultados, codigo generado y artefactos.
- Comando de diagnostico local.
- Configuracion de provider/modelo/API key.

No incluido en esta etapa:

- Pantalla principal de carga de Markdown.
- Pantalla `/preview` editable.
- Generacion de casos de prueba desde PRD dentro de ProGuide.
- App Electron.
- Backend cloud multiusuario.
- Scheduler remoto de ejecuciones.
- Autenticacion centralizada.

## 4. Flujo de usuario objetivo

### 4.1 Flujo con CLI pura

El QA le pide al agente:

```text
Genera los casos de prueba para esta feature y ejecutalos con ProGuide Test contra http://localhost:3000.
```

El agente genera Markdown y ejecuta:

```bash
proguide run --base-url http://localhost:3000 --stdin --json <<'MD'
## Caso 1 - Login exitoso

Criticidad: alta
Descripcion: Valida que un usuario con credenciales correctas pueda iniciar sesion.

Pasos:
- Abrir /login
- Completar usuario y password validos
- Enviar el formulario

Resultado esperado:
- Se muestra el dashboard
MD
```

La CLI devuelve JSON:

```json
{
  "run_id": "2026-06-08_12-00-00",
  "status": "running",
  "viewer_url": "http://127.0.0.1:8787/runs",
  "run_url": "http://127.0.0.1:8787/runs/2026-06-08_12-00-00"
}
```

El QA abre `run_url` y ve la ejecucion.

### 4.2 Flujo con MCP

El QA configura Claude Code, Cursor o un cliente MCP para ejecutar:

```bash
proguide mcp
```

El agente llama tools:

```text
create_run_from_markdown
execute_run
get_run
get_generated_code
```

Flujo recomendado para ver ejecucion en vivo:

```text
create_run_from_markdown -> devuelve run_url
execute_run              -> ejecuta y actualiza el run
get_run                  -> consulta estado final
```

Tambien se mantiene una tool de una sola llamada:

```text
run_markdown_cases -> crea, genera codigo, ejecuta y devuelve resultado
```

## 5. Distribucion

### 5.1 Paquete recomendado

Publicar como paquete npm:

```bash
npm install -g @proguide/test
```

El paquete debe exponer el binario:

```bash
proguide
```

Motivo:

- Node ya existe en la implementacion actual del MCP y visor Fastify.
- Facilita distribuir CLI, MCP y visor en un unico paquete.
- Es compatible con Claude Code/Cursor/Copilot cuando llaman comandos locales.
- Permite publicar updates sin empaquetar una app desktop.

### 5.2 Electron

Electron queda diferido.

Solo conviene si mas adelante necesitamos:

- onboarding visual,
- configuracion grafica,
- actualizaciones automaticas,
- login centralizado,
- historial visual persistente,
- experiencia desktop cerrada.

Electron no reemplaza al MCP. Aunque exista una app desktop, los agentes seguirian necesitando una interfaz de ejecucion: CLI, MCP o HTTP local.

## 6. Estructura tecnica objetivo

Etapa inicial dentro del repo actual:

```text
ui/
  server.js            visor Fastify
  mcp-server.js        servidor MCP stdio
  proguide-service.js  core actual de runs/generacion/ejecucion
  cli.js               nuevo entrypoint CLI
```

Etapa de producto:

```text
packages/
  core/
    index.js
    runs.js
    markdown.js
    codegen.js
    executor.js
    config.js

  viewer/
    server.js
    assets/

  mcp/
    server.js

  cli/
    bin/proguide.js
    commands/
```

Para el MVP no hace falta separar monorepo todavia. Primero conviene agregar `ui/cli.js` y luego extraer paquetes cuando el contrato este estable.

## 7. Comandos CLI

### 7.1 `proguide run`

Crea un run desde Markdown, genera codigo, ejecuta tests y devuelve resultado.

Archivo:

```bash
proguide run casos.md --base-url http://localhost:3000 --json
```

Stdin:

```bash
proguide run --stdin --base-url http://localhost:3000 --json
```

Opciones:

```text
--base-url <url>       URL base de la app bajo prueba
--stdin                leer Markdown desde stdin
--json                 salida JSON estable
--root <path>          workspace root
--email <value>        credencial opcional
--username <value>     credencial opcional
--password <value>     credencial opcional
--no-viewer            no levantar visor automaticamente
```

Salida JSON minima:

```json
{
  "run_id": "string",
  "status": "passed|failed|running|ready|error",
  "viewer_url": "string",
  "run_url": "string",
  "summary": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "blocked": 0
  }
}
```

Exit codes:

```text
0  tests ejecutados y sin fallos
1  tests ejecutados con fallos
2  error de configuracion
3  error de generacion de codigo
4  error de ejecucion/pytest
5  entrada invalida
```

### 7.2 `proguide create`

Crea un run desde Markdown sin ejecutar.

```bash
proguide create casos.md --base-url http://localhost:3000 --json
proguide create --stdin --base-url http://localhost:3000 --json
```

Uso principal: permitir que el agente obtenga `run_url` antes de ejecutar.

Salida:

```json
{
  "run_id": "string",
  "status": "ready",
  "viewer_url": "string",
  "run_url": "string",
  "cases": []
}
```

### 7.3 `proguide execute`

Ejecuta un run existente.

```bash
proguide execute <run_id> --json
```

Opciones:

```text
--base-url <url>
--email <value>
--username <value>
--password <value>
--no-viewer
```

### 7.4 `proguide get-run`

Consulta estado completo de un run.

```bash
proguide get-run <run_id> --json
```

### 7.5 `proguide get-code`

Devuelve el codigo Python generado para un caso.

```bash
proguide get-code <run_id> <case_id> --json
```

### 7.6 `proguide list-runs`

Lista runs locales.

```bash
proguide list-runs --limit 20 --json
```

### 7.7 `proguide viewer`

Levanta o reutiliza el visor Fastify.

```bash
proguide viewer
proguide viewer --port 8787 --json
```

Salida JSON:

```json
{
  "viewer_url": "http://127.0.0.1:8787/runs",
  "port": 8787,
  "started": true
}
```

### 7.8 `proguide mcp`

Levanta el servidor MCP por stdio.

```bash
proguide mcp
```

Este comando es el que configuraran Claude Code/Cursor/Copilot.

Ejemplo Claude Code:

```bash
claude mcp add --scope user --transport stdio proguide-test -- proguide mcp
```

### 7.9 `proguide doctor`

Valida instalacion local.

```bash
proguide doctor --json
```

Checks:

- Node disponible.
- Python disponible.
- pytest disponible.
- Playwright Python disponible.
- browsers de Playwright instalados.
- API key configurada si el provider requiere LLM.
- puerto del visor disponible o reutilizable.
- permisos de escritura en `proguide_tests/runs`.

### 7.10 `proguide config`

Lee y escribe configuracion.

```bash
proguide config get --json
proguide config set llm.provider anthropic
proguide config set llm.model claude-3-5-haiku-latest
```

No debe guardar secretos en texto plano salvo decision explicita. Para MVP, las API keys se leen desde variables de entorno.

## 8. Contrato MCP

El MCP debe seguir siendo un wrapper fino sobre el core.

Tools:

```text
create_run_from_markdown
run_markdown_cases
execute_run
get_run
get_generated_code
list_runs
```

Todas las tools que creen o ejecuten runs deben devolver:

```json
{
  "run_id": "string",
  "viewer_url": "http://127.0.0.1:8787/runs",
  "run_url": "http://127.0.0.1:8787/runs/<run_id>",
  "events_url": "http://127.0.0.1:8787/runs/<run_id>/events"
}
```

Regla de diseno:

- MCP no debe depender de que el visor ya este levantado.
- MCP debe levantar o reutilizar el visor automaticamente.
- Si el visor falla, la ejecucion no debe bloquearse; debe devolver `viewer_error`.

## 9. Visor Fastify

El visor no es una pantalla de carga ni de preview.

Rutas:

```text
GET /                  redirige a /runs
GET /runs             lista ejecuciones
GET /runs/:runId      detalle de ejecucion
GET /runs/:runId/cases/:caseId
GET /runs/:runId/events
GET /artifacts/:runId/*
GET /api/health
GET /api/runs/:runId
```

Las rutas antiguas de preview deben quedar deshabilitadas o redirigidas:

```text
GET /preview                 redirige a /runs
GET /runs/:runId/preview     redirige a /runs/:runId
POST /runs/prepare           410
POST /api/runs/:runId/cases  410
POST /api/runs/:runId/execute 410
```

Vista de detalle del run:

- estado global,
- cantidad total,
- passed,
- failed,
- blocked/inconclusive,
- tabla de casos,
- criticidad,
- estado por caso,
- mensaje de fallo,
- links de evidencia,
- codigo Python generado.

## 10. Modelo de datos local

Mantener estructura:

```text
proguide_tests/
  runs/
    <run_id>/
      run.json
      source.md
      normalized_cases.json
      test_plan.json
      events.jsonl
      results.json
      generated/
        test_markdown_cases.py
        manifest.json
      artifacts/
        ...
```

`run.json`:

```json
{
  "id": "string",
  "created_at": "iso",
  "started_at": "iso|null",
  "finished_at": "iso|null",
  "status": "ready|running|passed|failed|error",
  "base_url": "string",
  "source_filename": "string",
  "total_cases": 0,
  "passed": 0,
  "failed": 0,
  "blocked": 0,
  "data_dir": "string"
}
```

`normalized_cases.json`:

```json
[
  {
    "id": "string",
    "number": 1,
    "title": "string",
    "description": "string",
    "priority": "baja|media|alta|critica",
    "original_steps": [],
    "expected_results": [],
    "automation_state": "listo|necesita_revision|no_automatizable_aun"
  }
]
```

`results.json`:

```json
{
  "run_id": "string",
  "status": "passed|failed|error",
  "results": [
    {
      "id": "case_id",
      "title": "string",
      "status": "passed|failed|blocked",
      "message": "string",
      "duration_seconds": 0,
      "screenshots": [],
      "videos": [],
      "traces": []
    }
  ]
}
```

## 11. Generacion de codigo

Entrada:

- casos Markdown ya creados por QA/agente,
- URL base,
- credenciales opcionales,
- configuracion LLM.

Salida:

- archivos Python pytest + Playwright bajo `generated/`,
- manifest con mapeo de `case_id -> file/function`,
- tests con marca `@pytest.mark.proguide_case("<case_id>")`.

Reglas:

- no crear casos nuevos,
- no renombrar casos,
- no fusionar casos,
- no eliminar casos,
- un pytest function por caso,
- usar fixtures existentes,
- usar locators robustos,
- registrar steps con `proguide_steps`,
- generar assertions explicitas,
- no imprimir secretos.

## 12. Configuracion LLM

Archivo:

```text
proguide_tests/config.yaml
```

Shape:

```yaml
llm:
  provider: openai
  model: gpt-4.1-nano
  temperature: 0.2
  max_cases: 12
  max_context_chars: 50000
  max_output_tokens: 8000
```

Providers:

```text
openai     usa OPENAI_API_KEY
anthropic  usa ANTHROPIC_API_KEY
disabled   error explicito al intentar generar codigo
```

Para costos:

- usar modelo barato para generacion de codigo cuando sea suficiente,
- evitar usar LLM para parsear Markdown si el formato es estructurado,
- cachear codigo generado por hash de casos/config,
- no regenerar si el run ya tiene codigo valido,
- limitar cantidad de casos por batch.

## 13. Seguridad

Requisitos:

- No persistir passwords en `run.json`, `source.md`, `events.jsonl` ni reportes.
- Enmascarar lineas tipo password/token/secret.
- Pasar credenciales al runner por variables de entorno.
- No exponer visor en `0.0.0.0` por defecto.
- Validar que rutas de `source_path` esten dentro del root.
- Validar `run_id` y `case_id` con caracteres seguros.
- Evitar path traversal en `/artifacts`.

Variables:

```text
PROGUIDE_UI_HOST
PROGUIDE_UI_PORT
PROGUIDE_VIEWER_HOST
PROGUIDE_VIEWER_PORT
PROGUIDE_MCP_ROOT
PROGUIDE_UI_ROOT
PROGUIDE_PYTHON
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

## 14. Implementacion por fases

### Fase 1 - CLI MVP

Objetivo: poder usar ProGuide sin MCP, como `gh`.

Tareas:

- Crear `ui/cli.js`.
- Agregar binario local en `ui/package.json`.
- Implementar parser de argumentos sin dependencias pesadas.
- Implementar `run`, `create`, `execute`, `get-run`, `get-code`, `list-runs`, `viewer`, `doctor`.
- Soportar `--json`.
- Soportar `--stdin`.
- Reutilizar `proguide-service.js`.
- Reutilizar arranque de visor que ya existe en MCP.

Criterio de aceptacion:

```bash
proguide create --stdin --base-url http://localhost:3000 --json
proguide execute <run_id> --json
proguide get-run <run_id> --json
```

devuelven JSON estable y `run_url`.

### Fase 2 - MCP sobre CLI/Core

Objetivo: mantener MCP como integracion nativa.

Tareas:

- Mantener `ui/mcp-server.js`.
- Alinear outputs MCP con outputs CLI.
- Asegurar que las tools devuelven `viewer_url`, `run_url`, `events_url`.
- Documentar configuracion Claude Code/Cursor.
- Agregar smoke tests JSON-RPC.

Criterio de aceptacion:

```bash
claude mcp add --scope user --transport stdio proguide-test -- proguide mcp
```

El agente puede crear run, ejecutar y consultar resultados.

### Fase 3 - Packaging local

Objetivo: instalar con un comando.

Tareas:

- Definir nombre de paquete `@proguide/test`.
- Agregar `bin.proguide`.
- Revisar dependencias runtime.
- Excluir `node_modules`, runs y caches del paquete.
- Agregar README de instalacion.
- Probar instalacion global local con `npm pack`.

Criterio de aceptacion:

```bash
npm install -g ./proguide-test-*.tgz
proguide doctor --json
proguide mcp
```

funcionan en una maquina limpia con prerequisitos.

### Fase 4 - Diagnostico y configuracion

Objetivo: reducir soporte manual.

Tareas:

- Completar `proguide doctor`.
- Detectar Python.
- Detectar pytest.
- Detectar Playwright.
- Detectar browsers instalados.
- Detectar API key.
- Detectar puerto del visor.
- Sugerir comandos correctivos.
- Implementar `proguide config get/set`.

Criterio de aceptacion:

`proguide doctor --json` devuelve checks accionables y exit code `0` o `2`.

### Fase 5 - Tests automatizados

Objetivo: estabilizar contratos.

Tareas:

- Tests unitarios del parser Markdown.
- Tests de comandos CLI con stdin.
- Tests de salida JSON.
- Tests MCP JSON-RPC.
- Tests de arranque/reutilizacion del visor.
- Tests de seguridad de paths.

Criterio de aceptacion:

Suite local pasa sin llamar LLM real ni ejecutar navegador salvo tests marcados como integracion.

### Fase 6 - Mejoras de producto

Objetivo: preparar demo/producto.

Tareas:

- Mejorar tabla de runs.
- Mostrar progreso por SSE en detalle.
- Mostrar codigo Python por caso.
- Mostrar evidencia embebida.
- Agregar boton/copiar comando de re-ejecucion.
- Agregar filtros por estado/criticidad.
- Agregar link directo a reporte HTML/PDF si existe.

Criterio de aceptacion:

El QA puede abrir `run_url` desde el inicio y entender avance, fallos y evidencia sin terminal.

## 15. Cambios inmediatos recomendados

Prioridad alta:

1. Crear `ui/cli.js`.
2. Extraer `ensureViewer` desde `mcp-server.js` a un helper compartido.
3. Agregar comandos `create`, `execute`, `run`, `viewer`.
4. Agregar `--stdin` y `--json`.
5. Agregar smoke tests de CLI.

Prioridad media:

6. Agregar `doctor`.
7. Agregar `config`.
8. Agregar packaging `bin.proguide`.
9. Documentar instalacion en Claude Code/Cursor.

Prioridad baja:

10. Electron.
11. Backend remoto.
12. Runners cloud.

## 16. Riesgos

### 16.1 Entornos locales inconsistentes

Riesgo: cada QA puede tener distinta version de Python, Node o Playwright.

Mitigacion:

- `proguide doctor`,
- instalador documentado,
- mensajes de error accionables,
- opcion futura con runner containerizado.

### 16.2 Costos de LLM

Riesgo: regenerar codigo para los mismos casos consume tokens.

Mitigacion:

- cache por hash,
- no usar LLM para parseo deterministicamente soportado,
- batching,
- modelos baratos por defecto,
- permitir provider/modelo configurable.

### 16.3 Apps locales inaccesibles

Riesgo: un backend remoto no puede acceder a `localhost` del QA.

Mitigacion:

- mantener runner local como camino principal,
- diferir cloud hasta tener tunneling o runners por ambiente.

### 16.4 Agentes sin terminal

Riesgo: algunos clientes no pueden ejecutar CLI directamente.

Mitigacion:

- MCP local,
- documentacion por cliente,
- en el futuro servidor HTTP local.

## 17. Criterios de exito MVP

El MVP esta listo cuando:

- un QA instala `proguide`,
- configura Claude Code con `proguide mcp`,
- le pide a Claude que genere y ejecute casos,
- Claude pasa el Markdown a ProGuide sin archivo manual,
- ProGuide devuelve `run_url`,
- el visor muestra ejecucion y resultado,
- se puede ver el codigo Python generado,
- se puede consultar resultado por CLI JSON,
- no hay pantallas de preview ni carga manual en el visor.

## 18. Comandos esperados al final del MVP

Instalacion:

```bash
npm install -g @proguide/test
```

Validacion:

```bash
proguide doctor
```

Uso CLI:

```bash
proguide run casos.md --base-url http://localhost:3000 --json
proguide run --stdin --base-url http://localhost:3000 --json
```

Uso MCP:

```bash
claude mcp add --scope user --transport stdio proguide-test -- proguide mcp
```

Visor:

```bash
proguide viewer
```

URL:

```text
http://127.0.0.1:8787/runs
```

## 19. Estado actual del repo

Ya existe:

- `ui/server.js` como visor Fastify.
- `ui/mcp-server.js` como MCP stdio.
- `ui/proguide-service.js` como core actual.
- herramientas MCP para crear, ejecutar y consultar runs.
- arranque/reutilizacion de visor desde MCP.
- `/api/health` en el visor.
- redireccion de `/preview` a `/runs`.

Falta:

- CLI nueva como entrypoint principal.
- comandos JSON para agentes.
- stdin support por CLI.
- packaging npm con binario `proguide`.
- `doctor`.
- tests especificos de CLI/MCP.
