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

1. **`proguide inspect` (camino primario, autosuficiente).** ProGuide trae su propio
   Chromium, así que no dependes de ningún MCP de navegador. Confirma URL base y que la
   app esté accesible, y corre `proguide inspect <ruta> --base-url <url> --json` (o el tool
   MCP `inspect_route`). Devuelve el árbol de accesibilidad y candidatos de selector
   estable (`data-testid`/`id`/`name`/role) de la pantalla real. Para rutas **protegidas**,
   configura el bloque `auth` en `proguide_tests/config.yaml` (ver README) y pasa las
   credenciales por CLI/MCP; `inspect` inicia sesión y navega ya autenticado. Revisa el
   campo `authenticated`/`warning` del resultado: si dice que esperaba sesión pero falló,
   estás viendo el login, no la pantalla protegida — arregla el `auth` antes de redactar.
   Para cada acción crítica, materializa lo observado en DSL explícito: no escribas
   `click "TEXT"` si el DOM muestra que el elemento es `li`, `a`, card o componente MUI;
   usa `click li:has-text("TEXT")`, `click [selector]`, `fill [selector] with ...` o
   `expect [selector]...` según el tag/atributo real.
2. **Browser MCP del usuario (fallback para auth interactivo o exploración libre).** Si el
   login es **SSO/MFA interactivo** que `inspect` no puede automatizar, o necesitas
   *descubrir* flujos que no conoces de antemano, usa Claude in Chrome, Playwright MCP o
   Chrome DevTools MCP (su navegador ya está logueado). Si no están instalados y los
   necesitas: `claude mcp add playwright npx @playwright/mcp@latest`,
   `claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest`, o en
   Cursor `Settings → MCP → Add new MCP Server` con `npx @playwright/mcp@latest` y
   `npx -y chrome-devtools-mcp@latest`.
3. **Código fuente, solo si está disponible en el workspace.** Busca `data-testid`, `id`,
   placeholders y textos visibles de los componentes involucrados. Es un complemento,
   no un requisito.
4. **Preguntar al usuario.** Si no puedes inspeccionar la app ni ver código, pide los textos
   literales de la UI (o capturas de pantalla) de las pantallas involucradas.
5. **Calibración como último recurso.** Si nada de lo anterior es viable, redacta un
   borrador con lo que el usuario describió y trata la primera ejecución como
   calibración: los errores del runner devuelven el árbol real de la página (ver Paso 4).

Nunca inventes textos de botones o campos: si no los conoces, consíguelos por alguna de
estas vías antes de dar los casos por definitivos. Esto incluye la pantalla **post-login**
(el "dashboard"): no asumas que existe un heading literal "Dashboard", "Home" o nombres
genéricos similares — usa el texto/heading real que viste al inspeccionar esa pantalla.

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
- **API multi-step desde Markdown:** cada step HTTP numerado genera un request del
  flujo. ProGuide preserva URLs absolutas cross-service aunque el caso tenga `Route`.
  Usa `con body {...}`, `con header Authorization: Bearer {{token}}` y
  `capturar campo token` cuando necesites login -> endpoint. Si cada request tiene
  un status/assert distinto, escribe `Step 1: status 201`, `Step 2: status 500` o
  `Step 2: body.message contains inexistente` en `Expected Results`; las aserciones
  sin `Step N` se aplican al ultimo request del flujo.
- **API multi-step estructurada:** para casos generados por tooling o muy largos,
  puedes pasar `cases` con `requests: [...]` directamente. `captures` es un objeto
  `{ "variable": "campo_del_body" }` y se reutiliza como `{{variable}}`.
- **Debug API:** si un fallo necesita confirmar el request real enviado, agrega
  `"debug": true` solo en entornos locales o con datos no sensibles. El resultado
  incluira `actual_response` y, con debug, tambien `actual_response.request`.
- **Evidencia API:** cada request genera `api_evidence` JSON con request, response,
  assertions, captures y duracion; el viewer lo muestra tipo Postman. Para API pura,
  esa evidencia reemplaza la necesidad de screenshots de browser.
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
- **El login es un paso más, no un atajo mágico.** No hay heurística que adivine "este
  campo es el email": redactalo igual que cualquier otro `fill`/`click` — con selector si
  lo conocés (`fill [name="username"] with "eolivera"`) o, si no, en lenguaje natural con el
  valor explícito (`Completar el campo de usuario con eolivera`); el campo real se resuelve
  contra el DOM inspeccionado (Paso 0), nunca se asume por el nombre de la palabra
  "email"/"usuario" en el texto del paso.
