import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/shared/env.js';
import { nowIso } from './lib/shared/time.js';
import {
  slug,
  normalizePriority,
  normalizeAutomationState,
  splitTags,
  firstArrayValue,
  noneIfEmpty
} from './lib/shared/text.js';
import { safeId } from './lib/shared/id.js';
import {
  maskSecretText,
  maskSecretLines,
  maskSecretsDeep,
  sanitizeCaseData
} from './lib/shared/secrets.js';
import { cleanList } from './lib/markdown/text.js';
import {
  inferCaseType,
  normalizeApiCaseStep,
  normalizeApiRequest,
  normalizeApiRequests,
  buildApiExecutableSteps,
  normalizeApiCaptures,
  normalizeApiAssertions,
  rejectUnsupportedApiAssertions
} from './lib/cases/api-normalize.js';
import {
  buildSteps,
  normalizeStep,
  assessAutomation,
  explicitStep,
  mergeCaseData,
  inferCaseRoute
} from './lib/cases/normalize.js';
import { parseMarkdownCases } from './lib/markdown/parse-cases.js';
import { isApiPlanCase } from './lib/codegen/api-spec.js';
import { casesToTestPlan } from './lib/codegen/test-plan.js';
import { collectDomContext } from './lib/codegen/dom-context.js';
import {
  generateTestsWithAgent,
  loadExistingTestPlan,
  extractCaseCode
} from './lib/codegen/agent.js';
import { playwrightWorkerArgs } from './lib/runner/config.js';
import { runPlaywrightTests, parsePlaywrightResults } from './lib/runner/playwright.js';
import { writeEvidenceReport } from './lib/runner/evidence.js';
import { recordLlmUsage, loadUsageSummary } from './lib/usage/record.js';
import { callJsonModel } from './lib/llm/anthropic.js';

export { parsePlaywrightResults, recordLlmUsage, loadUsageSummary };
import {
  PROGUIDE_DIR,
  SOURCE_MD,
  SOURCE_CASES_JSON,
  NORMALIZED_CASES_JSON,
  TEST_PLAN_JSON,
  RESULTS_JSON,
  ensureLayout,
  runsRoot,
  runPath,
  newRunDir,
  loadRunRecord,
  legacyRunRecord,
  saveRun,
  saveCasesFile,
  loadSummary,
  loadEvents,
  appendEvent,
  writeJson,
  readJson,
  exists,
  walk,
  countSummary,
  statusFromSummary,
  relativePath
} from './lib/run-store/io.js';

export { playwrightWorkerArgs };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MARKDOWN_AGENT_PROMPT = `You are a senior QA analyst converting Markdown test cases into structured cases.
Return only valid JSON. No markdown.

Rules:
- Do not execute tests.
- Do not invent credentials, environment data, or business records.
- Preserve the original wording in original_markdown/original_steps.
- Use Spanish UI state values:
  - automation_state: listo, necesita_revision, no_automatizable_aun
- Mark ambiguous cases as necesita_revision with a concrete state_reason.
- Mark captcha, 2FA, manual-only, external calls, or missing data as no_automatizable_aun.
- Keep password/secret/token values masked as ******.
- Use priority values baja, media, alta, critica.`;

export async function listRunRecords(root) {
  const runsDir = runsRoot(root);
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = path.join(runsDir, entry.name);
      try {
        records.push(await loadRunRecord(entryDir));
      } catch (error) {
        records.push(await legacyRunRecord(entryDir, entry.name, error));
      }
    }
    return records.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    return [];
  }
}

export async function loadRunBundle(root, runId) {
  const runDir = runPath(root, runId);
  if (!(await exists(runDir))) {
    throw new Error(`Run no encontrado: ${runId}. Root efectivo: ${root}.`);
  }
  let run;
  try {
    run = await loadRunRecord(runDir);
  } catch (error) {
    run = await legacyRunRecord(runDir, runId, error);
  }
  const cases = await readJson(path.join(runDir, NORMALIZED_CASES_JSON), []);
  const summary = await loadSummary(runDir);
  const events = await loadEvents(runDir);
  return { run, cases, summary, events };
}

export async function loadGeneratedCaseCode(root, runId, caseId) {
  const runDir = runPath(root, runId);
  const generatedDir = path.join(runDir, 'generated');
  if (!(await exists(generatedDir))) return null;
  let found = null;
  await walk(generatedDir, async (filePath) => {
    if (found || !['.ts', '.js', '.cjs', '.mjs'].includes(path.extname(filePath).toLowerCase())) return;
    if (['proguide-test-runtime.cjs', 'proguide-test-runtime.mjs'].includes(path.basename(filePath))) return;
    const code = extractCaseCode(await fs.readFile(filePath, 'utf8'), caseId);
    if (code) {
      found = {
        code,
        path: relativePath(filePath, runDir)
      };
    }
  });
  return found;
}

