# Plan (POC) — Explorador agéntico + mapa de producto (paridad TestSprite)

> **Rama:** `mapping-poc`. Documento de diseño para un **proof-of-concept**, no una
> implementación comprometida a `main`. Objetivo: evaluar el esfuerzo real de igualar la
> exploración autónoma que hace TestSprite ("nuestro agente está revisando cada función de
> su mapa de producto") y decidir si la adoptamos.

---

## 1. Objetivo

Que ProGuide, **antes** de generar tests, recorra la app de forma **autónoma** (un agente LLM
manejando el browser), **descubra las pantallas/funciones** (login → dashboard → módulos),
**capture el DOM real de cada una** y persista un **mapa de producto** navegable. Ese artefacto
alimenta grounding + codegen, de modo que la herramienta **nunca asierta ni selecciona algo que
no vio** en la app real.

**No confundir con la Ola #2 (ya hecha, `ts.24`):** aquella hace que el walk *por caso* complete
el login y capture el post-login. Esto (#1) es la capa superior: una **exploración de la app
completa, dirigida por un agente**, independiente de un caso puntual.

---

## 2. Por qué TestSprite puede y nosotros (aún) no

| | TestSprite | ProGuide hoy |
|---|---|---|
| Exploración | **Agente LLM** que navega solo y razona pantalla por pantalla | Walk **determinista, por caso**, reproduce los pasos del caso |
| Alcance | App entera → mapa de producto | Ruta del caso + sus pasos |
| Autonomía | Decide a dónde ir/clickear | No decide; ejecuta el DSL del paso |
| Costo | Créditos + ~3 min (tokens + browser) | Barato/rápido (LLM solo en codegen) |

No es un límite técnico: es una decisión de diseño (determinismo sobre autonomía). Para igualarlo
falta **el lazo agéntico** que una los ladrillos que ya tenemos.

---

## 3. Ladrillos existentes que se reutilizan

- **Browser driving:** `ui/playwright-runtime.ts` (shim) + `runProcess`.
- **Snapshot de DOM / a11y + candidatos de selector:** `DOM_SNAPSHOT_JS` (en `grounding.ts`) y
  `inspect_route` / `viewer` (árbol de accesibilidad, `selector_hint`).
- **Sesión autenticada:** bloque `auth` + `ensureSession` (`lib/auth/session.ts`) + `storageState`.
- **LLM estructurado:** `callJsonModel` (`lib/llm/anthropic.ts`) con esquema forzado y registro de
  uso (`recordLlmUsage`).
- **Merge de pantallas:** `mergeWalkSnapshots` (`grounding.ts`) — base para unir el DOM de varias
  pantallas.

Lo que falta es un **orquestador agéntico** encima de estos.

---

## 4. Arquitectura propuesta

Un loop **observar → decidir → actuar**, con el LLM como cerebro y Playwright como manos:

```
estado inicial: goto(base_url) [+ storageState si hay auth]
frontera = []; visitados = Set()
while (presupuesto disponible && hay algo por explorar):
  snapshot = DOM_SNAPSHOT_JS(page)          // observar (barato, determinista)
  screenKey = hash(url + headings + controles-clave)
  if screenKey in visitados: retroceder/elegir otra acción; continue
  visitados.add(screenKey); guardar snapshot en el mapa
  acción = LLM.decidir(snapshot, objetivo, visitados)   // decidir (1 llamada acotada)
  ejecutar(acción)                          // actuar: click / fill / goto / back / login
  registrar arista (screen → acción → screen')
persistir product_map.json
```

- **El LLM elige la próxima acción** de un **espacio acotado y seguro** (ver §6), recibiendo el
  snapshot actual + lista de pantallas ya vistas + objetivo ("mapear funciones principales").
- **El snapshot es determinista** (no gasta LLM): la observación es barata; solo la *decisión*
  cuesta tokens. Así el costo escala con nº de acciones, no con el tamaño del DOM.
- **Dedup de pantallas** por `screenKey` para no entrar en loops (misma pantalla, distinto scroll).

---

## 5. Modelo de datos: `product_map.json`

```jsonc
{
  "base_url": "https://web-suite.tst.proguidemc.com",
  "generated_at": "<iso>",
  "authenticated": true,
  "features": [                      // el "mapa de producto" (cards de la UI de TestSprite)
    { "id": "vulnops", "label": "VulnOps", "entry_route": "/vulnops",
      "reached_from": "dashboard", "screen_ids": ["scr_3", "scr_4"] }
  ],
  "screens": {
    "scr_1": {
      "url": "…/login", "title": "…", "role": "login",
      "headings": ["Iniciar sesión"],
      "controls": [ /* forma de DOM_SNAPSHOT_JS: selector_hint, role, text, data_testid… */ ],
      "reached_by": [{ "from": "scr_0", "action": "goto /" }]
    }
  },
  "edges": [ { "from": "scr_1", "action": "click 'Acceder'", "to": "scr_2" } ]
}
```

**Integración con lo existente:** `screens[].controls` usa **la misma forma** que
`dom_context.by_case_id[].snapshot.controls`. Un adaptador arma el `dom_context` de un caso como la
**unión de las pantallas relevantes** (por ruta/feature), reemplazando/enriqueciendo el walk por
caso. Cero cambios en `generateTestsWithAgent` (consumidor transparente).

---

## 6. Espacio de acciones (seguro por diseño)

El agente **solo** puede emitir acciones de una lista blanca:

- `goto <ruta interna>` (mismo origin; nunca dominios externos).
- `click <selector_hint del snapshot>` — solo elementos **presentes** en el snapshot actual.
- `fill <selector_hint> with <valor de test>` — para login usa credenciales de `auth`/env; para
  otros campos, datos sintéticos claramente de prueba.
- `back` / `restart` (volver a base_url).
- `stop` (el agente declara el mapa completo).

**Prohibido / mitigado (lectura-first):**
- No enviar formularios que parezcan **destructivos** (heurística por texto: "eliminar", "borrar",
  "pagar", "confirmar", "delete", "remove") salvo allowlist explícita.
- Denylist de rutas (`/logout`, `/admin/*`, etc.) configurable.
- Nunca teclear secretos literales; credenciales solo vía `auth`/env (igual que hoy).
- Presupuesto duro: `max_steps`, `max_seconds`, `max_tokens` → corta y persiste lo alcanzado.

---

## 7. Integración en el ciclo de vida

Dos formas (la POC hace la B):

- **A (producto):** una fase `explore` que corre 1 vez por app/base_url, cachea `product_map.json`
  (con TTL / invalidación por cambio de UI) y todos los runs siguientes lo consumen. Es el modelo
  TestSprite (explorar una vez, testear muchas).
- **B (POC):** un comando/*tool* nuevo aislado — `proguide explore --base-url … [--json]` y
  `explore_map` en MCP — que produce `product_map.json` y un viewer simple, **sin** tocar el
  pipeline de runs todavía. Permite evaluar calidad/costo antes de integrarlo.

---

## 8. Alcance de la POC (mínimo demostrable)

1. Comando `proguide explore` (o script en `scripts/`) que:
   - Abre browser, aplica `auth`/storageState si hay.
   - Corre el loop §4 con presupuesto por defecto (`max_steps=25`, `max_seconds=180`).
   - Emite `product_map.json` (§5) + un `explore.html` para ver el mapa.
2. Prompt del agente (`callJsonModel`) con esquema forzado para la acción (§6).
3. Reutiliza `DOM_SNAPSHOT_JS` y `ensureSession` tal cual.
4. **Validación:**
   - Fixture local (el mismo `login → dashboard` del e2e del walk): el mapa debe tener ≥2 pantallas
     (login + dashboard) y detectar el control de logout.
   - Una app real (`web-suite.tst` o `test-cursor-front-e2e`): el mapa debe listar los módulos
     visibles del dashboard (VulnOps, BPM, Módulo Salud, Reportes…) con su DOM.
5. Medir **costo** (tokens/USD) y **tiempo** por exploración → decidir viabilidad.

**Fuera de alcance de la POC:** cachear/invalidar el mapa, integrarlo al `dom_context` de runs,
UI tipo TestSprite, exploración multi-usuario/roles.

---

## 9. Fases

- **F0 — Andamiaje:** comando `explore` + loop mínimo (goto, snapshot, stop). Sin LLM: BFS ingenuo
  por links visibles. Valida el driving + persistencia del mapa.
- **F1 — Agente:** el LLM decide la acción (§6) con esquema forzado; dedup de pantallas; presupuesto.
- **F2 — Auth + profundidad:** login vía `auth`, exploración post-login de módulos; heurística
  anti-destructivo.
- **F3 — Integración (si la POC convence):** adaptador `product_map → dom_context` y consumo en
  `prepareMarkdownRun`/codegen, detrás de un flag (`exploration: "map" | "walk"`).

---

## 10. Riesgos y preguntas abiertas

- **Costo/latencia:** cada decisión es una llamada LLM; 25 pasos ≈ 25 llamadas. ¿Presupuesto
  aceptable vs. el valor? (TestSprite lo cobra por créditos por algo).
- **No-determinismo:** el mapa puede variar entre corridas. ¿Se cachea y se versiona? ¿Cómo se
  invalida ante cambios de UI?
- **Loops / trampas:** menús infinitos, paginación, modales. El dedup por `screenKey` mitiga pero
  hay que afinarlo.
- **Acciones destructivas:** la heurística de texto no es infalible. ¿Requerimos allowlist explícita
  para cualquier submit fuera de login?
- **Estado compartido:** exploración con datos reales puede crear/mutar registros. ¿Entorno de test
  dedicado obligatorio?
- **Filosofía:** el agente explorador usa juicio para *navegar*, pero el principio de "no fabricar
  contenido del test" se mantiene: el mapa solo aporta **DOM real**; el codegen sigue aterrizando
  contra él, no inventando.

---

## 11. Criterios de aceptación de la POC

1. `proguide explore --base-url <fixture>` produce un `product_map.json` con login + dashboard y el
   control de logout detectado (paridad con el e2e del walk).
2. Contra una app real autenticada, el mapa lista ≥3 módulos del dashboard con su DOM.
3. Respeta el presupuesto (corta por pasos/tiempo/tokens sin colgarse) y **nunca** dispara una
   acción de la denylist ni un submit destructivo.
4. Reporte de costo (tokens/USD) y tiempo por exploración documentado, para decidir F3.

> Si F1–F2 convencen (calidad del mapa + costo razonable), se promueve a diseño de integración (F3)
> y recién ahí entra a `main` con su versión. Mientras tanto, vive en `mapping-poc`.