- **Evita selectores de clase con punto (`.btn-primary`, `.success-btn`) salvo que sean
  realmente estables.** ProGuide los respeta como CSS, pero suelen cambiar más que un
  `data-testid`, `id`, `name` o texto literal. Para botones usa **texto literal**
  (`Click the "Next" button`, verificado: pasa aunque el dry-run lo marque en 0.7) o un
  `data-testid`/`id` que exista de verdad. Los atributos reales con corchetes
  (`[placeholder="..."]`, `[name="..."]`, `[id="..."]`) funcionan en `fill`/`expect`/`click`.
- **Para SSO multi-app lento en TST, el primer paso debe ser timeout largo**:
  `set test timeout to 900 seconds`. ProGuide lo coloca a nivel de función del test.
- **Si el último assert depende de una API lenta, agrega una espera explícita antes**:
  `wait 30 seconds` como penúltimo paso y luego `expect text "..."`.
- **Si dos o más casos usan el mismo usuario de prueba, ejecútalos en runs separados**.
  El runner usa `fullyParallel: true`; compartir sesión SSO puede hacer que un caso pase
  y otro falle por timeout de login.
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
   ejecutar) con los casos. **Nota:** Esta llamada ejecuta el pre-pass de *grounding walk* que recorre las pantallas de la aplicación, tomando snapshots de DOM de cada paso (incluyendo páginas post-login). Esta exploración unificada y enriquecida se guarda en `dom_context.json` y sirve como la fuente de verdad de la estructura del DOM para el agente de generación de código.
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

1. **Lee el `status`, el `message` y el campo `review_note` de cada caso.** ProGuide
   clasifica así:
   - `passed` — verde. A veces trae una **`review_note`** ("Nota"): avisa que el dry-run
     no pudo verificar por su cuenta un target porque el caso depende de una precondición
     (login, un error previo) que el pre-pass no montó. **No requiere acción** — el test
     pasó y el runner ya compensó la precondición; solo confirmá que la aserción sea la
     correcta. Para silenciar la nota, agregá esos pasos de precondición al caso. No lo
     cuentes como falla ni como calibración.
   - `needs_calibration` — **el único estado que realmente hay que calibrar.** Un
     selector/texto no resolvió en runtime (timeout esperando un `locator`/`getBy*`,
     `strict mode violation`, elemento not found) y el dry-run no lo había confirmado: el
     selector quedó viejo o mal. **No es un bug de la app.** Acción: recalibrá (paso 2).
   - `failed` — el elemento se encontró pero la aserción de estado/texto no se cumplió
     (`expect(...).toHaveText`, `toHaveURL`, status code distinto). **Sí es un hallazgo
     real**; reportalo como bug, no lo "arregles" relajando la verificación.

   El campo `review_note` de cada caso te da la acción concreta recomendada.
2. **Recalibrar (`needs_calibration`):** los errores de Playwright incluyen el árbol de
   accesibilidad real de la página — ahí están los textos y selectores correctos.
   - `strict mode violation` + lista de elementos → el texto no es único; usa el
     candidato correcto de la lista (su `data-testid` aparece en el error).
   - `Timeout waiting for get_by_placeholder/get_by_text` → el texto que usaste no
     existe en la UI; búscalo en el árbol del error, en el código o pregunta al usuario.
   Corrige SOLO los pasos de ese caso y re-ejecuta **con LLM** (no `--frozen`) hasta que
   quede verde.
3. Los textos y selectores correctos quedan incorporados en la versión final de los
   casos: esa versión es la que se conserva/entrega, para que las siguientes ejecuciones
   no repitan la calibración.

### Paso 5 — Reportar

Al terminar, informa al usuario: estado de cada caso (passed/failed/needs_calibration),
el `run_url` del visor, y qué se corrigió en cada iteración. Distingue al reportar:
- `passed` con `review_note` → pasó; la nota es informativa (el dry-run no pudo
  pre-verificar un target por una precondición). No es falla ni pendiente de calibrar.
- `needs_calibration` no es bug: el selector/texto no resolvió en runtime y se recalibró
  (o queda pendiente de recalibrar). No lo cuentes como falla del producto.
- `failed` sí es bug real (el elemento se encontró pero la aserción no pasó): repórtalo
  como hallazgo, no lo "arregles" relajando la verificación.

### Paso 6 — Congelar la suite para regresión

Una vez que un run quedó **calibrado** (pasa de forma estable), conviértelo en suite de
regresión versionable. La diferencia clave: la calibración usa el LLM y abre browser para
leer la app; la regresión ejecuta el `.spec.ts` **congelado** tal cual, sin LLM ni
pre-pass → determinista, rápida y barata.

1. **Congelar:** `proguide promote <run_id> --module <nombre>`. Copia casos, plan y specs
   a `proguide_tests/suite/<nombre>/` (carpeta versionable; commiteala junto a la app).