export async function prepareMarkdownRun({ root, sourceMd, baseUrl, metadata = {}, useAgent = false }) {
  await ensureLayout(root);
  await loadDotEnv(root);
  const config = await loadUiConfig(root);
  const identity = await resolveRunIdentity(root, metadata, config);
  const sources = await readMarkdownSources(sourceMd);
  const sourceFilename = markdownSourceFilename(sources);
  const runDir = await newRunDir(root);
  const run = {
    id: path.basename(runDir),
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    status: 'interpreting',
    mode: 'url',
    base_url: String(baseUrl || '').replace(/\/+$/, ''),
    source_filename: sourceFilename,
    app_name: metadata.app_name || identity.project_name || metadata.title || null,
    project_name: identity.project_name || null,
    project_key: identity.project_key || null,
    run_user_email: identity.run_user_email || null,
    run_user_name: identity.run_user_name || null,
    company_domain: identity.company_domain || null,
    workspace_root: identity.workspace_root || null,
    run_source: identity.run_source || null,
    git_branch: identity.git_branch || null,
    git_commit: identity.git_commit || null,
    identity_source: identity.identity_source || {},
    ticket: metadata.ticket || null,
    module: metadata.module || null,
    title: metadata.title || null,
    qa_owner: metadata.qa_owner || null,
    dev_owner: metadata.dev_owner || null,
    total_cases: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    inconclusive: 0,
    setup_failed: 0,
    pdf_path: null,
    html_path: null,
    data_dir: runDir
  };

  await fs.mkdir(runDir, { recursive: true });
  await saveRun(runDir, run);
  await appendEvent(runDir, { run_id: run.id, type: 'run_created', status: run.status, message: 'Run creado.' });
  const markdown = combineMarkdownSources(sources);
  await fs.writeFile(path.join(runDir, SOURCE_MD), maskSecretText(markdown), 'utf8');
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'file_received',
    message: sources.length === 1
      ? `Archivo recibido: ${sources[0].name}`
      : `Archivos recibidos: ${sources.map((source) => source.name).join(', ')}`
  });

  let cases;
  try {
    cases = [];
    for (const source of sources) {
      const parsed = useAgent
        ? await interpretMarkdownWithAgent(source.markdown, {
          root,
          sourceName: source.name,
          usageContext: { runId: run.id, runDir }
        })
        : parseMarkdownCases(source.markdown, { sourceName: source.name });
      cases.push(...parsed);
    }
  } catch (error) {
    run.status = 'error';
    run.finished_at = nowIso();
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'error_global',
      status: run.status,
      message: error.message
    });
    throw error;
  }
  for (const testCase of cases) {
    if (run.qa_owner && !testCase.qa_owner) testCase.qa_owner = run.qa_owner;
    if (run.dev_owner && !testCase.dev_owner) testCase.dev_owner = run.dev_owner;
    if (run.ticket && !testCase.ticket) testCase.ticket = run.ticket;
  }

  await saveCasesFile(runDir, cases);
  await writeJson(path.join(runDir, TEST_PLAN_JSON), casesToTestPlan(cases, {
    sourceMd: SOURCE_MD,
    appName: run.app_name || 'ProGuide Markdown Cases'
  }));

  run.status = 'ready';
  run.total_cases = cases.length;
  await saveRun(runDir, run);
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'cases_interpreted',
    status: run.status,
    message: `${cases.length} caso(s) interpretado(s).`,
    payload: { ready: cases.filter((item) => item.automation_state === 'listo').length }
  });
  return { run, cases };
}

