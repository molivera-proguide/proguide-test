# Plan de implementación — Fixes de feedback QA (rondas 1 y 2)

> **Objetivo:** corregir los bugs reportados en `proguide_feedback_2026-06-24.md` (5 issues)
> y los 3 errores de la sesión de Claude Desktop, priorizando los que causan **timeouts
> silenciosos de 900s** (severidad Alta), que son el peor síntoma para QA.
>
> **Principio rector (intacto):** ProGuide entrega DSL/DOM deterministas; el agente pone el
> juicio. Ningún fix debe auto-elegir selectores ni relajar verificaciones para "pasar".

---

## 1. Inventario de bugs y causa raíz

| ID | Issue | Sev. | Archivo:línea | Tipo de fix |
|----|-------|------|---------------|-------------|
| **A1** | `click "TEXT"` siempre genera `button:has-text()` (timeout en `<li>`/nav) | Alta | `cases/normalize.ts:59,480-492` + `codegen/grounding.ts:334` | Código |
| **A2** | `Click the "X" button` → `go to /` (la palabra "acceder/entrar" dispara navegación) | Alta | `cases/normalize.ts:21,80,483` | Código |
| **B1** | Casos no-`listo` filtrados en silencio → error opaco "No hay casos para generar código" | Media | `codegen/test-plan.ts:22` + `run-store/runs.ts:589-601` | Código |
| **C1** | `fill ... inside ... section` → atributo `name` alucinado | Media | `cases/normalize.ts:238` (falta fill contextual) + `codegen/agent.ts:52` | Código + prompt |
| **C2** | `[label="X"]` hace substring match → strict mode con labels similares | Baja | sin contrato determinista (lo arma el LLM) + `codegen/agent.ts` | DSL + prompt |
| **D1** | `set test timeout` es global (incluye `wait N seconds`) | Media | comportamiento correcto de Playwright | Doc skill |
| **D2** | Toast desaparece tras redirect antes del assertion | Baja | autoría de tests | Doc skill |

> **B1 unifica los errores #2 y #3 de Claude Desktop**: `run_cases` con markdown inline y
> `execute_run` con `run_id` fallan por la **misma** causa (el plan queda vacío tras filtrar
> casos que no quedaron `'listo'`). No son bugs separados.

---

## 2. Fix A2 — `Click the "X" button` → `go to /` (Alta, el más rápido)

**Causa raíz confirmada (`cases/normalize.ts`):**
1. `extractClickTarget` (`:480`) ancla el regex a `$` y espera el target al final. Con el
   inglés `Click the "Acceder" button` el target va **entre comillas a mitad de frase** y la
   palabra `button` queda al final → captura `"button"` → excluido (`:489`) → `null`.
2. Al no reconocerse el click, `normalizeStep` cae al fallback `NAVIGATION_RE` (`:80`):
   `if (NAVIGATION_RE.test(normalized)) return 'go to /'`. Ese regex (`:21`) incluye
   `acceder`/`entrar`/`abrir`/`volver` → cualquier botón con ese texto se vuelve navegación.

### 2.1 Cambios

**a) `extractClickTarget` — preferir target entre comillas en cualquier posición.**
Agregar, **antes** de los patrones actuales, un patrón que capture el texto entrecomillado:

```ts
function extractClickTarget(step: unknown): string | null {
  const text = String(step);
  // 0. Preferir SIEMPRE un target entre comillas (soporta "Click the \"X\" button",
  //    'clic en "Guardar"', etc.). Un valor entrecomillado es un label real aunque sea
  //    "button" → no aplicar la lista de exclusión a capturas entrecomilladas.
  const quoted = text.match(
    /(?:click|clic|hacer\s+clic|press|presionar|seleccionar|tocar|tap)\b[^"']*["']([^"']+)["']/i
  );
  if (quoted) {
    const target = quoted[1].trim().replace(/[.,;]+$/, '');
    if (target) return target;
  }
  // 1-2. patrones existentes (sin comillas) — mantener la exclusión button/boton/formulario
  ...
}
```

**b) Guard del fallback de navegación (defensa en profundidad).**
Aunque (a) ya intercepta el caso, blindar `normalizeStep` para que el fallback `go to /` no
dispare cuando el paso es claramente una interacción:

```ts
// en normalizeStep, antes de la línea 80
const isInteraction =
  /^\s*(?:click|clic|hacer\s+clic|press|presionar|seleccionar|tocar|tap|fill|completar|escribir|ingresar)\b/i
    .test(String(step || '').trim());
...
if (!isInteraction && NAVIGATION_RE.test(normalized)) return 'go to /';
```

