# Plan de implementación — Regresión autosuficiente en ProGuide

> Branch: `regresion-imple`
> Estado: propuesta para implementar
> Fuera de alcance (por ahora): **spec-driven** (ingerir PRD/specs y derivar casos). No se implementa en esta iteración.

## 1. Objetivo

Que un QA pueda correr **regresión real** con ProGuide sin depender del entorno del usuario
(Claude in Chrome / Chrome DevTools MCP) y sin pagar LLM + browser en cada corrida.

Dos problemas a resolver:

1. **Autosuficiencia de exploración del DOM ("lo hacemos nosotros").** Hoy la skill empuja la
   lectura del DOM al navegador del usuario porque ProGuide explora *ciego de sesión*. ProGuide
   ya trae Chromium y ya snapshotea DOM; le falta sesión autenticada y una superficie de
   inspección en tiempo de autoría.
2. **Determinismo de la regresión UI.** Hoy cada `execute` regenera el `.spec.ts` con el LLM y
   reabre browser para contexto DOM → no determinista, lento y con costo por corrida. Para
   regresión hay que poder **ejecutar código congelado** (generate-once, run-many).

Los casos **API** (`type: api`) ya son deterministas (codegen sin LLM); no se tocan salvo para
reutilizar sesión.

## 2. Estado actual (gaps confirmados en código)

| Pieza | Archivo | Situación hoy | Gap |
|---|---|---|---|
| Pre-pass DOM | `ui/lib/codegen/dom-context.ts` | `page.goto(base_url + route)` en frío y snapshot | **Sin `storageState`/login** → en rutas protegidas snapshotea el login |
| Codegen UI | `ui/lib/codegen/agent.ts` | `generateTestsWithAgent` llama al LLM en **cada** execute | No reutiliza el `.spec.ts` ya generado |
| Ejecución | `ui/lib/run-store/runs.ts` → `executePreparedRun` | `from_plan` reutiliza el *plan*, no el código | No hay "ejecutar sin regenerar" |
| Credenciales | `ui/lib/runner/playwright.ts` | `PROGUIDE_USER_EMAIL/USERNAME/PASSWORD` como env vars al test | El login ocurre *dentro de cada caso*, no a nivel sesión |
| Config | `.proguide/config.yaml` vía `ui/lib/run-store/config.ts` | Solo sección `llm` | No hay sección `auth` ni ruta de `storageState` |
| Superficie | `ui/cli.ts`, `ui/mcp-server.ts` | create/run/execute/get-run/get-code/list-runs/viewer | No hay `inspect` |

Principio de diseño transversal: **ProGuide entrega DOM determinista; el agente/LLM aporta el
juicio** (qué selector es estable, qué texto verificar). No mover ese juicio al binario.

## 3. Alcance

**Incluido**
- Bootstrap de sesión user/pass + `storageState` persistido y reusable.
- Superficie `inspect` (CLI + MCP) para autoría.
- Reuso de `storageState` en el pre-pass de codegen.
- Regresión determinista: congelar `.spec.ts` y ejecutar sin regenerar + modo recalibración.
- Reuso de sesión en ejecución de regresión.
- Actualización de la skill (`skills/SKILL.md`) para invertir la dependencia del Paso 0.

**Excluido**
- Spec-driven (ingestión de PRD/specs).
- MFA / SSO interactivo (sigue siendo fallback al navegador del usuario).
- Cualquier almacenamiento de credenciales en repo (siguen por env/CLI).

## 4. Fases

### Fase 0 — Cimientos: auth block + sesión (MVP base)

Desbloquea todo lo demás. Sin sesión autenticada, ni `inspect` ni el pre-pass ven pantallas reales.

- [ ] Definir sección `auth` en `.proguide/config.yaml` y parsearla en `ui/lib/run-store/config.ts`:
  ```yaml
  auth:
    login_route: /login
    user_selector: '[name="email"]'
    pass_selector: '[name="password"]'
    submit_selector: 'button[type="submit"]'
    success_check: '[data-testid="dashboard"]'   # señal de login OK
  ```
- [ ] Nuevo módulo `ui/lib/auth/session.ts`:
  - `bootstrapSession({ root, baseUrl, config, credentials })`: abre Chromium, navega `login_route`,
    rellena user/pass (credenciales desde env/CLI, **nunca** del yaml), submit, valida `success_check`,
    guarda `storageState` en `.proguide/storage-state.json`.
  - `ensureSession(...)`: devuelve `storageState` válido; si falta o está vencido, re-bootstrapea.
- [ ] Añadir `.proguide/storage-state.json` al `.gitignore`.
- [ ] Manejo de expiración: si `success_check` falla al usar la sesión → re-login transparente.

**Criterio de aceptación:** con `auth` configurado y credenciales por env, ProGuide obtiene un
`storage-state.json` válido contra una app user/pass.

### Fase 1 — Superficie `inspect` (autoría autosuficiente)