export async function prepareCasesRun({ root, cases, baseUrl, metadata = {} }) {
  await ensureLayout(root);
  await loadDotEnv(root);
  const config = await loadUiConfig(root);
  const identity = await resolveRunIdentity(root, metadata, config);
  if (!Array.isArray(cases) || !cases.length) {
    throw new Error('cases debe contener al menos un caso.');
  }
  const normalizedCases = cases.map((item, index) => normalizeCaseForStorage(item, index + 1));

  const runDir = await newRunDir(root);
  const run = {
    id: path.basename(runDir),
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    status: 'interpreting',
    mode: 'url',
    base_url: String(baseUrl || '').replace(/\/+$/, ''),
    source_filename: SOURCE_CASES_JSON,
    app_name: metadata.app_name || identity.project_name || metadata.title || null,
    project_name: identity.project_name || null,
    project_key: identity.project_key || null,
    run_user_email: identity.run_user_email || null,
    run_user_name: identity.run_user_name || null,
    company_domain: identity.company_domain || null,
    workspace_root: identity.workspace_root || null,
    run_source: identity.run_source || null,
    git_branch: identity.git_branch || null,
    git_commit: identity.git_commit || null,
    identity_source: identity.identity_source || {},
    ticket: metadata.ticket || null,
    module: metadata.module || null,
    title: metadata.title || null,
    qa_owner: metadata.qa_owner || null,
    dev_owner: metadata.dev_owner || null,
    total_cases: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    inconclusive: 0,
    setup_failed: 0,
    pdf_path: null,
    html_path: null,
    data_dir: runDir
  };

  await fs.mkdir(runDir, { recursive: true });
  await saveRun(runDir, run);
  await appendEvent(runDir, { run_id: run.id, type: 'run_created', status: run.status, message: 'Run creado.' });
  await writeJson(path.join(runDir, SOURCE_CASES_JSON), maskSecretsDeep(cases));
  await appendEvent(runDir, { run_id: run.id, type: 'file_received', message: 'Casos estructurados recibidos.' });

  for (const testCase of normalizedCases) {
    if (run.qa_owner && !testCase.qa_owner) testCase.qa_owner = run.qa_owner;
    if (run.dev_owner && !testCase.dev_owner) testCase.dev_owner = run.dev_owner;
    if (run.ticket && !testCase.ticket) testCase.ticket = run.ticket;
  }
  await saveCasesFile(runDir, normalizedCases);
  await writeJson(path.join(runDir, TEST_PLAN_JSON), casesToTestPlan(normalizedCases, {
    sourceMd: SOURCE_CASES_JSON,
    appName: run.app_name || 'ProGuide Markdown Cases'
  }));

  run.status = 'ready';
  run.total_cases = normalizedCases.length;
  await saveRun(runDir, run);
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'cases_interpreted',
    status: run.status,
    message: `${normalizedCases.length} caso(s) estructurado(s).`,
    payload: { ready: normalizedCases.filter((item) => item.automation_state === 'listo').length }
  });
  return { run, cases: normalizedCases };
}

export async function previewMarkdownRun({ root, sourceMd, metadata = {}, useAgent = false }) {
  await ensureLayout(root);
  await loadDotEnv(root);
  const sources = await readMarkdownSources(sourceMd);
  const cases = [];
  for (const source of sources) {
    const parsed = useAgent
      ? await interpretMarkdownWithAgent(source.markdown, { root, sourceName: source.name })
      : parseMarkdownCases(source.markdown, { sourceName: source.name });
    cases.push(...parsed);
  }
  for (const testCase of cases) {
    if (metadata.qa_owner && !testCase.qa_owner) testCase.qa_owner = metadata.qa_owner;
    if (metadata.dev_owner && !testCase.dev_owner) testCase.dev_owner = metadata.dev_owner;
    if (metadata.ticket && !testCase.ticket) testCase.ticket = metadata.ticket;
  }
  return {
    cases,
    warnings: normalizationWarnings(cases)
  };
}

export async function saveCasesForRun({ root, runId, casesPayload }) {
  const runDir = runPath(root, runId);
  const existing = await readJson(path.join(runDir, NORMALIZED_CASES_JSON), []);
  const cases = casesPayload.map((item, index) => normalizeCaseForStorage(item, index + 1, existing[index]));
  await saveCasesFile(runDir, cases);
  const run = await loadRunRecord(runDir);
  await writeJson(path.join(runDir, TEST_PLAN_JSON), casesToTestPlan(cases, {
    sourceMd: SOURCE_MD,
    appName: run.app_name || 'ProGuide Markdown Cases'
  }));
  run.status = 'ready';
  run.total_cases = cases.length;
  await saveRun(runDir, run);
  await appendEvent(runDir, {
    run_id: runId,
    type: 'cases_saved',
    status: 'ready',
    message: 'Cambios de preview guardados.'
  });
  return { cases };
}

export async function appendCasesToRun({ root, runId, casesPayload, baseUrl = '', metadata = {} }) {
  await ensureLayout(root);
  await loadDotEnv(root);
  if (!Array.isArray(casesPayload) || !casesPayload.length) {
    throw new Error('cases debe contener al menos un caso para append.');
  }
  const runDir = runPath(root, runId);
  if (!(await exists(runDir))) {
    throw new Error(`Run no encontrado: ${runId}. Root efectivo: ${root}.`);
  }
  const existing = await readJson(path.join(runDir, NORMALIZED_CASES_JSON), []);
  const additions = casesPayload.map((item, index) => normalizeCaseForStorage({
    ...item,
    qa_owner: item.qa_owner ?? metadata.qa_owner,
    dev_owner: item.dev_owner ?? metadata.dev_owner,
    ticket: item.ticket ?? metadata.ticket
  }, existing.length + index + 1));
  const cases = [...existing, ...additions];
  await saveCasesFile(runDir, cases);
  const run = await loadRunRecord(runDir);
  if (String(baseUrl || '').trim()) run.base_url = String(baseUrl || '').replace(/\/+$/, '');
  await writeJson(path.join(runDir, TEST_PLAN_JSON), casesToTestPlan(cases, {
    sourceMd: run.source_filename || SOURCE_MD,
    appName: run.app_name || 'ProGuide Markdown Cases'
  }));
  run.status = 'ready';
  run.total_cases = cases.length;
  run.finished_at = null;
  run.passed = 0;
  run.failed = 0;
  run.inconclusive = 0;
  run.setup_failed = 0;
  run.html_path = null;
  run.pdf_path = null;
  await fs.rm(path.join(runDir, RESULTS_JSON), { force: true }).catch(() => {});
  await fs.rm(path.join(runDir, 'summary.json'), { force: true }).catch(() => {});
  await saveRun(runDir, run);
  await appendEvent(runDir, {
    run_id: runId,
    type: 'cases_appended',
    status: 'ready',
    message: `${additions.length} caso(s) agregado(s) al run.`,
    payload: { appended: additions.length, total: cases.length }
  });
  return { run, cases, appended_cases: additions };
}

