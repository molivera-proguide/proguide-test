---
name: qa-test-cases
description: Genera y ejecuta casos de prueba E2E con el MCP proguide-test. Usar cuando el usuario pida crear, generar, escribir o ejecutar casos de prueba, test cases, pruebas funcionales o tests E2E. Aplica la plantilla estándar, las reglas de redacción y el flujo dry-run → ejecución → iteración.
---

# Generación de casos de prueba QA con ProGuide

Eres un asistente de QA. Tu objetivo es producir casos de prueba que el runner de ProGuide
(Playwright + LLM) pueda ejecutar de forma estable, idealmente en 1–2 iteraciones.

## Flujo de trabajo obligatorio

### Paso 0 — Contexto de la app o API
Los QA son transversales a proyectos de distintos clientes: a veces hay acceso al código
fuente y a veces no. **Para UI, la fuente de verdad es siempre la aplicación corriendo,
no el código.** Obtén el vocabulario real de la UI (textos literales de botones, labels,
placeholders) en este orden de preferencia.

**Si el objetivo es una API REST pura, salta exploración de UI/DOM/browser.** La fuente
de verdad es el contrato del endpoint: OpenAPI/Swagger, README, código backend,
colecciones HTTP, ejemplos `curl` o lo que indique el usuario. Si no hay contrato,
pregunta por método, path, payload, autenticación y respuesta esperada. Para API,
prefiere casos estructurados con `type: "api"`; el Markdown en lenguaje natural es
solo fallback.

1. **Explorar la app en vivo (funciona siempre, con o sin código).** Confirma con el
   usuario la URL base y que la app esté accesible. Si tienes herramientas de navegador
   disponibles (Claude in Chrome, chrome-devtools, preview), navega las pantallas bajo
   prueba y extrae del snapshot/árbol de accesibilidad los textos literales y atributos
   de los elementos que los pasos van a usar.
2. **Código fuente, solo si está disponible en el workspace.** Busca `data-testid`, `id`,
   placeholders y textos visibles de los componentes involucrados. Es un complemento,
   no un requisito.
3. **Preguntar al usuario.** Si no puedes explorar la app ni ver código, pide los textos
   literales de la UI (o capturas de pantalla) de las pantallas involucradas.
4. **Calibración como último recurso.** Si nada de lo anterior es viable, redacta un
   borrador con lo que el usuario describió y trata la primera ejecución como
   calibración: los errores del runner devuelven el árbol real de la página (ver Paso 4).

Nunca inventes textos de botones o campos: si no los conoces, consíguelos por alguna de
estas vías antes de dar los casos por definitivos.

### Paso 1 — Redactar los casos con la plantilla
Usa `TEMPLATE.md` de esta carpeta. Reglas de redacción **no negociables**:

- **Para API REST, usa casos estructurados antes que pasos UI.** Un caso simple usa
  `request` + `assertions`; un flujo autenticado usa `requests` secuenciales. No uses
  `click`, `fill`, `Route`, textos de botones ni arbol de accesibilidad para API.
- **Contrato API estructurado recomendado:**
  ```json
  {
    "type": "api",
    "title": "Login y perfil autenticado",
    "requests": [
      {
        "id": "login",
        "method": "POST",
        "path": "/login",
        "body": { "email": "{{email}}", "password": "{{password}}" },
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
        "assertions": [{ "path": "roles", "isArray": true }]
      }
    ]
  }
  ```
- **Variables API:** usa `captures` o `save` para guardar valores del body JSON o
  headers y reutilizarlos como `{{variable}}` en requests posteriores. Usa
  `{{email}}`, `{{username}}` y `{{password}}` solo para credenciales pasadas por
  CLI/MCP; no escribas secretos productivos literales.
- **Debug API:** si un fallo necesita confirmar el request real enviado, agrega
  `"debug": true` solo en entornos locales o con datos no sensibles. El resultado
  incluira `actual_response` y, con debug, tambien `actual_response.request`.
- **Suites API grandes:** si los casos estan repartidos en varios Markdown, usa
  `source_paths: ["auth.md", "orders.md"]`. Si ya existe un run de regresion y solo
  necesitas sumar casos, usa `append_to_run: "<run_id>"` con `cases`/`source_path`/
  `source_paths`/`markdown`.
- **Idempotencia API:** evita datos estaticos en endpoints que crean recursos
  (`register`, `create order`, `create product`). Usa emails/nombres con sufijo
  dinamico, endpoints de teardown/cleanup o separa setup del flujo principal. Un caso
  de regresion debe poder correr dos veces sin fallar por "already exists".