### 2.2 Tests
- Nuevo en `test/lib-units.test.ts` (bloque "feedback DSL regressions"):
  - `normalizeStep('Click the "Acceder" button')` → ver §3 para el output esperado (depende
    de si A1 cambia `click button X` por `click text "X"`).
  - `normalizeStep('Press "Entrar"')` → no debe ser `go to /`.
  - `normalizeStep('clic en "Volver"')` → no debe ser `go to /`.
- Verificar que **no rompe** `normalizeStep('Ir a /login') === 'go to /login'` (`:104`).

---

## 3. Fix A1 — `click "TEXT"` hardcodea `button` (Alta)

**Causa raíz (dos capas):**
1. **Normalización:** cualquier click NL sin selector reconocido cae en `extractClickTarget`
   y `normalizeStep:59` devuelve `click button ${target}` — el tag `button` se inyecta sin
   ver el DOM.
2. **Snapshot ciego a `<li>`:** el walk de grounding (`grounding.ts:334`) sólo recolecta
   `input, textarea, select, button, a, [role], [data-testid]...`. Un `<li>` de nav **sin
   `role`** nunca entra en `controls`, así que el grounding no puede detectar que el tag
   correcto era `li` ni proponer `li:has-text(...)`.

Luego el agente recibe `click button X` como DSL autoritativo y emite `button:has-text("X")`
→ timeout de 900s en nav items.

### 3.1 Decisión de diseño (requiere confirmación)

**Recomendado: click NL genérico → role-agnóstico.** Cambiar el output de los clicks NL sin
mención explícita de "button/botón" de `click button X` a **`click text "X"`**, que el
pipeline traduce a `page.getByText("X").click()` (matchea cualquier elemento: `<li>`, `<a>`,
`<div>`, `<button>`). Es estrictamente más general que forzar `button` y coincide con lo que
QA verificó que funciona (texto literal / `li:has-text`).

- Si el origen menciona explícitamente **"button"/"botón"** → mantener `click button X` →
  `getByRole('button', { name })` (intención explícita del autor).
- `extractClickTarget` ya distingue el grupo opcional `(?:button\s+|boton\s+)?`; devolver
  también un flag `isButton` para decidir el verbo de salida.

> **Trade-off:** `getByText` puede matchear más de un elemento o texto no-clickeable. Mitiga:
> el grounding (con el snapshot ya extendido a `<li>`, §3.2) marca `ambiguous` en el dry-run
> y el agente desambigua. Es preferible a un `button` garantizadamente incorrecto.

**Alternativa (menos invasiva):** dejar `click button X` pero que el agente genere un locator
role-agnóstico. Se descarta: deja la decisión en el LLM (no determinista) y contradice el
principio de DSL autoritativo.

### 3.2 Cambios

**a) `cases/normalize.ts` — emitir `click text "X"` para clicks genéricos.**
- `normalizeStep:59`: si `extractClickTarget` indica que NO hubo "button/botón" explícito →
  `return 'click text ' + JSON.stringify(clickTarget)`; si lo hubo → `click button ${target}`.

**b) `codegen/grounding.ts` — `parseStepTarget` soporta `click text "X"` (sin `inside`).**
Hoy `clickTextMatch` (`:92`) exige `inside`. Agregar branch:
```ts
const clickTextBare = action.match(/^click text\s+["'](.+?)["']\s*$/i);
if (clickTextBare) return { type: 'text', value: clickTextBare[1] };
```
(El `click X` plano de `:120` ya cubre el fallback, pero el form explícito `click text "X"`
debe ser inequívoco.)

**c) `codegen/grounding.ts` — snapshot incluye `<li>` y elementos clickeables sin rol.**
En `DOM_SNAPSHOT_JS` (`:334`) extender el `querySelectorAll`:
```js
'input, textarea, select, button, a, li, label, [role], [onclick], [data-testid], [data-test], [data-cy]'
```
- En `selectorHint` (`:327`), para un `<li>` sin id/testid/name devolver un hint útil basado
  en texto, p. ej. `li:has-text("...")`, en vez del bare `li`. (Definir helper que use el
  texto recortado del elemento.)
- **Replicar el mismo cambio** en el snapshot de `inspect` si vive aparte
  (`codegen/dom-context.ts`) para mantener consistencia entre `inspect_route` y el walk.

