# Plan de implementación — De-hardcodear el normalizador + grounding del login + gate como señal

> **Filosofía del producto (norte de todo el plan):** ProGuide **automatiza el test manual
> del QA**. El QA describe lo que hace y ve, en sus palabras (incluido el login: llena los
> campos, presiona el botón, espera ver la pantalla principal). El trabajo de la herramienta
> es **aterrizar esa intención contra la app real**, no inyectar su propio vocabulario. Cada
> paso = *intención del QA (sus palabras + sus valores)* → *aterrizada contra el DOM real
> (exploración)* → *Playwright fiel*. **Cero fabricación de contenido.**
>
> **Objetivo:** que el normalizador **no fabrique contenido de la app** (textos, selectores,
> rutas, ni "campos email" que la app puede no tener), y que la exploración (grounding +
> `dom_context`, que ya ve el DOM real post-ts.20) + el LLM resuelvan todo contra la pantalla
> real. Cerrar la familia "vocabulario hardcodeado" (A1 `button`, A2 `acceder→go to /`,
> `expect text "Dashboard"`, y los pseudo-pasos de credenciales).
>
> **Principio:** el normalizador parsea **contrato explícito** (lo que el QA escribió textual:
> selectores, valores, textos a verificar) y **tokens estructurales** (`wait`, `timeout`,
> `url`); NO inventa vocabulario de la app ni adivina la semántica de un campo. Lo no explícito
> se aterriza aguas abajo con la exploración, no con un `return` cableado.
>
> **Nota sobre el login:** el login-como-pasos es el **camino principal** (así testea el QA),
> no un fallback. `config.auth`/storageState es solo una optimización opcional para no
> re-loguear en cada test. Por eso el login también debe **aterrizarse contra el DOM real**,
> no resolverse con heurísticas que adivinan "esto es el email".

---

## 1. Diagnóstico: por qué pasó pese a tener exploración