- [ ] `inspectRoute({ root, baseUrl, route, config })` en `ui/lib/codegen/dom-context.ts`
      (o módulo nuevo que lo reuse): usa `ensureSession`, navega la ruta **ya logueado**, devuelve
      árbol de accesibilidad + candidatos de selector estable (`data-testid`, `id`, `name`, texto único).
- [ ] CLI: comando `proguide inspect <route> [--base-url] [--json]` en `ui/cli.ts`.
- [ ] MCP: tool `inspect_route` en `ui/mcp-server.ts` (params: `route`, `base_url`).
- [ ] Bootstrap de la receta de login: como `login_route` es **pública**, el agente puede
      autogenerar la receta `auth` inspeccionándola (resuelve el huevo-y-gallina).

**Criterio de aceptación:** `proguide inspect /ruta-protegida` devuelve el DOM real autenticado,
sin que el usuario tenga ningún MCP de browser instalado.

### Fase 2 — Pre-pass de codegen autenticado

- [ ] Inyectar `storageState` (de `ensureSession`) en el `page` que arma `collectDomContext`
      en `ui/lib/codegen/dom-context.ts`.

**Criterio de aceptación:** generar código para una ruta protegida usa el DOM real, no el del login.

### Fase 3 — Regresión determinista (congelar specs)

- [ ] Separar los dos verbos hoy fusionados en `executePreparedRun`:
  - **Generar** (LLM, calibración) — comportamiento actual.
  - **Ejecutar regresión** — correr el `.spec.ts` ya presente en `generated/` **sin** llamar al LLM
    ni al pre-pass DOM.
- [ ] Flag/param: `--frozen` (CLI) / `frozen: true` (MCP `execute_run`/`run_cases`) → si hay código
      generado, ejecutarlo tal cual; si no, error claro ("no hay spec congelado; generá primero").
- [ ] Persistencia de la suite congelada: definir dónde vive el `.spec.ts` de regresión de forma
      **versionable** (hoy `proguide_tests/runs/` está en `.gitignore`). Opción recomendada: comando
      para "promover" un run calibrado a una carpeta de suite versionada (p. ej. `proguide_tests/suite/`).
- [ ] Modo recalibración: si N casos congelados fallan, regenerar **solo** esos, mostrar diff del
      spec y permitir re-congelar.

**Criterio de aceptación:** una suite UI calibrada corre dos veces dando el mismo resultado, sin
LLM y sin reabrir browser para contexto, en tiempo de `playwright test`.

### Fase 4 — Reuso de sesión en regresión

- [ ] Que el runner (`ui/lib/runner/playwright.ts` / `playwright.config.cjs`) use el `storageState`
      de la sesión en lugar de loguear dentro de cada caso, cuando `auth` esté configurado.
- [ ] Mitiga la contención `fullyParallel: true` + mismo usuario que documenta la skill.

**Criterio de aceptación:** regresión paralela sin fallos por contención de login SSO/sesión.

### Fase 5 — Skill y docs

- [ ] `skills/SKILL.md` Paso 0: `proguide inspect` pasa a ser **camino primario**; browser MCP del
      usuario queda como **fallback** para MFA/SSO interactivo y exploración libre.
- [ ] Documentar `auth` block, `inspect`, `--frozen` y el flujo calibración→congelar→regresión en `README.md`.

## 5. Corte MVP

Mínimo para que un QA haga regresión autosuficiente de punta a punta:

- **Fase 0** (sesión + auth) — imprescindible.
- **Fase 1** (`inspect`) — quita la dependencia del entorno del usuario.
- **Fase 3** (congelar specs) — convierte ejecución en regresión real.

Fases 2 y 4 son optimizaciones de calidad/velocidad; Fase 5 es adopción. Hacerlas después.

## 6. Riesgos y cuidados

- **Expiración de sesión:** sin re-login transparente, la regresión nocturna falla por sesión
  muerta (falso rojo). Cubrir en Fase 0.
- **No determinismo residual:** si el congelado sigue invocando el pre-pass DOM, no es determinista.
  El modo `--frozen` debe saltarse codegen *y* pre-pass.
- **Dónde vive la suite:** los runs son efímeros (`.gitignore`). Sin promover a carpeta versionada,
  no hay artefacto de regresión persistente. Decidir en Fase 3.
- **Drift de UI:** el congelado se vuelve obsoleto si cambia la UI; el modo recalibración es la
  válvula de escape (igual que cualquier suite Playwright tradicional).
- **Secretos:** credenciales solo por env/CLI; `auth` block del yaml lleva selectores, nunca claves.

## 7. Criterio de aceptación global

Un QA, en una app user/pass, sin ningún MCP de browser instalado, puede:
1. Configurar `auth` (o dejar que el agente la derive del login público).
2. Autorear casos UI estables usando `proguide inspect`.
3. Calibrar una vez y **congelar** la suite.
4. Correr esa suite en regresión de forma **determinista, repetible y barata** (sin LLM por corrida).
