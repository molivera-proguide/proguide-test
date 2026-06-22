# Refactor de ProGuide Test — Plan y Progreso

> Documento vivo. Rama de trabajo: **`code-refactor`**. Se actualiza al cerrar cada módulo.
> Última actualización: 2026-06-22 (FASES 2-4 COMPLETAS: service → 21, server.js → 270, runs.js → 544).

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
| 2 | Partir `proguide-service.js` en módulos de dominio | ✅ Hecha (4333 → 21 líneas, fachada) |
| 3 | Partir `server.js` (assets CSS/JS + vistas) | ✅ Hecha (2468 → 270 líneas, solo rutas) |
| 4 | Funciones gigantes / sub-split de `runs.js` | ✅ Hecha (runs.js 1099 → 544; ver nota generateApiTestSpec) |
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
cd99ad2  Phase 2: extract low-level run-store I/O into lib/run-store/io.js
23ead9a  Phase 2: extract Playwright runner shells into lib/runner/{playwright,evidence}.js
ed1efb4  Phase 2: extract LLM usage accounting + Anthropic call into lib/usage/record.js + lib/llm/anthropic.js
db3dce2  Phase 2: extract agent codegen + DOM-context probe into lib/codegen/{agent,dom-context}.js
42130e3  Phase 2: move run orchestration to lib/run-store/runs.js; proguide-service is now a facade
9bf4ae8  Phase 3: extract viewer assets (CSS + client scripts) into ui/assets/
0b346c7  Phase 3: extract code views (highlight + TS snippet) into ui/views/code.js
c00c89e  Phase 3: extract shared view primitives into ui/views/format.js
c945520  Phase 3: extract server-rendered pages into ui/views/pages.js (server.js routes-only)
c891fae  Phase 4: split runs.js leaves into run-store/{identity,config} + markdown/sources
37cf0cb  Phase 4: extract case storage normalization into lib/cases/storage.js
```

`proguide-service.js`: 4333 → **21 líneas (fachada)**. `server.js`: 2468 → **270 líneas (solo rutas)**.
La lógica vive en `lib/`, `assets/` y `views/` por dominio.

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
ui/lib/run-store/io.js        Cimiento I/O (28 exports): constantes de paths (PROGUIDE_DIR..LLM_USAGE_JSONL),
                              usageRoot/runsRoot/runPath/globalUsageLogPath, newRunDir/makeRunId, readJson/
                              writeJson/exists, loadRunRecord/legacyRunRecord/saveRun/saveCasesFile/loadSummary/
                              loadEvents/appendEvent, walk/collectArtifacts/collectApiEvidence/loadLoggedSteps,
                              countSummary/statusFromSummary/setupFailureMessage/firstUsefulLogLine/chunkArray/
                              positiveInteger/relativePath. Solo depende de fs/path + shared time/id.
ui/lib/runner/playwright.js   runPlaywrightTests, parsePlaywrightResults (re-exportado por el servicio, API
                              pública), runProcess (lo usa collectDomContext) + writePlaywrightConfig/artifactPaths
                              internos. Importa de run-store/io + runner/{results,config} + playwright-runtime.
ui/lib/runner/evidence.js     writeEvidenceReport (HTML; escapeHtml + fs)
ui/lib/usage/record.js        recordLlmUsage, loadUsageSummary (re-exportados, API pública) + cluster de lectura
                              (loadGlobal/RunUsageEntries, normalizeStoredUsageEntry, summarizeUsageEntries,
                              usageTotals, groupUsage, formatUsageTokensForEvent, finiteOrNull) internos.
ui/lib/llm/anthropic.js       callJsonModel (+ anthropicApiKey/anthropicErrorDetails/extractJson internos).
                              Importa recordLlmUsage de usage/record (one-way). El SDK Anthropic vive solo aquí.
ui/lib/codegen/agent.js       generateTestsWithAgent, loadExistingTestPlan, extractCaseCode (+ helpers y
                              PLAYWRIGHT_CODE_AGENT_PROMPT internos). Importa callJsonModel/api-spec/test-plan/io.
ui/lib/codegen/dom-context.js collectDomContext (+ DOM_CONTEXT_PROBE_SCRIPT interno). Importa runProcess/io/api-spec.
ui/lib/run-store/runs.js      Orquestación de runs (~544 líneas): SOLO las 9 públicas (listRunRecords/
                              loadRunBundle/loadGeneratedCaseCode/prepareMarkdownRun/prepareCasesRun/
                              previewMarkdownRun/saveCasesForRun/appendCasesToRun/executePreparedRun).
ui/lib/run-store/identity.js  resolveRunIdentity (+ git/project/email helpers internos).
ui/lib/run-store/config.js    loadUiConfig (+ parseYamlScalar) — defaults + config.yaml.
ui/lib/markdown/sources.js    readMarkdownSources/markdownSourceFilename/combineMarkdownSources (decode BOM-aware).
ui/lib/cases/storage.js       normalizeCaseForStorage, interpretMarkdownWithAgent, normalizationWarnings
                              (+ markdownAgentSchema/coerceCasesPayload/MARKDOWN_AGENT_PROMPT internos).
ui/proguide-service.js        FACHADA (barrel, 21 líneas): re-exporta las 13 públicas desde lib/.
ui/assets/styles.js           styles() — CSS de la app (~705 líneas), inline en layout().
ui/assets/scripts.js          codeTabsScript, clientRunScript — JS de navegador, inline en <script>.
ui/views/format.js            primitivas de vista: renderBadge/statusClass/isActiveStatus, renderPriorityBadge/
                              priorityMeta, renderList, formatSeconds/formatTokens/formatUsd/shortDate.
ui/views/code.js              highlightCode, buildTypeScriptCode (+ helpers TS/highlight internos).
ui/views/pages.js             páginas SSR (5 entradas: layout, renderRunsIndex, renderUsageDashboard,
                              renderRunDetail, renderCaseDetail) + render* internos + attr/safeName.
ui/server.js                  ~270 líneas: Fastify + rutas + idle-shutdown + readStepLog + utils de request.
```