**d) `codegen/agent.ts` — regla de prompt para `click text "X"`.**
Agregar a las reglas de DSL autoritativo (`:36-46`):
```
- click text "value" -> page.getByText(value).click()  (role-agnóstico; NO asumir button)
- click button "value" -> page.getByRole('button', { name: value }).click()
```

**e) Walk probe `advance()` (`grounding.ts:376`).** Ya maneja `click X` genérico vía
`getByText` (`:389-393`). Confirmar que `click text "X"` cae en ese branch (el regex
`^click\s+(.+)$` captura `text "X"` → ajustar para extraer el texto entrecomillado, o añadir
un branch dedicado a `click text`).

### 3.3 Tests (migración)
- **Romperán y hay que actualizar** (cambio de contrato intencional):
  - `test/lib-units.test.ts:385` `parseStepTarget('click button Acceder')` → sigue válido
    (mantenemos `click button` para el caso explícito). **No cambia.**
  - Revisar `test/grounding-walk.e2e.test.ts:52` (usa `click button Acceder`) — sigue válido.
- **Nuevos:**
  - `normalizeStep('click "BPM"')` → `'click text "BPM"'`.
  - `normalizeStep('Click the "Solicitar nuevo Caso"')` → `'click text "Solicitar nuevo Caso"'`.
  - `normalizeStep('click button "Acceder"')` o `'haz clic en el botón "Acceder"'` →
    `'click button Acceder'` (mantiene rol explícito).
  - `parseStepTarget('click text "BPM"')` → `{ type: 'text', value: 'BPM' }`.
  - Grounding: snapshot con un `<li>BPM</li>` → `groundStepAgainstSnapshot` resuelve/propone
    el `<li>`.

---

## 4. Fix B1 — Error opaco "No hay casos para generar código" (Media)

**Causa raíz:** `casesToTestPlan` filtra **en silencio** todo caso `automation_state !== 'listo'`
(`test-plan.ts:22`). Si el markdown se parsea pero algún caso queda `necesita_revision` /
`no_automatizable_aun` (steps o expected vacíos por formato no reconocido), el plan queda
vacío y `executePreparedRun` lanza el genérico `No hay casos para generar codigo`
(`runs.ts:600`) — sin decir **qué** caso ni **por qué**. `create_run` además dejó el run como
`status: 'ready'` (`runs.ts:288`), así que el fallo es silencioso hasta ejecutar.

### 4.1 Cambios (diagnóstico — must-have)

**a) Error accionable en `runs.ts` (~`:589`).** Cuando `plan.cases.length === 0` pero
`cases.length > 0`, construir un mensaje que liste cada caso descartado con su estado:
```ts
if (!plan.cases.length) {
  const dropped = cases
    .filter((c) => !c.excluded)
    .map((c) => `- ${c.id} (${c.title}): ${c.automation_state} — ${c.state_reason}`);
  const detail = dropped.length
    ? `Todos los casos quedaron fuera del plan:\n${dropped.join('\n')}\n` +
      `Sólo se generan casos en estado 'listo'. Revisá pasos/resultado esperado o pasá los casos como JSON estructurado.`
    : 'No hay casos para generar codigo. Revisa normalized_cases.json.';
  // ...event + throw new Error(detail)
}
```

**b) Aviso temprano en `prepareMarkdownRun` / `prepareCasesRun`.** Tras normalizar, si
`cases.filter(c => c.automation_state === 'listo').length === 0`:
- emitir un `appendEvent` de tipo `warning` ("N caso(s) interpretados, 0 automatizables");
- marcar `run.status = 'blocked'` (no `'ready'`) para que el dry-run lo refleje y `create_run`
  no devuelva un run engañosamente "listo".

**c) Exponer el estado en la respuesta MCP de `create_run`.** En el payload del dry-run
(`mcp-server.ts:577`) ya va `prepared.cases`; agregar un resumen `automation_summary`
(`{ listo, necesita_revision, no_automatizable_aun }`) para que el agente lo vea sin abrir el
viewer.

### 4.2 Decisión opcional (requiere confirmación)
¿Permitir generar código para `necesita_revision` (no sólo `'listo'`)? Hoy el gate puede ser
demasiado estricto: un caso con steps válidos pero `expected` genérico queda fuera. Opción:
en `casesToTestPlan` incluir `necesita_revision` marcándolos `needs_review` en el plan, y
dejar `no_automatizable_aun` fuera. **No lo incluyo por defecto** (cambia política de
calibración); lo dejo como decisión del owner.

