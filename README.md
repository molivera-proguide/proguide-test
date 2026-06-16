# ProGuide Test

ProGuide Test es una herramienta local-first para QA E2E. Recibe casos de prueba en Markdown desde CLI o MCP, genera tests con pytest + Playwright, los ejecuta contra una app real y muestra resultados, evidencias y codigo generado en un viewer local.

## Requisitos

- Node.js 20 o superior.
- Python 3.12 o compatible disponible en la maquina.
- Una API key para el proveedor LLM configurado por ProGuide.

ProGuide crea y mantiene su propio runtime Python en el perfil del usuario. No hace falta instalar manualmente `pytest`, `pytest-xdist`, `playwright` ni browsers.

## Instalacion

Si el paquete esta publicado en npm:

```bash
npm install -g @proguide/test
```

Si se instala desde un release `.tgz`:

```bash
npm install -g ./proguide-test-0.1.14.tgz
```

Verifica la instalacion desde el workspace de la app que vas a testear:

```bash
proguide doctor --json
```

## Uso Basico

Ejecuta ProGuide desde la raiz del proyecto o app bajo prueba.

Crear un run desde Markdown sin ejecutarlo:

```bash
proguide create casos.md --base-url http://localhost:3000 --json
```

Crear y ejecutar un run:

```bash
proguide run casos.md --base-url http://localhost:3000 --json
```

Comandos utiles:

```bash
proguide execute <run_id> --json
proguide get-run <run_id> --json
proguide get-code <run_id> <case_id> --json
proguide list-runs --limit 20 --json
proguide viewer --json
```

La respuesta incluye `run_url` para abrir el viewer local con estado, resultados, evidencias y codigo generado.

## MCP En Claude Code

Registra ProGuide como MCP server desde el workspace de la app que vas a testear:

```bash
claude mcp add proguide-test --env API_KEY=your_api_key -- proguide mcp
```

Si no queres instalarlo globalmente y el paquete esta disponible en npm:

```bash
claude mcp add proguide-test --env API_KEY=your_api_key -- npx @proguide/test@latest mcp
```

Luego podes pedirle a Claude Code algo como:

```text
Usa ProGuide para crear un run desde estos casos Markdown, ejecutarlo contra http://localhost:3000 y devolverme el run_url.
```

## MCP En Cursor

Crea `.cursor/mcp.json` en el workspace de la app bajo prueba:

```json
{
  "mcpServers": {
    "proguide-test": {
      "command": "proguide",
      "args": ["mcp"],
      "env": {
        "API_KEY": "your_api_key"
      }
    }
  }
}
```

Si Cursor o tu cliente MCP tiene un secret store, usa ese mecanismo en lugar de guardar la key en el repositorio.

## Skill Y Template QA

Este repositorio incluye instrucciones reutilizables para agentes:

- `skills/SKILL.md`: define el flujo QA para explorar la app, escribir casos, hacer dry-run, ejecutar e iterar con evidencia.
- `skills/TEMPLATE.md`: contiene la plantilla, checklist y ejemplo de caso Markdown compatible con ProGuide.

### Usarlo En Claude Code

Para instalarlo como project skill en el workspace de la app bajo prueba:

```powershell
$proguideRepo = "C:\ruta\a\proguide-test"
New-Item -ItemType Directory -Force .claude\skills\qa-test-cases | Out-Null
Copy-Item "$proguideRepo\skills\SKILL.md" .claude\skills\qa-test-cases\SKILL.md
Copy-Item "$proguideRepo\skills\TEMPLATE.md" .claude\skills\qa-test-cases\TEMPLATE.md
```

Luego invocalo desde Claude Code:

```text
/qa-test-cases
Genera casos E2E para http://localhost:3000, validalos con dry-run y ejecutalos con ProGuide.
```

Claude Code tambien puede activar la skill automaticamente cuando el pedido coincide con su descripcion, por ejemplo al pedir crear o ejecutar casos QA/E2E.

### Usarlo En Cursor

Cursor no carga `SKILL.md` como skill de Claude Code. Para usar las mismas reglas, copialas como Project Rule:

```powershell
$proguideRepo = "C:\ruta\a\proguide-test"
New-Item -ItemType Directory -Force .cursor\rules | Out-Null
Copy-Item "$proguideRepo\skills\SKILL.md" .cursor\rules\proguide-qa-test-cases.mdc
Copy-Item "$proguideRepo\skills\TEMPLATE.md" .cursor\rules\TEMPLATE.md
```

En Cursor, pedi explicitamente que use esa rule y el MCP:

```text
Usa la rule proguide-qa-test-cases y el MCP proguide-test para generar casos con TEMPLATE.md, hacer dry-run, ejecutar contra http://localhost:3000 y devolverme el run_url.
```

## Herramientas MCP Principales

- `run_cases`: crea y ejecuta un run desde casos estructurados o Markdown.
- `create_run`: crea un run sin ejecutarlo.
- `execute_run`: ejecuta un run existente.
- `get_run`: lee estado, casos, eventos y resumen.
- `get_generated_code`: lee el codigo generado para un caso.
- `list_runs`: lista runs locales.
- `start_viewer`: inicia o reutiliza el viewer local.
- `stop_viewer`: detiene viewers de ProGuide para el workspace actual.

El viewer local usa por defecto `http://127.0.0.1:8787/runs`. Si el puerto esta ocupado, ProGuide intenta otros puertos automaticamente.