export async function executePreparedRun({ root, runId, baseUrl, credentials = {}, fromPlan = false }) {
  await loadDotEnv(root);
  const runDir = runPath(root, runId);
  const run = await loadRunRecord(runDir);
  const cases = await readJson(path.join(runDir, NORMALIZED_CASES_JSON), []);
  const config = await loadUiConfig(root);
  const actualBaseUrl = String(baseUrl || run.base_url || '').replace(/\/+$/, '');
  if (!actualBaseUrl) {
    run.status = 'error';
    run.finished_at = nowIso();
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'error_global',
      status: run.status,
      message: 'base_url es obligatorio para ejecutar casos Markdown en modo URL.'
    });
    throw new Error('base_url es obligatorio para ejecutar casos Markdown en modo URL.');
  }

  run.status = 'generating';
  run.base_url = actualBaseUrl;
  run.started_at = nowIso();
  await saveRun(runDir, run);
  await appendEvent(runDir, { run_id: run.id, type: 'plan_generated', status: run.status, message: 'Generando plan ejecutable.' });

  const plan = fromPlan
    ? await loadExistingTestPlan(runDir, cases, run)
    : casesToTestPlan(cases, { sourceMd: SOURCE_MD, appName: run.app_name || 'ProGuide Markdown Cases' });
  if (!plan.cases.length) {
    run.status = 'blocked';
    run.finished_at = nowIso();
    run.blocked = cases.length;
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'error_global',
      status: run.status,
      message: 'No hay casos para generar codigo. Revisa normalized_cases.json.'
    });
    throw new Error('No hay casos para generar codigo.');
  }

  await writeJson(path.join(runDir, TEST_PLAN_JSON), plan);
  const generatedDir = path.join(runDir, 'generated');

  let summary;
  try {
    let domContext = {
      available: false,
      error: 'api_cases_do_not_require_dom_context',
      by_case_id: {}
    };
    if (plan.cases.some((testCase) => !isApiPlanCase(testCase))) {
      await appendEvent(runDir, {
        run_id: run.id,
        type: 'dom_context_started',
        status: run.status,
        message: 'Abriendo browser para leer contexto visible de la app.'
      });
      domContext = await collectDomContext({
        root,
        runDir,
        plan,
        baseUrl: actualBaseUrl,
        config
      });
      await appendEvent(runDir, {
        run_id: run.id,
        type: domContext.available ? 'dom_context_collected' : 'dom_context_unavailable',
        status: run.status,
        message: domContext.available
          ? `Contexto DOM recolectado para ${Object.keys(domContext.by_case_id || {}).length} caso(s).`
          : `Contexto DOM no disponible: ${domContext.error || 'sin datos'}.`
      });
    } else {
      await appendEvent(runDir, {
        run_id: run.id,
        type: 'dom_context_skipped',
        status: run.status,
        message: 'Contexto DOM omitido: el run contiene solo casos REST API.'
      });
    }
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'code_generation_started',
      status: run.status,
      message: 'Agente generando codigo TypeScript Playwright.'
    });
    await generateTestsWithAgent({
      root,
      plan,
      cases,
      outputDir: generatedDir,
      config,
      domContext,
      usageContext: { runId: run.id, runDir }
    });
    await appendEvent(runDir, { run_id: run.id, type: 'tests_generated', status: 'running', message: 'Codigo TypeScript Playwright generado.' });

    run.status = 'running';
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'run_started',
      status: run.status,
      message: 'Ejecucion iniciada en Playwright Test.',
      payload: { parallel_workers: config.runner.parallel_workers || 'auto' }
    });

    summary = await runPlaywrightTests({
      testsDir: generatedDir,
      runDir,
      plan,
      baseUrl: actualBaseUrl,
      config,
      projectRoot: root,
      credentials
    });
  } catch (error) {
    run.status = 'error';
    run.finished_at = nowIso();
    await saveRun(runDir, run);
    await appendEvent(runDir, { run_id: run.id, type: 'error_global', status: run.status, message: error.message });
    throw error;
  }

  await writeJson(path.join(runDir, RESULTS_JSON), summary);
  await writeJson(path.join(runDir, 'summary.json'), summary);
  const counts = countSummary(summary);
  run.finished_at = summary.finished_at;
  run.passed = counts.passed;
  run.failed = counts.failed;
  run.inconclusive = counts.inconclusive;
  run.setup_failed = counts.setup_failed;
  run.blocked = cases.filter((item) => item.automation_state !== 'listo' && !item.excluded).length;
  run.status = statusFromSummary(counts, run.blocked);

  const htmlPath = await writeEvidenceReport({ summary, run, cases, runDir });
  run.html_path = relativePath(htmlPath, runDir);
  run.pdf_path = null;
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'pdf_skipped',
    status: run.status,
    message: 'Se genero evidencia HTML; PDF no disponible desde Fastify.'
  });
  await saveRun(runDir, run);
  await appendEvent(runDir, { run_id: run.id, type: 'run_finished', status: run.status, message: 'Run finalizado.' });
  return summary;
}