## Fase 3 COMPLETA ✅

server.js (2468 líneas) → 270 (solo rutas + orquestación). Assets CSS/JS a `ui/assets/`, vistas SSR a
`ui/views/`. `cleanCaseTitle` reubicado a lib/shared/text.js. Eliminado código muerto (scriptJson,
renderPriorityBadge en server). Smoke test de render OK + suite 36/36 + lint 0 errores.

## Fase 2 COMPLETA ✅

proguide-service.js (4333 líneas) descompuesto en 19 módulos `lib/` por dominio; el archivo quedó
como fachada de 21 líneas que re-exporta las 13 funciones públicas. Suite 36/36, lint 0 errores en
cada commit. API pública intacta (cli/mcp/server/viewer/tests no cambian sus imports).

> Nota de cierre Fase 2: `lib/run-store/runs.js` (~1099 líneas) sigue siendo grande. Sub-dividirlo
> (identity.js, config.js, markdown/sources.js, normalize-storage) queda para Fase 4 ("funciones
> gigantes"), junto con `generateApiTestSpec`. No bloquea Fase 3.

(referencia histórica del orden seguido)
> ✅ leaves puros → codegen (api-spec, test-plan, agent, dom-context) → runner (results, config,
> playwright shells, evidence) → cimiento I/O (run-store/io) → usage/record + llm/anthropic →
> store alto nivel + fachada. Helpers que vivían en el servicio y se movieron a runs.js:
   (interpretMarkdownWithAgent, normalizeCaseForStorage, markdownAgentSchema, coerceCasesPayload,
   normalizationWarnings, resolveRunIdentity + identity helpers, loadUiConfig/parseYamlScalar,
   readMarkdownSources/combineMarkdownSources, MARKDOWN_AGENT_PROMPT). Se movieron JUNTAS a runs.js
   para evitar ciclos (se llaman entre sí).

## Fase 4 COMPLETA ✅

`lib/run-store/runs.js` 1099 → 544 líneas (solo las 9 funciones públicas de orquestación). Extraídos:
`run-store/identity.js`, `run-store/config.js`, `markdown/sources.js`, `cases/storage.js`. Suite 36/36,
lint 0 errores.

> **Nota generateApiTestSpec:** revisado y **conservado intacto**. No es un monolito de
> responsabilidades mezcladas: es un único *template builder* (ya aislado en `lib/codegen/api-spec.js`)
> cuyo grueso es el runtime de tests API embebido como strings literales. Partirlo añadiría riesgo
> (solo se valida por e2e) sin reducir acoplamiento. Mejora futura opcional: mover el runtime embebido
> a un `.mjs` asset.

## Próxima fase

**Fase 5** — endurecer: config central, tests unitarios por módulo, subir reglas de lint. Limpieza
menor pendiente: warning `language` sin usar en `views/code.js` (param muerto en renderTypeScript*).

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

Fases 2, 3 y 4 ✅ COMPLETAS. proguide-service.js = fachada 21 líneas; server.js = 270 (solo rutas);
runs.js = 544 (solo orquestación). Siguiente: **Fase 5** (endurecer). `cd ui && npm run check` verde
(lint 0 errores, 7 warnings, 36 tests).

## Comandos de verificación

```bash
cd ui
npm run lint     # debe terminar en "0 errors" (warnings ok)
npm test         # 35 tests, 0 fail
npm run check    # ambos
```
