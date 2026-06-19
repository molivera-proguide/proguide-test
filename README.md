# ProGuide Test

ProGuide Test es una herramienta local-first para QA E2E. Recibe casos de prueba en Markdown desde CLI o MCP, genera tests TypeScript con Playwright Test, los ejecuta contra una app real y muestra resultados, evidencias y codigo generado en un viewer local.

## Requisitos

- Node.js 20 o superior.
- Una API key de Anthropic/Claude para generar los tests.

ProGuide trae `@playwright/test` como dependencia npm. En la primera validacion o ejecucion puede instalar Chromium de Playwright automaticamente.

## Instalacion

Si el paquete esta publicado en npm:

```bash
npm install -g @proguide/test
```

Si se instala desde un release `.tgz`:

```bash
npm install -g ./proguide-test-0.2.0-ts.6.tgz
```

Tambien podes instalar directo desde GitHub Releases:

```bash
npm install -g https://github.com/molivera-proguide/proguide-test/releases/download/v0.2.0-ts.6/proguide-test-0.2.0-ts.6.tgz
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

## Casos E2E Para API REST

ProGuide puede ejecutar casos REST con Playwright `request`. Para API, el camino mas
confiable es usar casos estructurados con `type: "api"`, `request`/`requests` y
`assertions`; no depende de DOM, Chromium ni del agente LLM.

En Markdown simple:

```markdown
## TC-API-001 Crear usuario

Tipo: API
Metodo: POST
Endpoint: /users
Headers:
- content-type: application/json
Body:
- name: Mario

Resultado esperado:
- Status 201
- body.name = Mario
- body.id existe
```

Como caso estructurado de una request:

```json
{
  "type": "api",
  "title": "Health",
  "request": { "method": "GET", "path": "/health", "expected_status": 200 },
  "assertions": [{ "path": "service", "equals": "sample-api" }]
}
```

Tambien se pueden usar credenciales pasadas por CLI/MCP sin escribir secretos literales
en el caso. `{{email}}`, `{{username}}` y `{{password}}` se resuelven desde los
argumentos `email`, `username` y `password` de MCP/CLI:

```json
{
  "type": "api",
  "title": "Login",
  "request": {
    "method": "POST",
    "path": "/login",
    "body": {
      "email": "{{email}}",
      "password": "{{password}}"
    },
    "expected_status": 200
  },
  "assertions": [{ "path": "access_token", "exists": true }]
}
```

Para flujos autenticados, usa `requests`: las requests corren en orden dentro del mismo
test. `captures` o `save` guarda valores de una respuesta y los siguientes pasos pueden
usar `{{variable}}` en headers, query, body o path.

```json
{
  "type": "api",
  "title": "Login y perfil autenticado",
  "requests": [
    {
      "id": "login",
      "method": "POST",
      "path": "/login",
      "body": {
        "email": "{{email}}",
        "password": "{{password}}"
      },
      "expected_status": 200,
      "assertions": [{ "path": "access_token", "exists": true }],
      "captures": { "access_token": "access_token" }
    },
    {
      "id": "profile",
      "method": "GET",
      "path": "/profile",
      "headers": { "authorization": "Bearer {{access_token}}" },
      "expected_status": 200,
      "assertions": [
        { "path": "email", "equals": "qa@example.test" },
        { "path": "roles", "isArray": true }
      ]
    }
  ]
}
```

Aserciones soportadas:

- `{ "status": 200 }` o `request.expected_status`.
- `{ "ok": true }`.
- `{ "header": "content-type", "contains": "application/json" }`.
- `{ "body_contains": "texto" }`.
- `{ "path": "id", "exists": true }`.
- `{ "path": "name", "equals": "Mario" }`.
- `{ "path": "items", "isArray": true }`.
- `{ "path": "items", "contains": "item_001" }`.
- `{ "path": "$", "isArray": true }` para respuestas cuyo body raiz es un array.

Los paths se leen desde el body JSON. Un path vacio o `$` representa el body completo,
por ejemplo `{ "path": "$", "isArray": true }` valida una respuesta raiz que es array.
Las aserciones no soportadas fallan durante la creacion del run para evitar falsos
verdes. No hay operadores numericos como `greater_than` ni `length`; si necesitas ese
tipo de regla, expresala con una asercion soportada o agrega una validacion especifica
al runner.

Cuando una asercion API falla, el resultado incluye `actual_response` con `status`,
`headers` y `body` reales de la respuesta para depurar sin reconstruir el fallo desde
el stack de Playwright. Si un caso API incluye `"debug": true`, ProGuide tambien guarda
el request resuelto en `actual_response.request`; usalo solo en entornos locales o con
datos no sensibles, porque puede incluir credenciales de prueba.

Cada request API ejecutado genera evidencia JSON en `api_evidence/<case_id>/`, con
request, response, assertions, captures y duracion. El viewer muestra esa evidencia en
un panel tipo Postman con el JSON pretty-print; el `evidence.html` tambien la incluye
para compartir resultados. Por defecto se redactan valores sensibles como
`authorization`, `cookie`, `password`, `token` y `api_key`; con `"debug": true` se guarda
el request completo para debugging local.

Los casos REST usan `base_url` igual que los UI, pero no necesitan contexto DOM ni Chromium.
Para endpoints que crean recursos (`register`, `orders`, `products`), usa datos
idempotentes: emails/nombres con sufijo dinamico, endpoints de cleanup o setup separado.
Una suite de regresion debe poder correrse dos veces sin fallar por datos ya existentes.

Para suites partidas por archivo, el MCP acepta `source_paths: ["auth.md", "items.md"]`
y los interpreta como un solo run. Para sumar casos a una regresion ya creada, pasa
`append_to_run: "<run_id>"` junto con `cases`, `source_path`, `source_paths` o `markdown`;
`run_cases` los agrega y ejecuta el run, mientras que `create_run` solo actualiza el
preview.

En MCP, el flujo recomendado usa dos tools: `create_run` para dry-run y `run_cases`
para ejecutar. `create_run_from_markdown` y `run_markdown_cases` se mantienen como
aliases compatibles, pero no son necesarios para flujos nuevos.

## MCP En Claude Code

Registra ProGuide como MCP server desde el workspace de la app que vas a testear:

```bash
claude mcp add proguide-test --env ANTHROPIC_API_KEY=your_api_key -- proguide mcp
```

Si no queres instalarlo globalmente y el paquete esta disponible en npm:

```bash
claude mcp add proguide-test --env ANTHROPIC_API_KEY=your_api_key -- npx @proguide/test@latest mcp
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
        "ANTHROPIC_API_KEY": "your_api_key"
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
