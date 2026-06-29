# Mini-diseño — Fase 3: Regresión determinista (congelar specs)

> Branch: `regresion-imple` · Depende de Fases 0–2 (ya en el branch).
> Objetivo: separar **generar** (LLM, calibración) de **ejecutar regresión** (specs
> congelados, sin LLM ni pre-pass), y darle a la suite un hogar versionable.

## 1. Idea central

Hoy `executePreparedRun` hace siempre: `collectDomContext` (browser) → `generateTestsWithAgent`
(LLM) → `runPlaywrightTests`. Eso es correcto para **calibrar** un caso nuevo, pero es justo lo
que NO se quiere en regresión: no determinista, lento y con costo por corrida.

La Fase 3 introduce un **modo frozen**: cuando ya existe el `.spec.ts` calibrado, ejecutar ese
código tal cual, **saltando pre-pass y codegen**. Regresión = `playwright test` sobre specs
congelados → determinista, rápido, gratis.

```
Calibración (hoy):   cases → pre-pass DOM → LLM codegen → playwright test
Regresión (Fase 3):  spec congelado ───────────────────→ playwright test
```

## 2. Dónde vive la suite (decisión)

Hoy `proguide_tests/runs/<id>/` es **efímero** (gitignored). No sirve como artefacto de regresión.

**Decisión: comando `promote` que copia un run calibrado a una carpeta versionable.**

```
proguide_tests/suite/<module>/
  cases.json          # normalized_cases.json del run (fuente de verdad de la suite)
  plan.json           # test_plan.json
  generated/          # los .spec.ts congelados + runtime shim
  suite.json          # metadata: módulo, base_url de calibración, run origen, fecha, hash
```

- `proguide_tests/suite/` **NO** va en `.gitignore` → el equipo lo commitea junto a la app.
- `cases.json`/`plan.json` se versionan para trazabilidad y para poder recalibrar.
- Alternativa descartada: des-ignorar runs puntuales (frágil, mezcla efímero con permanente).

## 3. Camino de ejecución frozen

Nuevo parámetro `frozen` en `executePreparedRun` (o función hermana `executeFrozenSuite`).
Cuando `frozen === true`:

1. **No** llamar a `collectDomContext`.
2. **No** llamar a `generateTestsWithAgent`.
3. Verificar que exista `generated/` con al menos un `.spec.ts`; si no → error claro
   (`no hay spec congelado para <module/run>; corré una calibración o promove primero`).
4. Saltar directo a `runPlaywrightTests({ testsDir: generatedDir, ... })`.
5. Estados: omitir `generating`; pasar de `prepared` → `running` → estado final.

Guard de determinismo: el modo frozen debe saltar **ambos** pasos (pre-pass *y* codegen). Si solo
salta codegen pero corre el pre-pass, sigue abriendo browser y no es del todo determinista.

## 4. Superficie (CLI + MCP)

**CLI**
- `proguide promote <run_id> --module <name>` → congela el run a `suite/<module>/`.
- `proguide regress <module> --base-url <url> [--json]` → ejecuta la suite congelada (frozen).
  - O bien `proguide execute <run_id> --frozen` para re-ejecutar un run sin regenerar.
- `proguide list-suites` (opcional) → lista suites versionadas.

**MCP**
- `execute_run` / `run_cases`: nuevo arg `frozen: true` → ejecuta sin regenerar.
- `regress_suite` (opcional, fase 3.2): ejecuta una suite por `module`.

Mantener `frozen` como flag aditivo, sin romper el comportamiento actual (default `false`).

## 5. Modo recalibración

Cuando la regresión frozen falla en N casos (drift de UI o bug real):

1. El resultado marca qué casos fallaron (ya tenemos `summary`/`results.json`).
2. `proguide recalibrate <module> --cases TC-003,TC-007` → regenera **solo** esos casos
   (pre-pass + LLM acotado a ese subconjunto), deja los demás congelados intactos.
3. Mostrar diff del `.spec.ts` viejo vs nuevo (para que el QA confirme que el cambio es por UI,
   no por relajar la verificación).
4. Re-congelar (re-promote) los casos corregidos a `suite/<module>/`.

Distinción clave a preservar: un fallo por **selector viejo** se recalibra; un fallo por **bug de
la app** se reporta como hallazgo, no se "arregla" tocando el assert (regla ya vigente en la skill).

## 6. Cambios a nivel archivo (orden sugerido)

1. `ui/lib/run-store/runs.ts`
   - `executePreparedRun`: añadir `frozen?: boolean`; si `frozen`, saltar `collectDomContext` y
     `generateTestsWithAgent`, validar `generated/` y ir directo a `runPlaywrightTests`.
   - Nuevas funciones: `promoteRunToSuite({ root, runId, module })`,
     `loadSuite({ root, module })`, `executeFrozenSuite({ root, module, baseUrl, credentials })`.
2. `ui/proguide-service.ts` — re-exportar las nuevas funciones.
3. `ui/cli.ts` — comandos `promote`, `regress`, flag `--frozen` en `execute`; help entries.
4. `ui/mcp-server.ts` — arg `frozen` en `execute_run`/`run_cases`; tool `regress_suite` (opcional).
5. `.gitignore` — **no** tocar `proguide_tests/suite/` (debe quedar versionado); confirmar que
   las reglas existentes (`runs/`, `generated/`) no lo capturen por error.

## 7. Edge cases / guards

- **Sin `generated/`**: frozen falla con mensaje accionable, nunca regenera en silencio.
- **base_url distinta** en regresión vs calibración: permitido (es el punto), pero registrar en
  `suite.json` la base_url de origen para debugging.
- **API cases**: ya son deterministas (codegen sin LLM). En frozen igual se ejecuta su `.spec.ts`
  ya generado; no requieren tratamiento especial.
- **Sesión** (Fase 4): en frozen, reusar `storageState` en vez de login por caso; se integra en
  la Fase 4, no bloquea Fase 3.
- **Regla `.gitignore`**: `proguide_tests/generated/` ya está ignorado a nivel raíz — verificar
  que `suite/<module>/generated/` NO caiga bajo esa regla (es una ruta distinta; ok, pero testear).

## 8. Criterio de aceptación (Fase 3)

1. `promote` deja una suite versionable en `proguide_tests/suite/<module>/` con specs + cases + plan.
2. `regress <module>` (o `execute <run_id> --frozen`) ejecuta **sin** llamar al LLM ni abrir browser
   para contexto, y produce el mismo resultado en dos corridas seguidas.
3. Si no hay spec congelado, el comando falla con mensaje claro (no regenera).
4. `recalibrate` regenera solo el subconjunto indicado y permite re-congelar.

## 9. Corte MVP de la Fase 3

- **Imprescindible:** flag `frozen` en `executePreparedRun` + `promote` + `regress`/`--frozen`.
  Con eso el QA ya congela y corre regresión determinista.
- **Después (3.2):** `recalibrate` con diff, `list-suites`, tool MCP `regress_suite`.
