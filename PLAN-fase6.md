# Mini-diseño — Fase 6: Dry-run grounded (asistido) + clasificación de fallos

> Objetivo: minimizar los dos errores mas frecuentes hoy — **timeout por selector/texto
> no encontrado** y **texto inventado tomado como negativo** — resolviendo cada target
> contra el DOM real **antes** de ejecutar (asistido: ProGuide muestra candidatos, el
> agente decide), y evitando que un selector no encontrado cuente como bug.

## 1. Principio

> Todo selector/texto debe resolverse contra el DOM real **en el punto del flujo donde se
> usa**, y un target no resuelto nunca debe convertirse en falso negativo en silencio.

Regla de oro intacta: **ProGuide entrega DOM/candidatos deterministas; el agente pone el
juicio** (elige el candidato, reescribe el paso). Nada de auto-elegir selectores.

## 2. Reframe

Hoy el dry-run (`create_run`) solo valida **sintaxis y ambigüedad**: normaliza pasos y
asigna `confidence`, sin tocar la app (lo admite la skill). Esta fase **convierte el dry-run
de sintáctico a *grounded***: agrega una pasada que verifica cada target contra el DOM real.

El modelo de datos ya tiene los ganchos: cada `executable_steps[]` trae
`normalized_action`, `confidence`, `needs_review`, `review_reason` (hoy vacíos). Los
poblamos con el resultado del grounding + un nuevo campo `candidates`.

## 3. Prong A — Dry-run grounded (preventivo, asistido)

### 3.1 Walk tolerante

Para casos **UI**, durante el dry-run ProGuide abre su Chromium (reusando `ensureSession`
para auth/storageState) y **recorre los pasos del caso** para llegar a la pantalla de cada
target — necesario porque targets post-login (ej. `expect text "Link Analysis"`) solo
existen tras avanzar el flujo.

Por cada paso con target (`click`, `fill`, `expect [selector]`, `expect text`,
`click "texto"`):

- **Selector explícito** (`#username`, `[name=...]`, `[data-testid=...]`):
  `page.locator(sel).count()` → `0` = not_found, `1` = resolved, `>1` = ambiguous.
- **Texto / nombre accesible** (`"Acceder"`, `"Link Analysis"`): busca elementos visibles
  cuyo texto/aria-label matchee (exacto → case-insensitive → contains → fuzzy) y devuelve
  los mejores candidatos con su `selector_hint` (reutilizar la lógica `selectorHint` y
  `DOM_SNAPSHOT_JS` del probe de `inspect`).

**Tolerante:** los pasos resueltos/explícitos se ejecutan para avanzar el flujo; cuando un
target no resuelve, se anotan candidatos y se intenta el mejor candidato para seguir el
walk (best-effort). Si el flujo queda bloqueado en el paso N, los pasos siguientes se
marcan `unverified (flujo bloqueado en paso N)` en vez de inventar un veredicto.

### 3.2 Salida por paso

Extender `executable_steps[]` con:

```jsonc
{
  "normalized_action": "click button Acceder",
  "confidence": 0.85,
  "grounding": {
    "status": "resolved" | "ambiguous" | "not_found" | "unverified",
    "resolved_selector": "button:has-text(\"Acceder\")",   // si resolved
    "candidates": [
      { "selector": "[data-testid=\"login-submit\"]", "text": "Acceder", "role": "button" }
    ]
  },
  "needs_review": true,                 // true si status != resolved
  "review_reason": "texto \"Link Analysis\" no encontrado; cercanos: ..."
}
```

`needs_review` + `review_reason` se setean en función de `grounding.status` para que el
agente los lea en el dry-run que **ya hace** (Paso 2 de la skill).

### 3.3 Gating

- **Solo UI.** Para casos API (`isApiPlanCase`) se **omite** el walk por completo (no hay
  DOM; ya son deterministas).
- Default **ON** en dry-run para casos UI. (Opcional: flag `ground: false` / `--no-ground`
  para desactivarlo en un dry-run rápido.)

## 4. Prong B — Clasificación de fallos en ejecución

Aunque el Prong A prevenga la mayoría, algo se escapa. En ejecución:

- En `playwrightStatus` (`ui/lib/runner/results.ts`): si el error matchea patrones de
  **localización** (`Timeout .* waiting for locator`, `locator.* not found`,
  `waiting for get_by_*`, `strict mode violation`) → status **`needs_calibration`**.