### 4.3 Tests
- `test/lib-units.test.ts` o `api-e2e.test.ts`: un set de casos donde todos quedan
  `necesita_revision` → `executePreparedRun` lanza error que **contiene el id y el estado**
  de cada caso (no el genérico).
- Markdown inline mal formado (sin "Resultado esperado") → `create_run` devuelve
  `automation_summary` con `listo: 0` y `run.status === 'blocked'`.

---

## 5. Fix C1 — `fill ... inside section` → atributo alucinado (Media)

**Causa raíz:** `normalizeContextualClick` (`normalize.ts:238`) sólo cubre `click ... inside`.
Para `fill the "X" input inside the "Y" section with "Z"` no hay normalizador → el paso pasa
crudo al LLM, que inventa `input[name="contactName"]`. El prompt (`agent.ts:52`) prohíbe
inventar `data-testid`/`id` pero **no `name`/`placeholder`**.

### 5.1 Cambios
**a) Nuevo `normalizeContextualFill` en `normalize.ts`** (espejo de `normalizeContextualClick`):
```
fill the "Nombre" input inside the "Persona de contacto técnico" section with "Mariano"
→  fill text "Nombre" inside [<selector-de-seccion>] with "Mariano"
```
- Reusar `cleanCssSelectorTarget` / `isCssSelectorTarget` para la sección cuando es un
  selector; si la sección es texto libre (no selector), degradar a `fill [label="Nombre"] with "Mariano"`
  (sin scoping de sección) — determinista y sin inventar atributos.
- Registrar en `explicitStep` (junto a `normalizeContextualClick`, `:158`).

**b) Endurecer el prompt (`agent.ts:52`).** Cambiar "Never invent data-testid/id selectors"
por: **"Never invent `data-testid`, `id`, `name` or `placeholder` attribute values. Use only
attributes present in `dom_context.snapshot.controls[]`. Si no hay selector estable, usar
`getByLabel`/`getByText` con el texto literal del paso."**

**c) (Si C1.a emite `fill text "X" inside [sel]`)** soportarlo en `parseStepTarget`,
`agent.ts` (`fill text "v" inside [sel] -> page.locator(sel).getByLabel(v)...`) y walk.

### 5.2 Tests
- `normalizeStep('fill the "Nombre" input inside the "Persona ..." section with "Mariano"')`
  → forma determinista esperada (sin `name=` inventado).

---

## 6. Fix C2 — `[label="X"]` substring match (Baja)

**Causa raíz:** `[label="X"]` **no existe como contrato** en `ui/lib` (grep vacío). Lo expande
el LLM a `label:has-text("X") >> .. >> input`; `has-text` es **substring** → matchea también
`"Nombre empresa"` → strict mode violation.

### 6.1 Cambios
**a) Contrato determinista para `[label="X"]` en codegen/prompt.** En `agent.ts`, regla
explícita:
```
- fill [label="X"] with v  -> page.getByLabel("X", { exact: true }).fill(v)
- expect [label="X"] ...    -> usar getByLabel exacto
```
`getByLabel` con `exact: true` evita el substring y no depende de `:not(.MuiFormLabel-filled)`.
- Documentar en el prompt: **"`:has-text()` es substring; para labels usar coincidencia
  exacta (`getByLabel(x,{exact:true})` o `:text-is(...)`)."**

**b) (Opcional) normalizar `[label="X"]` en `normalize.ts`** a una forma canónica
`fill label="X" exact with v` para que el contrato no dependa del LLM. Evaluar si vale la
complejidad vs. (a).

### 6.2 Tests
- Snapshot de codegen / unit del prompt-mapping: `fill [label="Nombre"] with "Mariano"` no
  produce `label:has-text("Nombre")` substring. (Si se hace 6.1.b, test en `normalizeStep`.)

---

## 7. Fixes D1 / D2 — Documentación en el skill (no código)

Editar **ambas copias**: `skills/SKILL.md` y `ui/skills/qa-test-cases/SKILL.md`.

- **D1 (timeout global):** en la tabla de errores comunes / sección de timeouts:
  > "`set test timeout` limita la duración **total** del test, incluyendo `wait N seconds`.
  > Para SSO/flujos lentos, preferir espera dinámica (`expect <elemento> to be visible`) en vez
  > de tiempo fijo. Reservar timeouts altos sólo cuando sea estrictamente necesario."
