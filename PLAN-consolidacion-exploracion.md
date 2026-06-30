# Plan de implementación — Consolidar la exploración de DOM (walk único → codegen)

> **Objetivo:** dejar **una sola** exploración de DOM como fuente de verdad. Hoy hay dos
> pasadas que lanzan browser, navegan y corren el mismo `DOM_SNAPSHOT_JS`; peor aún, la
> pasada **rica** (el walk de grounding, que recorre el flujo y llega al post-login) se
> descarta, y la **floja** (`collectDomContext`, un snapshot de la landing) es la que
> alimenta al LLM. Consolidamos: el walk produce el contexto, lo cablea al agente, y
> `collectDomContext` se retira.
>
> **Principio rector (intacto):** ProGuide entrega DOM/candidatos deterministas; el agente
> pone el juicio. La exploración **propone** (resolved_selector + candidates); el agente
> elige. No auto-elegimos selectores.

---

## 1. Estado actual (las dos pasadas)

| | **Grounding walk** (`runWalkProbe`, `grounding.ts`) | **`collectDomContext`** (`dom-context.ts`) |
|---|---|---|
| Cuándo | Dry-run (`prepareMarkdownRun`/`prepareCasesRun`) | Ejecución (`executePreparedRun`) |
| Qué hace | Navega la ruta **y recorre los pasos** best-effort; snapshot **antes de cada paso** | Navega **solo a la ruta** del caso; **un** snapshot de la landing |
| Alcance | Multi-pantalla: **llega al post-login** | Se queda en la pantalla inicial de la ruta |
| Salida | `executable_steps[].grounding = { status, resolved_selector, candidates }` | `dom_context.by_case_id[caseId].snapshot` |
| Consumo | Flags `needs_review` del dry-run + **solo un booleano** (`grounding_confirmed`) llega al plan | **El LLM** lo recibe como `dom_context` |

**Problema de fondo:** el `resolved_selector`/`candidates` por paso que el walk ya calculó
**no llega al codegen** (`buildCodeGenerationPayload` en `agent.ts` no mapea ningún campo de
grounding). El agente re-deriva todo desde `collectDomContext`, que para un login snapshoteó
la pantalla de login, no el dashboard. Por eso adivina `getByText('VulnOps')` sin contexto.

---

## 2. Estado objetivo

- El **walk** es la única pasada de DOM. Produce y **persiste**:
  1. el veredicto por paso (`executable_steps[].grounding`) — ya lo hace; sobrevive en
     `normalized_cases.json` de `create_run` a `execute_run`;
  2. un **`dom_context` por caso derivado del walk** (unión de controles/headings de las
     pantallas recorridas, incluida la post-login).
- `buildCodeGenerationPayload` **cablea** ambos al agente: por paso, `resolved_selector` +
  `candidates` + `status`; por caso, el `dom_context` del walk.
- `collectDomContext` (y su probe `DOM_CONTEXT_PROBE`) **se retira** del path de ejecución;
  queda, a lo sumo, como **fallback** cuando el walk no produjo nada.

---

## 3. Diseño detallado

### 3.1 El walk persiste su `dom_context` (además del veredicto por paso)

En `runWalkProbe`/`groundCaseSteps` (`grounding.ts`):

- El probe ya toma `snapshot` antes de cada paso (`walk.steps[].snapshot`) y hoy se
  **descarta** tras computar el veredicto. En vez de tirarlo, construir un `dom_context`
  por caso = **unión deduplicada** de `controls` + `headings` + `visible_text` de todas las
  pantallas del walk (acotada a `max_controls`), priorizando las pantallas más profundas
  (post-login). Esto reemplaza el snapshot único de `collectDomContext` por uno más rico.
- Persistir ese `dom_context` por caso en el **mismo archivo `dom_context.json`** y con la
  **misma forma `by_case_id`** que hoy escribe `collectDomContext`, para no tocar el consumidor.
  Así el cambio de productor es transparente para `generateTestsWithAgent`.
- Mantener `executable_steps[].grounding` como hoy (compacto: `status`,
  `resolved_selector`, `candidates`). **No** guardar snapshots crudos en
  `normalized_cases.json` (evita bloat); los snapshots completos van solo a `dom_context.json`.