function normalizationWarnings(cases) {
  const warnings = [];
  for (const testCase of cases) {
    if (testCase.automation_state !== 'listo') {
      warnings.push({
        case_id: testCase.id,
        type: 'automation_state',
        message: testCase.state_reason || 'El caso requiere revision antes de ejecutar.'
      });
    }
    for (const assertion of testCase.assertions || []) {
      if (assertion.type === 'unsupported') {
        warnings.push({
          case_id: testCase.id,
          type: 'unsupported_api_assertion',
          message: `Asercion API no soportada: ${assertion.reason || 'unsupported'}`,
          assertion
        });
      }
    }
    for (const step of testCase.executable_steps || []) {
      if (Number(step.confidence ?? 1) < 0.75 || step.needs_review) {
        warnings.push({
          case_id: testCase.id,
          step: step.number,
          type: 'step_confidence',
          original_text: step.original_text,
          normalized_action: step.normalized_action,
          confidence: Number(step.confidence ?? 0)
        });
      }
      if (step.normalized_action === step.original_text && !explicitStep(step.original_text)) {
        warnings.push({
          case_id: testCase.id,
          step: step.number,
          type: 'unchanged_step',
          original_text: step.original_text,
          normalized_action: step.normalized_action,
          confidence: Number(step.confidence ?? 0)
        });
      }
      if (step.normalized_action === 'go to /' && !/(https?:\/\/|\/[A-Za-z0-9_\-/?#=&.]+)/.test(step.original_text || '')) {
        warnings.push({
          case_id: testCase.id,
          step: step.number,
          type: 'generic_navigation_fallback',
          original_text: step.original_text,
          normalized_action: step.normalized_action,
          confidence: Number(step.confidence ?? 0)
        });
      }
    }
  }
  return warnings;
}

async function interpretMarkdownWithAgent(markdown, { root, sourceName, usageContext = null }) {
  const config = await loadUiConfig(root);
  const baseline = parseMarkdownCases(markdown, { sourceName });
  const payload = {
    required_output_shape: markdownAgentSchema(),
    source_name: sourceName,
    markdown: markdown.slice(0, config.llm.max_context_chars),
    deterministic_baseline: baseline
  };
  const parsed = await callJsonModel(config, {
    root,
    system: MARKDOWN_AGENT_PROMPT,
    payload,
    purpose: 'interpretar casos Markdown',
    usageContext
  });
  const casesData = coerceCasesPayload(parsed);
  const cases = casesData.map((item, index) => normalizeCaseForStorage(item, index + 1, baseline[index]));
  return cases.slice(0, config.llm.max_cases).length ? cases.slice(0, config.llm.max_cases) : baseline;
}

function normalizeCaseForStorage(item, number, fallback = {}) {
  const title = String(item.title || fallback.title || `Caso ${number}`).trim();
  const originalSteps = cleanList(item.original_steps || item.steps || fallback.original_steps || fallback.steps || []);
  const expectedResults = cleanList(item.expected_results || item.expected || fallback.expected_results || fallback.expected || []);
  const flowRequests = normalizeApiRequests(firstArrayValue(
    item.requests,
    item.flow,
    item.api_requests,
    item.request_steps,
    fallback.requests,
    fallback.flow,
    fallback.api_requests,
    fallback.request_steps
  ));
  const request = normalizeApiRequest({
    ...((fallback && fallback.request) || {}),
    ...((fallback && fallback.api) || {}),
    ...((item && item.request) || {}),
    ...((item && item.api) || {}),
    type: item.type || item.kind || item.test_type || fallback.type || fallback.kind || fallback.test_type,
    route: item.route || fallback.route,
    method: item.method || item.request_method || item.http_method || item.request?.method || item.api?.method || fallback.request?.method,
    path: item.path || item.endpoint || item.request_path || item.url || item.request?.path || item.request?.endpoint || item.api?.path || item.api?.endpoint || fallback.request?.path,
    headers: item.headers || item.request_headers || item.request?.headers || item.api?.headers || fallback.request?.headers,
    query: item.query || item.params || item.request_query || item.request?.query || item.request?.params || item.api?.query || item.api?.params || fallback.request?.query,
    body: item.body ?? item.payload ?? item.request_body ?? item.request?.body ?? item.api?.body ?? fallback.request?.body,
    expected_status: item.expected_status || item.status_code || item.status || item.request?.expected_status || item.api?.expected_status || fallback.expected_status || fallback.request?.expected_status,
    steps: originalSteps,
    expected: expectedResults
  });
  const effectiveRequest = request.method && request.path
    ? request
    : (flowRequests[0]?.request || request);
  const type = inferCaseType({
    type: item.type || item.kind || item.test_type || fallback.type || fallback.kind || fallback.test_type,
    request: effectiveRequest,
    requests: flowRequests,
    steps: originalSteps,
    expected: expectedResults
  });
  const assertions = type === 'api' ? normalizeApiAssertions({
    assertions: item.assertions || item.api_assertions || fallback.assertions || [],
    expected: expectedResults,
    expectedStatus: effectiveRequest.expected_status
  }) : [];
  if (type === 'api') rejectUnsupportedApiAssertions(assertions, title);
  const apiExecutableSteps = type === 'api' && !originalSteps.length
    ? buildApiExecutableSteps({
      request: effectiveRequest,
      requests: flowRequests,
      assertions,
      captures: normalizeApiCaptures(item.captures ?? item.save ?? item.extract ?? fallback.captures ?? fallback.save ?? fallback.extract)
    })
    : [];
  const executableSteps = Array.isArray(item.executable_steps) && item.executable_steps.length
    ? item.executable_steps.map((step, index) => ({
      number: Number(step.number || index + 1),
      original_text: String(step.original_text || originalSteps[index] || ''),
      normalized_action: String(step.normalized_action || (type === 'api'
        ? normalizeApiCaseStep(step.original_text || originalSteps[index] || '')
        : normalizeStep(step.original_text || originalSteps[index] || ''))),
      status: String(step.status || 'pending'),
      started_at: step.started_at || null,
      finished_at: step.finished_at || null,
      duration_seconds: Number(step.duration_seconds || 0),
      observed_result: String(step.observed_result || ''),
      screenshot: step.screenshot || null,
      error: step.error || null,
      confidence: Number(step.confidence ?? 1),
      needs_review: Boolean(step.needs_review),
      review_reason: String(step.review_reason || '')
    }))
    : (apiExecutableSteps.length ? apiExecutableSteps : buildSteps(originalSteps, { type }));
  const route = type === 'api'
    ? (effectiveRequest.path || inferCaseRoute(item.route || fallback.route, originalSteps, executableSteps))
    : inferCaseRoute(item.route || fallback.route, originalSteps, executableSteps);
  const explicitAutomationState = item.automation_state || fallback.automation_state || '';
  const apiAutomation = type === 'api'
    ? assessAutomation(originalSteps, expectedResults, { type, request: effectiveRequest, requests: flowRequests, assertions })
    : null;
  return {
    id: safeId(item.id || fallback.id || `caso_${number}_${title}`),
    number: Number(item.number || fallback.number || number),
    type,
    title,
    description: String(item.description ?? fallback.description ?? ''),
    priority: normalizePriority(item.priority || fallback.priority || 'media'),
    tags: splitTags(item.tags || fallback.tags || []),
    preconditions: cleanList(item.preconditions || fallback.preconditions || []),
    data_used: maskSecretLines(cleanList(item.data_used || fallback.data_used || [])),
    data: sanitizeCaseData(mergeCaseData(item.data || {}, fallback.data || {})),
    request: type === 'api' ? effectiveRequest : null,
    requests: type === 'api' ? flowRequests : [],
    assertions,
    original_steps: originalSteps,
    executable_steps: executableSteps,
    expected_results: expectedResults,
    confidence: Number(item.confidence ?? fallback.confidence ?? 1),
    automation_state: normalizeAutomationState(explicitAutomationState || apiAutomation?.[0] || 'listo'),
    state_reason: String(item.state_reason ?? fallback.state_reason ?? apiAutomation?.[1] ?? ''),
    original_markdown: String(item.original_markdown ?? fallback.original_markdown ?? ''),
    route,
    debug: Boolean(item.debug ?? fallback.debug ?? false),
    qa_owner: noneIfEmpty(item.qa_owner ?? fallback.qa_owner),
    dev_owner: noneIfEmpty(item.dev_owner ?? fallback.dev_owner),
    ticket: noneIfEmpty(item.ticket ?? fallback.ticket),
    excluded: Boolean(item.excluded ?? fallback.excluded ?? false),
    parallelizable: item.parallelizable ?? fallback.parallelizable ?? true,
    result_obtained: String(item.result_obtained ?? fallback.result_obtained ?? ''),
    status: String(item.status || fallback.status || 'pending'),
    started_at: item.started_at || fallback.started_at || null,
    finished_at: item.finished_at || fallback.finished_at || null,
    duration_seconds: Number(item.duration_seconds || fallback.duration_seconds || 0),
    artifacts: Array.isArray(item.artifacts) ? item.artifacts : (fallback.artifacts || [])
  };
}

function markdownAgentSchema() {
  return {
    cases: [{
      id: 'caso_1_login_valido',
      number: 1,
      type: 'ui|api',
      title: 'Login valido',
      description: 'string',
      priority: 'baja|media|alta|critica',
      tags: ['string'],
      preconditions: ['string'],
      data_used: ['Password: ******'],
      request: {
        method: 'GET|POST|PUT|PATCH|DELETE',
        path: '/api/resource',
        headers: {},
        query: {},
        body: {},
        expected_status: 200
      },
      requests: [{
        id: 'login',
        method: 'POST',
        path: '/login',
        headers: {},
        query: {},
        body: {},
        expected_status: 200,
        assertions: [{ path: 'access_token', exists: true }],
        captures: { access_token: 'access_token' }
      }],
      assertions: [{ type: 'status', expected: 200 }],
      original_steps: ['string'],
      executable_steps: [{
        number: 1,
        original_text: 'Ir a /login',
        normalized_action: 'go to /login',
        confidence: 0.9,
        needs_review: false,
        review_reason: ''
      }],
      expected_results: ['page shows Dashboard'],
      confidence: 0.9,
      automation_state: 'listo|necesita_revision|no_automatizable_aun',
      state_reason: 'string',
      original_markdown: 'string',
      route: '/',
      qa_owner: 'string or null',
      dev_owner: 'string or null',
      ticket: 'string or null',
      excluded: false,
      parallelizable: true
    }]
  };
}

function coerceCasesPayload(data) {
  if (Array.isArray(data.cases)) return data.cases;
  if (Array.isArray(data.normalized_cases)) return data.normalized_cases;
  if (Array.isArray(data.test_cases)) return data.test_cases;
  throw new Error('El agente no devolvio una lista de casos en la clave cases.');
}

async function loadUiConfig(root) {
  const config = {
    runner: {
      browser: 'chromium',
      parallel_workers: 'auto',
      video: 'on',
      screenshots: 'on',
      traces: 'retain_on_failure'
    },
    identity: {
      run_user_email: '',
      run_user_name: '',
      project_name: '',
      project_key: '',
      require_user_email: false,
      require_project_name: false
    },
    llm: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.2,
      max_cases: 12,
      max_context_chars: 50000,
      max_output_tokens: 8000
    }
  };
  const configPath = path.join(root, PROGUIDE_DIR, 'config.yaml');
  if (!(await exists(configPath))) return config;
  const text = await fs.readFile(configPath, 'utf8');
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^([A-Za-z_][\w-]*):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const valueMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!valueMatch || !config[section]) continue;
    config[section][valueMatch[1]] = parseYamlScalar(valueMatch[2]);
  }
  return config;
}