La exploración **verifica un target; no inventa intención.** Ante `expect text "Dashboard"`,
el grounding hizo su trabajo: lo marcó `not_found` con candidatos reales ("Finanzas
familiares"). El bug está **aguas arriba**: el normalizador **fabricó** el target
(`normalize.ts:83`) y nada impidió que esa aserción fabricada llegara a ejecución.

Dos frentes a arreglar:
1. **Origen:** el normalizador fabrica contenido → eliminarlo.
2. **Red de contención:** un `not_found`/`ambiguous` pasa silencioso a ejecución → endurecer.

---

## 2. Triage de `normalize.ts` (qué es qué)

| Tier | Regla | `normalize.ts` | Decisión |
|------|-------|----------------|----------|
| **Mantener** | Parseo de DSL explícito: `fill [selector]`, `click [selector]`, `expect text "X"`, `[label=]`, contextual click/fill, `click button/text "X"` (target del autor) | `explicitStep`, 58-65 | **Conservar** — contrato preciso del QA, no es suposición |
| **Mantener** | Tokens estructurales: `wait N seconds`, `set test/assertion timeout`, `expect url contains`, `go to <ruta real>` | `normalizeTimingStep`, `normalizeUrlAssertion`, `extractRoute` | **Conservar** — no fabrican contenido de la app |
| **Tier 1 — eliminar ya** | `expect text "Dashboard"` (literal inglés inventado) | `:83` | **Eliminar** |
| **Tier 2 — eliminar** | `go to /` cuando hay palabra de navegación pero **sin ruta explícita** (fabrica destino) | `:86` (`NAVIGATION_RE`) | **Eliminar el fallback fabricador**; conservar `go to <ruta>` cuando la ruta es real |
| **Tier 3 — migrar a grounding** | `enter valid/invalid email`, `enter valid/invalid password`, `submit form` | `:67-85` | **Migrar** (ver §4) — el login también se aterriza contra el DOM real |

> **Por qué Tier 3 también se migra (y no se conserva):** estas heurísticas son el **atajo
> legacy** que se saltea la exploración y **adivina la semántica del campo** ("esto es el
> email") y de dónde sacar el valor. Eso contradice la filosofía: el QA, al testear login
> manual, **da el valor explícito** y **ve el campo real**. El modelo correcto separa las dos
> cosas: *valor explícito del QA* + *campo real de la exploración*. Migrar es más trabajo y
> toca el camino más repetido (login), por eso va con **verificación de login dedicada** y,
> idealmente, en una ola posterior a Tier 1+2 (ver §10).

---

## 3. Tier 1 + 2 — eliminar fabricación de contenido (el fix de fondo)

### 3.1 `normalize.ts`
- **Eliminar `:83`** (`expect text "Dashboard"`).
- **Eliminar el fallback `go to /`** de `:86`: si hay intención de navegación pero **no** se
  extrajo una ruta real (`extractRoute` devolvió null), **no** fabricar `/`. Dejar que el
  paso caiga como texto crudo y que el LLM/grounding lo interprete (o marcarlo
  `needs_review` por intención ambigua).

### 3.2 Qué pasa con un paso vago tras eliminarlos
"Verificar que se muestra el dashboard" → ya no se reescribe. Cae como texto crudo →
`parseStepTarget` no encuentra target concreto → grounding no fuerza un `not_found` falso →
el **LLM de codegen** (post-ts.20 ve el `dom_context` post-login real: "Finanzas familiares",
"Junio 2026") asierta un **heading real**. Resultado: aserción anclada a la app, no inventada.

### 3.3 Reforzar el prompt del agente (`agent.ts`)
Para que un paso de aserción vago **no** se traduzca en texto inventado:
```
- Para una aserción cuyo texto/elemento NO aparezca en dom_context ni en steps_grounding
  (status not_found), NO emitas el literal del paso. Asertá un heading/texto REAL del
  dom_context (o un candidato de steps_grounding). Nunca asertes texto que no exista en la
  pantalla.
```
(Complementa la regla `not_found → fall back to dom_context` ya existente, haciéndola
imperativa para aserciones.)

---

## 4. Tier 3 — migrar login/credenciales a grounding (valor del QA + campo real)

**Consumidores hoy:** `views/code.ts` (helpers `fillEmail`/`fillPassword`/`clickSubmit`,
`:512-544`) y el LLM (reglas de credenciales del prompt). `parseStepTarget` no los toca.

**Modelo objetivo — separar valor y campo:** así testea el QA manual: teclea un **valor
explícito** en un **campo que ve**. La herramienta debe respetar eso:
- **El valor** lo da el QA en el paso (`fill ... with eolivera`) o, si lo deja implícito,
  sale de `data.user`/`PROGUIDE_USER_*` (sin literal en el caso).
- **El campo** lo encuentra la **exploración** (`input[name="username"]`, `input[type=password]`
  del `dom_context`), NO una heurística que adivina "esto es el email".

**Cambios:**
1. **`normalize.ts`:** eliminar las heurísticas `enter valid/invalid email`,
   `enter valid/invalid password`, `submit form` (`:67-85`). Un paso de login del QA pasa a
   ser un `fill`/`click` normal (DSL explícito si el QA dio selector/valor; texto crudo si no).
2. **`agent.ts` (prompt):** regla de credenciales aterrizada — "para llenar usuario/clave,
   usá el input real del `dom_context`/`steps_grounding` y el valor de `data.user` (o el literal
   del paso); no asumas que un campo es 'email' por su nombre". Para el submit, click sobre el
   botón real (por su texto/rol del `dom_context`), no un `clickSubmit` genérico.
3. **`views/code.ts`:** ajustar/retirar `fillEmail`/`fillPassword`/`clickSubmit` para que el
   preview también llene el input real con el valor del QA, coherente con el agente.
4. **Verificación de login end-to-end obligatoria** antes de soltar: el caso real
   (`eolivera`/`habacuc2:4` → `input[name="username"]`/`password` → botón "Entrar" → pantalla
   principal) debe pasar igual que hoy.

> Esta migración toca el camino más repetido (login en cada test autenticado). Por eso va en
> **ola 2** (después de Tier 1+2), con su verificación dedicada. No es "conservar vs migrar":
> se **migra**, pero por separado para poder bisecar si algo falla.

---

## 5. Gate como SEÑAL, nunca bloqueo duro

Hoy un target `not_found`/`ambiguous` marca `needs_review` pero no impide ejecutar.
**Decisión:** lo dejamos como **señal**, no bloqueo. Motivo: el grounding tiene **falsos
`not_found`** (solo ve ciertos elementos del snapshot; texto en `<span>`, contenido dinámico
o pantalla no alcanzada por el walk). Un gate duro convertiría esos falsos positivos en
**runs bloqueados** y mataría el camino "calibrar ejecutando" del skill. Net-negativo.

Dos piezas (ambas se hacen, ninguna bloquea):
1. **Codegen defensivo (§3.3):** ante `not_found`, el LLM nunca emite el texto fabricado; usa
   `dom_context`/candidato real. Es la defensa principal.
2. **Señal en el resultado:** un caso con targets `not_found` ejecutado igual queda visible
   como `needs_calibration` aunque "pase" por azar (evita verde falso).

> **Descartado:** gate duro bloqueante. No se implementa.

---

## 6. Cambios archivo por archivo (orden)

**Ola 1 — Tier 1+2 + codegen defensivo + señal (acotado, alto impacto, sin tocar login):**
1. **`ui/lib/cases/normalize.ts`** — eliminar `:83` (Dashboard) y el fallback `go to /` de
   `:86`.
2. **`ui/lib/codegen/agent.ts`** — regla imperativa de §3.3 (no asertar texto inexistente) +
   regla de navegación inicial (ver §7, riesgo Tier 2).
3. **`ui/views/code.ts`** — preview: para una aserción sin texto real, no emitir un `expect`
   de literal inventado; degradar a `expect(page.locator('body'))` o un heading del caso.
4. **`runs.ts`/`runner`** — marcar `needs_calibration` un caso con targets `not_found`
   ejecutado (señal §5.2), sin bloquear.
5. **Docs:** `skills/SKILL.md` (x2) — reforzar "usá el texto/heading literal real de la
   pantalla post-login; no asumas 'Dashboard' ni nombres genéricos".

**Ola 2 — Tier 3 (migración del login, con verificación dedicada):**
6. `normalize.ts` + `agent.ts` + `views/code.ts` — migrar credenciales/submit a grounding
   (valor del QA + campo real), según §4. **Verificar login end-to-end antes de soltar.**

---

## 7. Edge cases / riesgos

- **Riesgo Tier 2 — navegación inicial (IMPORTANTE):** el `go to /` fabricado hoy dispara la
  navegación inicial de muchos casos. El preview determinista ya se cubre solo (auto-goto a
  la ruta del caso si ningún paso navegó: `views/code.ts:176`), **pero el código del LLM no
  tiene esa red** — solo navega ante un paso `go to`. Si quitás el fallback sin compensar,
  algunos casos arrancarían en `about:blank`.
  **Mitigación obligatoria:** agregar en el prompt del agente la regla "todo test UI navega a
  la ruta del caso (`route`) al inicio, haya o no un paso de navegación explícito". Sin esto,
  Tier 2 rompe la navegación inicial.
- **Pasos vagos sin dom_context** (walk falló): el LLM no tiene heading real → debe degradar
  a algo seguro (visibilidad de `body`/heading del caso), nunca inventar. Cubierto por §3.3.
- **Regresión congelada:** no usa LLM; corre el `.spec.ts` ya generado. Sin impacto.
- **Riesgo Tier 3 (ola 2):** romper el login (camino más repetido). Mitigación: verificación
  end-to-end dedicada (§4.4) antes de soltar; por eso va en ola separada para poder bisecar.

---

## 8. Tests

- `test/lib-units.test.ts`:
  - `normalizeStep('verificar que se muestra el dashboard')` **ya no** devuelve
    `expect text "Dashboard"` (queda crudo / sin fabricar).
  - `normalizeStep(<paso de navegación sin ruta>)` no devuelve `go to /`.
  - Las regresiones de DSL explícito (Tier 1 "mantener") siguen intactas (asserts existentes).
  - (Ola 2) `normalizeStep('completar usuario con eolivera')` **ya no** devuelve
    `enter valid email`; queda como `fill` / texto crudo a aterrizar.
- `views/code.ts`: una aserción sin texto real no genera un `expect` de literal inventado.
- Señal: un caso con target `not_found` ejecutado no reporta verde falso (queda
  `needs_calibration`).
- E2E de grounding: con `dom_context` post-login, un paso vago de aserción produce un assert
  contra un heading real (no "Dashboard"); el test UI navega a la ruta al inicio aunque no
  haya paso `go to` (regla compensatoria de §7).

---

## 9. Validación

```bash
npm run typecheck && npm run lint && npm test
```
Ajustar cualquier test que asertara el comportamiento viejo (`expect text "Dashboard"` /
`go to /` fabricado).

---

## 10. Criterios de aceptación

**Ola 1:**
1. `normalizeStep` **no** produce `expect text "Dashboard"` ni `go to /` fabricado para
   ningún input.
2. Un caso de login contra una app en español asierta un **heading real** de la pantalla
   post-login (tomado de `dom_context`), no un literal inventado.
3. Todo test UI navega a la ruta del caso al inicio aunque no haya paso `go to` (compensación
   Tier 2, §7).
4. Las reglas de DSL explícito y tokens estructurales (Tier 1 "mantener") siguen idénticas.
5. Un target `not_found` ejecutado no termina en verde falso (`needs_calibration`).
6. `npm run check` verde.

**Ola 2:**
7. `normalizeStep` no produce `enter valid email`/`enter valid password`/`submit form`.
8. El login `eolivera`/`habacuc2:4` (campo real + valor del QA) sigue pasando end-to-end.

---

## 11. Decisiones tomadas (confirmadas por el owner)

- **Filosofía:** automatizar el test manual del QA, aterrizado contra la app real, **cero
  fabricación de contenido**. El login-como-pasos es el camino principal.
- **Tier 1+2:** eliminar `expect text "Dashboard"` y el fallback `go to /` (con regla
  compensatoria de navegación inicial).
- **Tier 3:** **migrar** login/credenciales a grounding (valor del QA + campo real), en **ola
  2**, con verificación de login end-to-end.
- **Gate:** **señal** (`needs_calibration`) + codegen defensivo. **Gate duro bloqueante:
  descartado.**
- **Olas:** Ola 1 (Tier 1+2 + defensivo + señal) primero; Ola 2 (Tier 3 login) por separado.

> Implementación: a cargo del owner. Al terminar cada ola, correr `npm run check`; para Ola 2,
> además la verificación de login end-to-end antes de release.