> Nota: el walk ya reusa `ensureSession` (auth/storageState), igual que `collectDomContext`.
> La sesión autenticada se mantiene.

### 3.2 Cablear el grounding al payload del agente

En `agent.ts`:

- **`casesToTestPlan`** (`test-plan.ts`): hoy aplana a `steps: [string]` con un `.filter(Boolean)`
  que puede desalinear índices. Para garantizar alineación, emitir un arreglo paralelo
  `steps_grounding` (o cambiar `steps` a objetos `{ action, grounding }`) construido
  **directamente desde `executable_steps`**, no por índice posterior.
- **`buildCodeGenerationPayload`**: por cada caso, además de `dom_context`, incluir por paso
  `{ action, status, resolved_selector, candidates }`. La data ya está disponible: el método
  hace `sourceCases.find(id)` y `sourceCase.executable_steps[].grounding` existe.

### 3.3 Prompt del agente (que la exploración *maneje* la generación)

Agregar reglas en `PLAYWRIGHT_CODE_AGENT_PROMPT`:

```
- Each step may include grounding from a real DOM pre-pass:
  - status "resolved" + resolved_selector -> USE that exact selector; do not re-derive it.
  - status "ambiguous" + candidates -> the target is NOT unique; pick the right candidate
    (by role/text) or scope the locator. Never emit a bare locator that matches >1 element
    for an interaction.
  - status "not_found"/"unverified" -> fall back to dom_context / visible headings as today.
- resolved_selector beats your own guess and beats dom_context when both exist.
```

(Complementa la regla de strict-mode/`.first()` ya agregada para `expect text`.)

### 3.4 Retiro de `collectDomContext`

En `runs.ts` (`executePreparedRun`, ~líneas 679-727):

- Quitar la llamada a `collectDomContext` y los eventos `dom_context_started`/`collected`/
  `skipped` (o renombrarlos a algo tipo `dom_context_from_walk`).
- `generateTestsWithAgent({ domContext })` ahora recibe el `domContext` **leído de
  `dom_context.json`** producido por el walk (o reconstruido en memoria si se pasa directo).
- **Retiro total** (decisión §7): borrar el export `collectDomContext`, la constante
  `DOM_CONTEXT_PROBE` y el import en `runs.ts`. Sin fallback de snapshot único.
- Si el walk no dejó `dom_context` (falló la navegación, sitio caído), el agente degrada a
  headings/visible_text (su manejo "dom_context unavailable" actual). No se corre pasada
  alternativa.

---

## 4. Manejo de staleness (dry-run ahora, execute después)

- En **`run_cases`** (un solo tiro) walk y codegen son consecutivos → sin staleness.
- En **`create_run` → `execute_run` diferido**, el `dom_context.json` + grounding son del
  momento del dry-run. Política propuesta:
  - **Reusar** el grounding/`dom_context` persistido si `base_url` no cambió.
  - **Re-walk** si: no hay grounding persistido, `base_url` cambió, o se pasa un flag explícito
    (`reground: true` / `--reground`).
- **Regresión congelada** (`frozen`): no corre ninguna pasada (determinista); intacta.

---

## 5. Cambios archivo por archivo (orden sugerido)

1. **`ui/lib/codegen/grounding.ts`** — el walk arma y persiste `dom_context.json` (unión de
   pantallas); mantiene el veredicto por paso. Helper `mergeWalkSnapshots(steps)`.
2. **`ui/lib/codegen/test-plan.ts`** — `casesToTestPlan` emite grounding por paso alineado
   (`steps_grounding` o `steps` como objetos).
3. **`ui/lib/codegen/agent.ts`** — `buildCodeGenerationPayload` incluye grounding por paso;
   `PLAYWRIGHT_CODE_AGENT_PROMPT` con las reglas de §3.3.
4. **`ui/lib/run-store/runs.ts`** — `executePreparedRun`: leer `dom_context.json` del walk en
   vez de llamar `collectDomContext`; lógica de fallback + re-walk (§4).
