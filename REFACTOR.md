# Refactor de ProGuide Test — Plan y Progreso

> Documento vivo. Rama de trabajo: **`code-refactor`**. Se actualiza al cerrar cada módulo.
> Última actualización: 2026-06-22 (codegen puro + runner puro extraídos).

## Objetivo

Descomponer dos monolitos — `ui/proguide-service.js` (~4333 líneas) y `ui/server.js`
(~2476) — en módulos por dominio, eliminar duplicación y añadir red de seguridad,
**sin cambiar comportamiento ni la API pública**.

### Restricción dura (no romper)

`ui/proguide-service.js` exporta **13 funciones públicas** consumidas por `cli.js` (7),
`mcp-server.js` (8) y `server.js` (4). El refactor las preserva: el archivo se
convierte en **fachada (barrel)** que re-exporta desde los módulos nuevos. Así
`cli.js`, `mcp-server.js`, `viewer.js` no cambian sus imports.

### Decisiones

- Se mantiene **JS + `// @ts-check` opt-in** por módulo nuevo (jsconfig `checkJs:false`). NO migración a TS.
- Lint: **errores bloquean, warnings informan**. `no-useless-assignment` y `preserve-caught-error` → warning.
- Prettier configurado pero **NO aplicado en masa** (evitar churn); usar `npm run format` por archivo.
- Un módulo por commit, `npm run check` (lint + 35 tests) verde en cada paso.

## Estado por fase

| Fase | Descripción | Estado |
|---|---|---|
| 0 | Red de seguridad (ESLint/Prettier/jsconfig, lint en CI, e2e flaky estabilizado, golden test) | ✅ Hecha |
| 1 | Utilidades duplicadas → `lib/shared/{env,paths,html,cases}.js` | ✅ Hecha |
| 2 | Partir `proguide-service.js` en módulos de dominio | 🚧 En curso |
| 3 | Partir `server.js` (assets CSS/JS + vistas) | ⬜ Pendiente |
| 4 | Funciones gigantes (`generateApiTestSpec`, etc.) | ⬜ Pendiente |
| 5 | Endurecer (config central, tests unitarios, reglas lint) | ⬜ Pendiente |

## Commits del refactor (orden cronológico)

```
c43c150  Phase 0: safety net (lint, formatter, golden test, flake fix)
01b4a9f  Phase 1: consolidate duplicated utilities into lib/shared
12880b4  Phase 2.1: extract LLM pricing/cost into lib/usage/pricing.js (+lib/shared/num.js)
4d71141  Phase 2: extract pure text/normalization helpers into lib/shared/text.js
22851be  Phase 2: foundational leaf helpers (object,id,secrets,value-parse, markdown/text)
665fd2e  Phase 2: extract API/REST normalization into lib/cases/api-normalize.js
32c7e6f  Phase 2: extract step/automation normalization into lib/cases/normalize.js
d8e24a8  Phase 2: extract Markdown case parser into lib/markdown/parse-cases.js
dfda471  Phase 2: extract REST API spec generation into lib/codegen/api-spec.js
7a6acf4  Phase 2: extract test-plan builder into lib/codegen/test-plan.js (+lib/shared/time.js)
98a24ce  Phase 2: extract pure Playwright runner helpers into lib/runner/ (results.js, config.js)
```

`proguide-service.js`: 4333 → **2280 líneas**.

## Hallazgo clave (orden corregido)

El orden original del plan (usage/llm primero) **no era viable**: `recordLlmUsage`/
`loadUsageSummary` se apoyan en la capa de I/O del store, y `api-normalize`/`parse-cases`
se apoyan en helpers-hoja puros. El orden correcto es **bottom-up**: leaves puros →
dominio → store/usage → fachada.

## Módulos ya creados

```
ui/lib/shared/env.js          loadDotEnv, envFileCandidates
ui/lib/shared/paths.js        isPathInside
ui/lib/shared/html.js         escapeHtml
ui/lib/shared/cases.js        casesRequireBrowser
ui/lib/shared/num.js          safeNumber, roundMoney
ui/lib/shared/text.js         norm, stripAccents, slug, normalizePriority, priorityForPlan,
                              normalizeAutomationState, splitTags, firstArrayValue, joinText
ui/lib/shared/object.js       isPlainObject
ui/lib/shared/id.js           safeId
ui/lib/shared/secrets.js      isSecretKey, allowsTestPasswordKey, maskSecret*, maskSecretsDeep, sanitizeCaseData
ui/lib/shared/value-parse.js  normalizeKeyValueObject, normalizeRequestBody, parseJsonObject, parseLooseValue, stringifyInlineValue
ui/lib/markdown/text.js       stripListMarker, stripMarkdownEmphasis, cleanList
ui/lib/usage/pricing.js       ANTHROPIC_PRICING_*, anthropicModelFamily, normalizeLlmUsage, estimateLlmCost
ui/lib/cases/api-normalize.js inferCaseType, normalizeApi* (request/assertions/captures), parseExpectedApiAssertion (10 exports)
ui/lib/cases/normalize.js     buildSteps, normalizeStep, assessAutomation, explicitStep, mergeCaseData, dataFromLines,
                              inferCaseRoute (7 exports; selector/route/regex helpers internos)
ui/lib/markdown/parse-cases.js parseMarkdownCases (único export) + FIELD_ALIASES y helpers de bloque/campo
                              (splitCaseBlocks, parseBlock, extractLabel, fieldFromHeading, ...) internos.
ui/lib/shared/text.js         (+ noneIfEmpty, reubicado aquí para evitar import circular parser↔servicio)
ui/lib/shared/time.js         nowIso (reubicado; lo usan store/usage/codegen)
ui/lib/codegen/api-spec.js    isApiPlanCase, generateApiTestSpec (+ normalizeApiPlanRequests interno) — 2 exports
ui/lib/codegen/test-plan.js   casesToTestPlan (único export)
ui/lib/runner/results.js      collectPlaywrightSpecs, caseFromPlaywrightSpec, normalizePlaywrightSpecResult
                              (+ status/message/error/steps helpers internos). Parsing puro del reporte.
ui/lib/runner/config.js       playwrightWorkerArgs (re-exportado por el servicio, API pública usada por tests),
                              normalizePlaywright{Screenshot,Trace,Video}
```