- **Aserciones API soportadas:** `status`/`expected_status`, `ok`, `header`,
  `body_contains`, y body path con `equals`, `exists`, `contains`, `isArray`.
  Ejemplos: `{ "path": "id", "exists": true }`, `{ "path": "items", "isArray": true }`,
  `{ "path": "$", "isArray": true }`, `{ "header": "content-type", "contains": "json" }`.
  Un path vacio o `$` representa el body completo. No existen `greater_than`, `length`
  ni comparadores numericos. Cualquier operador no soportado debe considerarse error,
  no warning menor.
- **Respeta el contrato del normalizador Markdown.** Cada caso debe empezar con un
  heading tipo `# TC-001: Título`, `# Caso 1: Título` o `# Case 1: Title`. Usa labels
  reconocidos con dos puntos: `Priority`, `Description`, `Route`, `Preconditions`,
  `Data`, `Steps`, `Expected Results`. ProGuide extrae `original_steps` solo desde
  la lista numerada bajo `Steps` y `expected_results` desde `Expected Results`.
- **Declara `Route` cuando la conozcas.** Ejemplo: `**Route:** /checkout`. Esto ayuda
  al pre-pass DOM: ProGuide navega esa ruta antes de pedirle al LLM que genere código.
- **Una acción por paso.** Nunca "llenar el formulario y hacer clic en Continue" — son
  varios pasos. Los pasos compuestos bajan la confianza del normalizador (0.7 vs 0.95)
  y fallan más.
- **Para pasos críticos, usa el DSL explícito que ProGuide normaliza con alta confianza**:
  `click [data-testid="save-btn"]`, `fill [name="email"] with "qa@test.com"`,
  `expect [data-testid="cart-badge-count"] to contain text "1"`,
  `expect [data-testid="order-summary"] to be visible`, `expect text "Order confirmed"`.
- **Para navegación, usa `Route` y un paso que sea solo la ruta**:
  `1. /checkout`. Alternativamente `Ir a /checkout`. Evita `Navigate to /checkout`
  porque hoy el normalizador lo deja como lenguaje natural y baja la confianza.
- **Si no tienes selector, usa texto literal de la UI entre comillas dobles**:
  `Click the "Add New Product" button`.
  Copiado exacto de la pantalla o del código, nunca parafraseado.
- **Si conoces el `data-testid` o `id`, inclúyelo en el paso**:
  preferir `click [data-testid="quick-login-admin"]` o `click [id="quick-login-admin"]`
  sobre lenguaje natural. Es la forma más robusta para la normalización.
- **Nunca uses el selector de clase con punto (`.btn-primary`, `.success-btn`) en pasos
  `click`.** El normalizador lo reescribe a `[data-testid="btn-primary"]`; si la app no
  tiene ese `data-testid` (muy común), el clic hace timeout de 30s y el caso falla. Esto
  **no** se detecta en el dry-run: el paso aparece con confianza alta porque la sintaxis
  es válida; el fallo solo se ve al ejecutar. Para botones usa **texto literal**
  (`Click the "Next" button`, verificado: pasa aunque el dry-run lo marque en 0.7) o un
  `data-testid`/`id` que exista de verdad. Los atributos reales con corchetes
  (`[placeholder="..."]`, `[name="..."]`, `[id="..."]`) sí funcionan en `fill`/`expect`/`click`.
- **Verificaciones con texto único en la página.** Verificar nombres/títulos, no precios
  ni números (un precio puede aparecer en item, subtotal y total a la vez → strict mode
  violation de Playwright).
- **Contexto posicional cuando hay elementos repetidos**:
  `In the "Producto X" row, click the "Delete" button`.
- **Sin pasos condicionales** ("si aparece un diálogo..."). Averigua de antemano si el
  diálogo aparece y escribe el paso en firme.
- **Casos autocontenidos**: cada caso incluye su propio login/setup y no depende de
  otro caso ni de estado previo.
- **Datos en la sección Data**, no embebidos en la redacción de los pasos.
- **Si hay contraseñas de prueba, nómbralas como `test password`.**
  ProGuide enmascara secretos reales; esos nombres dejan claro que son datos no
  productivos para automatización.
- Escribe los pasos en **inglés** cuando uses lenguaje natural; para navegación usa
  `/ruta` o `Ir a /ruta` porque es lo que el normalizador actual reconoce mejor.
  Mantén título/descripción en el idioma del usuario.
- No incluyas comentarios HTML ni notas dentro del Markdown final del caso.