5. **`ui/lib/codegen/dom-context.ts`** — degradar `collectDomContext` a fallback (o retiro
   total, §7).
6. **`README.md` / `skills/SKILL.md` (x2)** — documentar que la exploración del dry-run ahora
   alimenta el codegen, y la opción `reground`.

---

## 6. Edge cases / guards

- **Casos API** (`isApiPlanCase`): ni walk ni dom_context; sin cambios.
- **Walk falló** (timeout/sitio caído): `dom_context` vacío + grounding `unverified` → el agente
  cae a headings/visible_text como hoy; fallback opcional de snapshot único.
- **Alineación de índices** paso↔grounding: construir desde `executable_steps`, no por posición
  tras `.filter`.
- **Bloat:** snapshots crudos solo en `dom_context.json`, nunca en `normalized_cases.json`.
- **Pasos destructivos:** el walk **muta estado** (ejecuta pasos: puede enviar forms/crear
  datos). Ya ocurre hoy en el dry-run, pero al hacerlo fuente del codegen conviene dejar el
  walk **tolerante** (best-effort, no aborta) y documentarlo.

---

## 7. Decisiones tomadas y riesgos

Decisiones **definitivas** (confirmadas por el owner):

- **Retiro TOTAL de `collectDomContext`** — sin fallback. Borrar el export `collectDomContext`,
  la constante `DOM_CONTEXT_PROBE` y el import en `runs.ts`. Si el walk no produjo `dom_context`,
  el agente degrada a headings/visible_text (su comportamiento "dom_context unavailable" actual),
  **no** se corre un snapshot alternativo.
- **`dom_context` por caso = unión deduplicada acotada** — unión de `controls`/`headings`/
  `visible_text` de todas las pantallas del walk, deduplicada y limitada a `max_controls`,
  priorizando las pantallas más profundas (post-login).
- **Reusar el grounding/`dom_context` del dry-run** en `execute_run` diferido. Re-walk solo si
  `base_url` cambió o se pasa el flag explícito (`reground: true` / `--reground`).

Riesgos a tener presentes:

- **Riesgo:** el walk es más caro que el snapshot único (recorre pasos), pero **ya corre** en el
  dry-run; la consolidación **elimina** la segunda pasada de ejecución, así que el costo total
  **baja**.
- **Riesgo:** dependencia del codegen en una pasada que muta estado (ver §6). El walk debe seguir
  siendo tolerante (best-effort, no aborta).
- **Riesgo (retiro total):** si el walk falla y no deja `dom_context`, el agente pierde todo el
  contexto DOM y cae a headings/visible_text. Aceptado: el fix del nav_timeout (30s, `ts.18`) y
  el re-walk por `base_url` mitigan el caso de walk fallido.

---

## 8. Tests

- `test/lib-units.test.ts`:
  - `casesToTestPlan` propaga grounding por paso alineado con los steps.
  - `buildCodeGenerationPayload` incluye `resolved_selector`/`candidates`/`status` por paso.
- `test/grounding-walk.e2e.test.ts` (gated Chromium): tras el walk, existe `dom_context.json`
  con `by_case_id`, y la pantalla post-login aparece en sus controles (no solo el login).
- Verificar que el path API no genera `dom_context` ni grounding.

---

## 9. Validación

Desde `ui/`:
```bash
npm run typecheck && npm run lint && npm test
```
- Confirmar que ningún test dependía de `collectDomContext` corriendo en `execute` (ajustar
  eventos/mensajes si algún test los assertea).

---

## 10. Criterios de aceptación

1. En un caso de login, el `dom_context` que recibe el agente contiene controles del
   **dashboard** (pantalla post-login), no solo del login.
2. Para un paso con `resolved_selector`, el código generado **usa ese selector**, no uno
   adivinado.
3. Para un target `ambiguous`, el dry-run lo marca con candidatos y el código generado
   desambigua (no emite un locator que matchea >1 para una interacción).
4. `execute_run` **no** lanza una segunda exploración de DOM cuando el walk del dry-run ya
   corrió (salvo `reground`/cambio de `base_url`).
5. Caso API: sin walk ni dom_context.
6. `npm run check` verde.