async function resolveRunIdentity(root, metadata = {}, config = {}) {
  const rootPath = path.resolve(root);
  const identityConfig = config.identity || {};
  const git = gitIdentity(rootPath);
  const packageName = await packageProjectName(rootPath);
  const pyprojectName = await pyprojectProjectName(rootPath);
  const remoteProjectName = projectNameFromRemote(git.remote);
  const folderName = path.basename(rootPath);

  const runUserEmail = firstValue(
    metadata.run_user_email,
    metadata.user_email,
    identityConfig.run_user_email,
    process.env.PROGUIDE_RUN_USER_EMAIL,
    git.email
  );
  const runUserName = firstValue(
    metadata.run_user_name,
    metadata.user_name,
    identityConfig.run_user_name,
    process.env.PROGUIDE_RUN_USER_NAME,
    git.name
  );
  const projectName = firstValue(
    metadata.project_name,
    metadata.project,
    metadata.app_name,
    identityConfig.project_name,
    process.env.PROGUIDE_PROJECT_NAME,
    packageName,
    pyprojectName,
    remoteProjectName,
    folderName
  );
  const projectKey = firstValue(
    metadata.project_key,
    identityConfig.project_key,
    process.env.PROGUIDE_PROJECT_KEY,
    slug(projectName)
  );

  if (identityConfig.require_user_email && !runUserEmail) {
    throw new Error('Falta metadata de usuario: configura identity.run_user_email, PROGUIDE_RUN_USER_EMAIL o pasa run_user_email por MCP/CLI.');
  }
  if (identityConfig.require_project_name && !projectName) {
    throw new Error('Falta metadata de proyecto: configura identity.project_name, PROGUIDE_PROJECT_NAME o pasa project_name por MCP/CLI.');
  }

  return {
    run_user_email: runUserEmail || '',
    run_user_name: runUserName || '',
    company_domain: emailDomain(runUserEmail),
    project_name: projectName || '',
    project_key: projectKey || '',
    workspace_root: rootPath,
    run_source: firstValue(metadata.run_source, metadata.source, process.env.PROGUIDE_RUN_SOURCE) || '',
    git_branch: git.branch || '',
    git_commit: git.commit || '',
    identity_source: {
      run_user_email: sourceFor([
        ['metadata', metadata.run_user_email || metadata.user_email],
        ['config', identityConfig.run_user_email],
        ['env', process.env.PROGUIDE_RUN_USER_EMAIL],
        ['git', git.email]
      ]),
      run_user_name: sourceFor([
        ['metadata', metadata.run_user_name || metadata.user_name],
        ['config', identityConfig.run_user_name],
        ['env', process.env.PROGUIDE_RUN_USER_NAME],
        ['git', git.name]
      ]),
      project_name: sourceFor([
        ['metadata', metadata.project_name || metadata.project || metadata.app_name],
        ['config', identityConfig.project_name],
        ['env', process.env.PROGUIDE_PROJECT_NAME],
        ['package_json', packageName],
        ['pyproject', pyprojectName],
        ['git_remote', remoteProjectName],
        ['folder', folderName]
      ]),
      project_key: sourceFor([
        ['metadata', metadata.project_key],
        ['config', identityConfig.project_key],
        ['env', process.env.PROGUIDE_PROJECT_KEY],
        ['derived', slug(projectName)]
      ])
    }
  };
}