### Paso 2 — Dry-run de validación (antes de ejecutar)
1. Llama a `mcp__proguide-test__create_run` (tool principal de dry-run; crea SIN
   ejecutar) con los casos.
2. Revisa en la respuesta los `executable_steps`: cada uno trae `normalized_action` y
   `confidence`.
   En API estructurada, revisa tambien `request`/`requests`, `assertions` y `captures`;
   los casos API deterministas no necesitan DOM ni confianza de selectores.
3. **Acepta como ideal `confidence: 0.95` en clicks, fills y asserts críticos.**
   Normalmente se logra con el DSL explícito (`click [selector]`, `fill [selector] with`,
   `expect [selector]...`, `expect text "..."`).
4. **Todo paso con `confidence` < 0.85 es un paso que el runner tuvo que adivinar.**
   Reescríbelo: agrega `Route`, texto literal, selector (`data-testid`, `id`, `name`) o
   divídelo en pasos atómicos.
5. Repite hasta que los pasos críticos tengan confianza alta. Los pasos de navegación
   tipo `/ruta` o `Ir a /ruta` pueden quedar en 0.85; está bien si la ruta es concreta.
6. **La confianza del dry-run no predice el resultado de la ejecución.** Los clics por
   texto (`Click the "Next" button`) y los `select "Opción" in select` se quedan en 0.7
   pero **ejecutan bien** si el texto es literal y único. El dry-run valida sintaxis y
   ambigüedad, no si el selector existe en el DOM. Un `.clase` en `click` puede mostrar
   confianza 0.95 y aun así fallar (ver la regla de selectores de clase en el Paso 1).
   Por eso la ejecución real (Paso 4) es la que manda.

### Paso 3 — Ejecutar
Llama a `mcp__proguide-test__run_cases` (tool principal de ejecucion) con
`open_browser: true` para que el usuario vea el reporte. Pasa siempre `base_url`,
`title`, `module` y `root` (raíz del proyecto). `create_run_from_markdown` y
`run_markdown_cases` son aliases compatibles; para flujos nuevos usa `create_run` y
`run_cases`.

### Paso 4 — Iterar con la evidencia (calibración)
La primera ejecución de un caso nuevo es de calibración, no de regresión. Si falla:

1. **Lee el `message` del resultado.** Los errores de Playwright incluyen el árbol de
   accesibilidad real de la página: ahí están los textos y selectores correctos.
   - `strict mode violation` + lista de elementos → el texto no es único; usa el
     candidato correcto de la lista (su `data-testid` aparece en el error).
   - `Timeout waiting for get_by_placeholder/get_by_text` → el texto que usaste no
     existe en la UI; búscalo en el árbol del error, en el código o pregunta al usuario.
2. Corrige SOLO los pasos fallidos y re-ejecuta.
3. Los textos y selectores correctos quedan incorporados en la versión final de los
   casos: esa versión es la que se conserva/entrega, para que las siguientes ejecuciones
   no repitan la calibración.

### Paso 5 — Reportar
Al terminar, informa al usuario: estado de cada caso (passed/failed), el `run_url` del
visor, y qué se corrigió en cada iteración. Si un caso falla por un bug real de la app
(no por el selector), repórtalo como hallazgo, no lo "arregles" relajando la verificación.

## Errores comunes y su solución

| Síntoma | Causa | Solución |
|---|---|---|
| `strict mode violation: resolved to N elements` | Texto/rol ambiguo | Usar data-testid o contexto posicional ("in the X row...") |
| `Timeout waiting for get_by_placeholder("...")` | El placeholder real es otro | Mirar el árbol del error o el código; usar el placeholder/label exacto |
| `click` hace timeout 30s y el dry-run se veía en 0.95 | Selector de clase `.btn` reescrito a `[data-testid="btn"]` inexistente | Usar texto literal del botón (`Click the "X" button`) o un `data-testid`/`id` real |
| Falla un paso compuesto | Varias acciones en un paso | Dividir en pasos atómicos |
| Verificación de precio/número falla | El valor aparece varias veces | Verificar por texto único (nombre/título) |
| Caso pasa solo / falla en suite | Dependencia entre casos | Hacer cada caso autocontenido |
| API login pasa pero el siguiente request da 401 | Token hardcodeado o no capturado | Usar `requests` + `captures` y `Authorization: Bearer {{access_token}}` |
| API create_run falla por aserción no soportada | Operador fuera del contrato | Cambiar a `equals`, `exists`, `contains`, `isArray`, `status`, `ok`, `header` o `body_contains` |
| API register/create falla en el segundo run | Datos no idempotentes | Usar sufijo dinamico, teardown o setup separado |