- Si el elemento se encontró pero la aserción de estado/texto no se cumplió → `failed`
  (hallazgo real). Distinguir es la clave: hoy ambos caen en "failed".

### 4.1 Conteo y estado

- `countSummary` (`ui/lib/run-store/io.ts`): agregar `needs_calibration` al objeto de
  conteo.
- `statusFromSummary`: `needs_calibration` es categoría aparte (ni passed ni failed); no
  contamina la tasa de bugs. Precedencia sugerida: `setup_failed` > `failed` >
  `needs_calibration` > `inconclusive` > `passed`.
- Propagar `run.needs_calibration` en `executePreparedRun` (junto a passed/failed/...).

## 5. Cambios a nivel archivo (orden sugerido)

1. `ui/lib/codegen/dom-context.ts` (o nuevo `ui/lib/codegen/grounding.ts`):
   `groundCaseSteps({ root, baseUrl, config, credentials, case })` — probe en proceso hijo
   (mismo patrón que `INSPECT_PROBE_SCRIPT`) que hace el walk tolerante y devuelve el
   `grounding` por paso. Reutiliza `ensureSession` y la lógica de snapshot/`selectorHint`.
2. `ui/lib/run-store/runs.ts`: en `prepareMarkdownRun`/`prepareCasesRun`/`previewMarkdownRun`,
   tras normalizar, si el caso es UI correr `groundCaseSteps` y mergear `grounding` +
   `needs_review`/`review_reason` en `executable_steps`. Skip API.
3. `ui/lib/runner/results.ts`: clasificación de error → `needs_calibration` en
   `playwrightStatus`.
4. `ui/lib/run-store/io.ts`: `needs_calibration` en `countSummary` y `statusFromSummary`.
5. `ui/lib/run-store/runs.ts`: `run.needs_calibration` en el resumen de `executePreparedRun`.
6. `ui/cli.ts` / `ui/mcp-server.ts`: el dry-run ya devuelve `executable_steps`; agregar al
   render del dry-run un resumen de pasos `needs_review` con sus candidatos. Mostrar
   `needs_calibration` en el summary de ejecución.
7. `ui/server.ts` + vistas del viewer: categoría `needs_calibration` separada de failed.
   (puede ir en una iteración 6.2)
8. `skills/SKILL.md` (+ copia `ui/skills/qa-test-cases/SKILL.md`): Paso 2 consume los
   candidatos del dry-run grounded; Paso 4/5 explican `needs_calibration` (no es bug).

## 6. Edge cases / guards

- Pasos **sin target** (`/ruta`, `wait N seconds`, `set test timeout`): se saltan en el
  grounding (no tienen elemento que resolver).
- **Sesión no disponible** (auth mal configurado o SSO/MFA): el walk corre sin autenticar;
  los targets post-login darán `not_found` → se reportan igual (consistente con el flag
  `authenticated` de `inspect`). Avisar en `review_reason` que pudo faltar sesión.
- **Flujo bloqueado** en paso N: pasos siguientes → `unverified`, nunca un veredicto
  inventado.
- **Costo:** el dry-run UI ahora abre browser (antes no). Es el precio de cazar el error
  antes del run; aceptado y acotado a UI. Reutiliza storageState para no re-loguear.
- **Determinismo:** el grounding NO elige por el agente; solo reporta. El agente edita el
  caso (o acepta el `resolved_selector`) explícitamente.

## 7. Criterio de aceptación

1. Para el caso de login real (`#username`/`#password` explícitos, `click "Acceder"`,
   `expect text "Link Analysis"`): el dry-run resuelve los tres primeros contra el login,
   avanza el flujo, y resuelve/propone candidatos para "Link Analysis" **antes** de ejecutar.
2. Un target inexistente aparece como `needs_review` con candidatos en el dry-run, no como
   rojo en el run.
3. Un run cuyos únicos fallos son selector/timeout-not-found reporta `needs_calibration`,
   no `failed`; la tasa de bugs no se contamina.
4. Casos API: el dry-run no abre browser ni hace grounding.

## 8. Corte MVP de la fase

- **Imprescindible:** Prong B (clasificación `needs_calibration`) — barato y de alto impacto
  inmediato sobre los falsos negativos; + Prong A para **selectores/textos explícitos y de
  primer nivel** (sin walk: resolver contra el snapshot del `route`).
- **Después (6.2):** walk tolerante multi-paso (post-login), categoría en el viewer,
  fuzzy matching de candidatos más fino.