## Pendiente de Fase 2 (orden sugerido)

> **Ya extraído:** codegen PURO (api-spec, test-plan) y runner PURO (results, config).
> Lo que queda está acoplado a la capa I/O del store + LLM, así que el siguiente
> cimiento es esa capa. Acoplados a I/O/LLM (van DESPUÉS):
> - **runner shells:** runPlaywrightTests, writePlaywrightConfig, runProcess,
>   parsePlaywrightResults (usa exists/readJson/collectApiEvidence/collectArtifacts),
>   artifactPaths, writeEvidenceReport.
> - **agent-codegen:** generateTestsWithAgent, buildCodeGenerationPayload, extractCaseCode,
>   normalizeGeneratedFiles, safeGeneratedPath, targetGeneratedPath, validateGeneratedCode,
>   loadExistingTestPlan, writePlaywrightRuntimeShim (usan callJsonModel + fs).
> - **dom-context:** collectDomContext + DOM_CONTEXT_PROBE_SCRIPT/DOM_SNAPSHOT_JS (spawn + fs).

1. **Cimiento I/O (low-level primero):** `lib/run-store/io.js` — readJson, writeJson, exists,
   appendEvent, loadEvents, ensureLayout, newRunDir, makeRunId, walk, collectArtifacts,
   collectApiEvidence, relativePath, saveRun/saveCasesFile/loadSummary + constantes de paths
   (runPath/usageRoot/runsRoot/globalUsageLogPath) y utils (countSummary, statusFromSummary,
   setupFailureMessage, firstUsefulLogLine, chunkArray, positiveInteger). Hojas de I/O, sin
   dependencias del servicio → desbloquea runner shells y la capa alta del store.
2. **runner shells + evidence** (ya pueden importar de run-store/io).
3. **usage/record** (recordLlmUsage, loadUsageSummary, summarize/group) + **llm/anthropic**
   (callJsonModel, anthropicApiKey, extractJson, anthropicErrorDetails).
4. **agent-codegen + dom-context** (dependen de 1-3).
5. **store alto nivel** (prepare*/append*/save*/executePreparedRun/loadRunBundle/listRunRecords/
   resolveRunIdentity) y dejar `proguide-service.js` como **fachada** que re-exporta las 13 públicas.

## Técnica para mover un bloque grande

```bash
cd ui
# 1. extraer bloque a un módulo nuevo, marcando export en las funciones públicas
sed -n 'A,Bp' proguide-service.js \
  | sed -E 's/^function (PUB1|PUB2|...)\(/export function \1(/' >> lib/<dest>.js   # con header de imports ya escrito
node --check lib/<dest>.js
# 2. borrar el bloque del servicio y añadir el import
sed -i 'A,Bd' proguide-service.js
#    (luego Edit/insertar la línea `import { ... } from './lib/<dest>.js';`)
```

**Cuidados:**
- El análisis por llamadas NO detecta **constantes** usadas por el bloque (p.ej. `HTTP_METHODS`). Buscarlas aparte (`grep -nE "^const NOMBRE"`).
- Verificar que el bloque **no llama** a funciones que se quedan en el servicio (evitar import circular).
- Tras mover un bloque, el servicio puede dejar imports **huérfanos** → quitarlos (lint los marca).
- Tras `sed -i`, **releer** el archivo antes de usar la herramienta Edit.

## Cómo retomar (resume)

```bash
cd <repo> && git checkout code-refactor
git log --oneline main..HEAD        # ver commits del refactor
cat REFACTOR.md                     # este archivo: estado y siguiente módulo
cd ui && npm run check              # confirmar verde (lint + 35 tests) antes de seguir
```

Siguiente módulo a extraer: **`lib/run-store/io.js`** (punto 1) — los primitivos de I/O de bajo
nivel (readJson/writeJson/exists/appendEvent/collectArtifacts/collectApiEvidence/etc.). Son el
cimiento que desbloquea los runner shells, agent-codegen, dom-context y la capa alta del store.

## Comandos de verificación

```bash
cd ui
npm run lint     # debe terminar en "0 errors" (warnings ok)
npm test         # 35 tests, 0 fail
npm run check    # ambos
```