2. **Re-ejecutar regresión:** `proguide regress <nombre> --base-url <url>` (o
   `proguide execute <run_id> --frozen` / arg `frozen: true` en `execute_run`). No llama al
   LLM ni reabre browser para contexto: dos corridas seguidas dan el mismo resultado.
3. **Recalibrar ante drift de UI:** si la app cambió y N casos fallan, recalibra **solo**
   esos casos (re-genera, verifica el diff del spec) y vuelve a `promote`. Si la URL base cambia o deseas forzar una nueva pasada de exploración del DOM y recalibrar los selectores, puedes pasar la opción `--reground` en la línea de comandos (ej. `proguide execute <run_id> --reground`) o el parámetro `reground: true` en la herramienta `execute_run`. Distingue
   siempre: selector viejo → recalibrar; bug real de la app → reportar, nunca relajar el
   assert.
4. **Sesión compartida (opcional):** para suites con login user/pass, activar
   `auth.reuse_session: true` hace que el runner reutilice la sesión en vez de loguear por
   caso (mitiga la contención `fullyParallel` + mismo usuario). Si lo activas, los casos
   **no** deben incluir pasos de login.

## Errores comunes y su solución

| Síntoma                                                                       | Causa                                                                         | Solución                                                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `strict mode violation: resolved to N elements`                               | Texto/rol ambiguo                                                             | Usar data-testid o contexto posicional ("in the X row...")                                      |
| `Timeout waiting for get_by_placeholder("...")`                               | El placeholder real es otro                                                   | Mirar el árbol del error o el código; usar el placeholder/label exacto                          |
| `click` hace timeout 30s y el dry-run se veía en 0.95                         | Selector real no existe o clase CSS cambiante                                 | Usar texto literal del botón (`Click the "X" button`) o un `data-testid`/`id` real              |
| Aserción final falla con `5000ms exceeded` aunque el elemento aparece después | El assert dependía del timeout default de Playwright o de una respuesta lenta | Usar `wait N seconds` antes del assert y/o `set assertion timeout to N seconds`                 |
| Un TC pasa y otro falla en login al ejecutarlos juntos                        | `fullyParallel: true` + mismo usuario → contención SSO                        | Ejecutar cada TC en un `execute_run` separado                                                   |
| Flujo web-suite → web-health queda esperando SSO en TST                       | Validación de token fría puede tardar 300-600s                                | Poner `set test timeout to 900 seconds` como primer paso                                        |
| Falla un paso compuesto                                                       | Varias acciones en un paso                                                    | Dividir en pasos atómicos                                                                       |
| Verificación de precio/número falla                                           | El valor aparece varias veces                                                 | Verificar por texto único (nombre/título)                                                       |
| Caso pasa solo / falla en suite                                               | Dependencia entre casos                                                       | Hacer cada caso autocontenido                                                                   |
| API login pasa pero el siguiente request da 401                               | Token hardcodeado o no capturado                                              | Usar `capturar campo access_token` en Markdown o `requests` + `captures` en JSON                |
| API cross-service pega al host equivocado                                     | URL relativa con `base_url` incorrecto o caso viejo sin parser multi-step     | Usar URL absoluta en el step/request de ese servicio                                            |
| API create_run falla por aserción no soportada                                | Operador fuera del contrato                                                   | Cambiar a `equals`, `exists`, `contains`, `isArray`, `status`, `ok`, `header` o `body_contains` |
| API register/create falla en el segundo run                                   | Datos no idempotentes                                                         | Usar sufijo dinamico, teardown o setup separado                                                 |
| El test hace timeout global usando `set test timeout`                         | `set test timeout` limita la duración total del test, incluyendo `wait`       | Preferir espera dinámica (`expect to be visible`) y reservar timeouts altos solo cuando sea necesario. |
| El toast de éxito no se encuentra tras un redireccionamiento                  | El toast desaparece rápido tras el redirect antes de que el assertion corra   | Verificar un texto o elemento estable de la página destino en vez del toast.                  |
| Clic por texto genérico falla por tag incorrecto (ej. li/nav)                 | Clicks genéricos sin rol explícito ahora son role-agnósticos (`getByText`)    | Para forzar botón escribe `click button "X"`, o usa selectores explícitos como `li:has-text("X")`.     |
| `strict mode violation: getByText('X') resolved to N elements` en un `expect` | El texto a verificar aparece en más de un lugar (ej. título de card + menú)   | El runner usa `.first()` para `expect text "X"`. Si querés verificar un lugar puntual, scopealo: `expect h1:has-text("X")` o un selector más específico. |