function gitIdentity(root) {
  return {
    email: gitValue(root, ['config', '--get', 'user.email']),
    name: gitValue(root, ['config', '--get', 'user.name']),
    remote: gitValue(root, ['config', '--get', 'remote.origin.url']),
    branch: gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: gitValue(root, ['rev-parse', '--short', 'HEAD'])
  };
}

function gitValue(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 2500,
    windowsHide: true
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

async function packageProjectName(root) {
  const packagePath = path.join(root, 'package.json');
  try {
    const data = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    return cleanProjectName(data.name || '');
  } catch {
    return '';
  }
}

async function pyprojectProjectName(root) {
  try {
    const text = await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8');
    const match = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    return cleanProjectName(match?.[1] || '');
  } catch {
    return '';
  }
}

function projectNameFromRemote(remote) {
  const text = String(remote || '').trim();
  if (!text) return '';
  const withoutQuery = text.split(/[?#]/)[0];
  const last = withoutQuery.split(/[/:\\]/).filter(Boolean).at(-1) || '';
  return cleanProjectName(last.replace(/\.git$/i, ''));
}

function cleanProjectName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/^@[^/]+\//, '');
}

function firstValue(...values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

function sourceFor(entries) {
  const found = entries.find(([, value]) => String(value ?? '').trim());
  return found?.[0] || '';
}

function emailDomain(email) {
  const match = String(email || '').trim().match(/@([^@\s]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

async function readMarkdownText(filePath) {
  const data = await fs.readFile(filePath);
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return repairDecodedMarkdown(new TextDecoder('utf-16le').decode(data.subarray(2)));
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return repairDecodedMarkdown(new TextDecoder('utf-16le').decode(swapBytes(data.subarray(2))));
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return repairDecodedMarkdown(new TextDecoder('utf-8').decode(data.subarray(3)));
  }
  return repairDecodedMarkdown(new TextDecoder('utf-8', { fatal: false }).decode(data));
}

async function readMarkdownSources(sourceMd) {
  const paths = (Array.isArray(sourceMd) ? sourceMd : [sourceMd]).filter(Boolean);
  if (!paths.length) throw new Error('Debes pasar al menos un archivo Markdown.');
  return Promise.all(paths.map(async (filePath) => ({
    path: filePath,
    name: path.basename(filePath),
    markdown: await readMarkdownText(filePath)
  })));
}

function markdownSourceFilename(sources) {
  if (sources.length === 1) return sources[0].name;
  const names = sources.map((source) => source.name).join(', ');
  return names.length <= 180 ? names : `${sources.length} markdown files`;
}

function combineMarkdownSources(sources) {
  if (sources.length === 1) return sources[0].markdown;
  return sources
    .map((source) => `<!-- source: ${source.name} -->\n\n${source.markdown.trim()}`)
    .join('\n\n');
}

function swapBytes(buffer) {
  const swapped = Buffer.from(buffer);
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    const next = swapped[index];
    swapped[index] = swapped[index + 1];
    swapped[index + 1] = next;
  }
  return swapped;
}

function repairDecodedMarkdown(text) {
  return text.replace(/^(\s*)\ufffd(?=\s+)/gm, '$1-');
}