- **D2 (toast tras redirect):** en errores comunes:
  > "Si un submit/click redirige la página, el toast de éxito puede desaparecer antes del
  > assertion. Verificar un texto estable de la página destino en vez del toast."
- **Bonus (deriva de A1):** documentar que el click NL genérico ahora es **role-agnóstico**
  (`getByText`), y que para forzar un rol se escribe `click button "X"` o el selector explícito
  (`li:has-text("X")`, `[data-testid=...]`).

---

## 8. Orden de implementación sugerido

| # | Fix | Por qué este orden | Archivos |
|---|-----|--------------------|----------|
| 1 | **A2** | El más barato y de alta severidad; aislado en `normalize.ts` | `cases/normalize.ts` + tests |
| 2 | **A1** | Alta severidad; toca normalize + grounding + agent (núcleo) | `normalize.ts`, `grounding.ts`, `dom-context.ts`, `agent.ts` + tests |
| 3 | **B1** | Quita el fallo silencioso que bloqueó la sesión completa | `test-plan.ts`, `runs.ts`, `mcp-server.ts` + tests |
| 4 | **C1** | Reduce alucinaciones de `fill` | `normalize.ts`, `agent.ts` + tests |
| 5 | **C2** | Baja; contrato de label | `agent.ts` (+ opcional `normalize.ts`) + tests |
| 6 | **D1/D2** | Doc, sin riesgo | `skills/SKILL.md` x2 |

> A1 y A2 comparten `normalize.ts`: definir primero el contrato de salida (`click text "X"`
> vs `click button X`) y luego ajustar tests de una sola vez para evitar churn.

---

## 9. Validación

Tras cada fix, correr desde `ui/`:
```bash
npm run typecheck      # tsc --noEmit
npm run lint           # reglas a error (0 warnings)
npm test               # build + node --test (suite actual: ~50 tests)
```
- Los **golden tests** (`test/parsing-golden.test.ts`) y `lib-units.test.ts` son la red de
  seguridad del pipeline de parsing/normalización: actualizarlos en el mismo commit que el
  cambio de contrato, nunca después.
- E2E de grounding (`test/grounding-walk.e2e.test.ts`) cubre el walk; verificar que el snapshot
  extendido a `<li>` no rompe los conteos esperados.

---

## 10. Criterios de aceptación

1. **A2:** `Click the "Acceder" button`, `Press "Entrar"`, `clic en "Volver"` normalizan a un
   click (no a `go to /`). `Ir a /login` sigue siendo `go to /login`.
2. **A1:** `click "BPM"` (nav `<li>`) normaliza role-agnóstico y el dry-run resuelve/propone
   el `<li>` real; el código generado **no** es `button:has-text("BPM")`. No más timeouts de
   900s por tag incorrecto.
3. **B1:** un run cuyos casos quedan todos fuera del plan falla con un error que **nombra cada
   caso y su `automation_state`**; `create_run` con markdown no-automatizable devuelve
   `automation_summary` y `status: 'blocked'`, no `'ready'`.
4. **C1:** `fill ... inside ... section` produce DSL determinista sin `name=` inventado.
5. **C2:** `[label="X"]` genera coincidencia **exacta** de label, sin strict mode violation
   ante labels que se contienen (`"Nombre"` vs `"Nombre empresa"`).
6. **D1/D2:** documentados en ambas copias del skill.
7. `npm run check` verde (typecheck + lint + tests).

---

## 11. Riesgos y decisiones abiertas

- **[Decisión] A1 — ¿role-agnóstico por defecto?** Recomendado sí (§3.1). Confirmar antes de
  migrar tests, porque cambia el contrato de `normalizeStep` para clicks NL.
- **[Decisión] B1 — ¿incluir `necesita_revision` en el plan?** (§4.2) Cambia política de
  calibración; default: **no**, sólo mejorar diagnóstico.
- **Riesgo A1:** `getByText` puede ser ambiguo. Mitigado por el grounding extendido a `<li>`
  (marca `ambiguous` en dry-run) + desambiguación del agente.
- **Consistencia de snapshots:** el cambio del `querySelectorAll` debe replicarse en `inspect`
  y en el walk para que `inspect_route` y el dry-run vean los mismos elementos.
- **`dist/` versionado:** el repo trae `ui/dist/`. Confirmar si se regenera en build/release
  (`npm run build`) o si hay que commitearlo; no editar `dist/` a mano.
