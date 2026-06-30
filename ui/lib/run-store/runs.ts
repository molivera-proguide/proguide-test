import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from '../shared/env.js';
import { nowIso } from '../shared/time.js';
import { maskSecretText, maskSecretsDeep } from '../shared/secrets.js';
import { parseMarkdownCases } from '../markdown/parse-cases.js';
import { isApiPlanCase } from '../codegen/api-spec.js';
import { casesToTestPlan } from '../codegen/test-plan.js';
import { collectDomContext } from '../codegen/dom-context.js';
import { groundCases, caseGroundingConfirmed } from '../codegen/grounding.js';
import { generateTestsWithAgent, loadExistingTestPlan, extractCaseCode } from '../codegen/agent.js';
import { runPlaywrightTests } from '../runner/playwright.js';
import { writeEvidenceReport } from '../runner/evidence.js';
import { isPathInside } from '../shared/paths.js';
import {
  SOURCE_MD,
  SOURCE_CASES_JSON,
  NORMALIZED_CASES_JSON,
  TEST_PLAN_JSON,
  RESULTS_JSON,
  PROGUIDE_DIR,
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
} from './io.js';
import { resolveRunIdentity } from './identity.js';
import { loadUiConfig } from './config.js';
import {
  readMarkdownSources,
  markdownSourceFilename,
  combineMarkdownSources
} from '../markdown/sources.js';
import {
  normalizeCaseForStorage,
  interpretMarkdownWithAgent,
  normalizationWarnings
} from '../cases/storage.js';

// High-level run lifecycle and storage orchestration: create/preview/append
// runs from Markdown or structured cases, execute prepared runs (codegen +
// Playwright + evidence + summary), and load run bundles/records. Plus the
// run-identity resolution, UI config loading and Markdown source reading
// helpers. This is the orchestration core the public facade re-exports.

type PrepareMarkdownRunInput = {
  root: string;
  sourceMd: string | string[];
  baseUrl?: string;
  metadata?: ProGuide.Metadata;
  useAgent?: boolean;
  credentials?: ProGuide.Dict;
  ground?: boolean;
};

type PrepareCasesRunInput = {
  root: string;
  cases: ProGuide.CaseInput[];
  baseUrl?: string;
  metadata?: ProGuide.Metadata;
  credentials?: ProGuide.Dict;
  ground?: boolean;
};

type SaveCasesForRunInput = {
  root: string;
  runId: string;
  casesPayload: ProGuide.CaseInput[];
};

type AppendCasesToRunInput = SaveCasesForRunInput & {
  baseUrl?: string;
  metadata?: ProGuide.Metadata;
};

type ExecutePreparedRunInput = {
  root: string;
  runId: string;
  baseUrl?: string;
  credentials?: ProGuide.Dict;
  fromPlan?: boolean;
  frozen?: boolean;
};

export async function listRunRecords(root: string): Promise<ProGuide.Dict[]> {
  const runsDir = runsRoot(root);
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const records: ProGuide.Dict[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = path.join(runsDir, entry.name);
      try {
        records.push(await loadRunRecord(entryDir));
      } catch (error) {
        records.push(await legacyRunRecord(entryDir, entry.name, error));
      }
    }
    return records.sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );
  } catch {
    return [];
  }
}

export async function loadRunBundle(root: string, runId: string): Promise<ProGuide.Dict> {
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

export async function loadGeneratedCaseCode(
  root: string,
  runId: string,
  caseId: string
): Promise<ProGuide.Dict | null> {
  const runDir = runPath(root, runId);
  const generatedDir = path.join(runDir, 'generated');
  if (!(await exists(generatedDir))) return null;
  let found: ProGuide.Dict | null = null;
  await walk(generatedDir, async (filePath) => {
    if (found || !['.ts', '.js', '.cjs', '.mjs'].includes(path.extname(filePath).toLowerCase()))
      return;
    if (
      ['proguide-test-runtime.cjs', 'proguide-test-runtime.mjs'].includes(path.basename(filePath))
    )
      return;
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

export async function prepareMarkdownRun({
  root,
  sourceMd,
  baseUrl,
  metadata = {},
  useAgent = false,
  credentials = {},
  ground = true
}: PrepareMarkdownRunInput): Promise<ProGuide.Dict> {
  await ensureLayout(root);
  await loadDotEnv(root);
  const config = await loadUiConfig(root);
  const identity = await resolveRunIdentity(root, metadata, config);
  const sources = await readMarkdownSources(sourceMd);
  const sourceFilename = markdownSourceFilename(sources);
  const runDir = await newRunDir(root);
  const run: ProGuide.Dict = {
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
    needs_calibration: 0,
    pdf_path: null,
    html_path: null,
    data_dir: runDir
  };

  await fs.mkdir(runDir, { recursive: true });
  await saveRun(runDir, run);
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'run_created',
    status: run.status,
    message: 'Run creado.'
  });
  const markdown = combineMarkdownSources(sources);
  await fs.writeFile(path.join(runDir, SOURCE_MD), maskSecretText(markdown), 'utf8');
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'file_received',
    message:
      sources.length === 1
        ? `Archivo recibido: ${sources[0].name}`
        : `Archivos recibidos: ${sources.map((source) => source.name).join(', ')}`
  });

  let cases: ProGuide.Dict[];
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

  const cleanBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  if (cleanBaseUrl && ground !== false) {
    await groundCases({
      root,
      baseUrl: cleanBaseUrl,
      config,
      credentials,
      cases
    });
  }

  await saveCasesFile(runDir, cases);
  await writeJson(
    path.join(runDir, TEST_PLAN_JSON),
    casesToTestPlan(cases, {
      sourceMd: SOURCE_MD,
      appName: run.app_name || 'ProGuide Markdown Cases'
    })
  );

  const isAnyListo = cases.some((item) => item.automation_state === 'listo');
  if (!isAnyListo) {
    run.status = 'blocked';
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'warning',
      status: run.status,
      message: `${cases.length} caso(s) interpretado(s), 0 automatizables.`
    });
  } else {
    run.status = 'ready';
  }
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

export async function prepareCasesRun({
  root,
  cases,
  baseUrl,
  metadata = {},
  credentials = {},
  ground = true
}: PrepareCasesRunInput): Promise<ProGuide.Dict> {
  await ensureLayout(root);
  await loadDotEnv(root);
  const config = await loadUiConfig(root);
  const identity = await resolveRunIdentity(root, metadata, config);
  if (!Array.isArray(cases) || !cases.length) {
    throw new Error('cases debe contener al menos un caso.');
  }
  const normalizedCases = cases.map((item, index) => normalizeCaseForStorage(item, index + 1));

  const runDir = await newRunDir(root);
  const run: ProGuide.Dict = {
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
    needs_calibration: 0,
    pdf_path: null,
    html_path: null,
    data_dir: runDir
  };

  await fs.mkdir(runDir, { recursive: true });
  await saveRun(runDir, run);
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'run_created',
    status: run.status,
    message: 'Run creado.'
  });
  await writeJson(path.join(runDir, SOURCE_CASES_JSON), maskSecretsDeep(cases));
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'file_received',
    message: 'Casos estructurados recibidos.'
  });

  for (const testCase of normalizedCases) {
    if (run.qa_owner && !testCase.qa_owner) testCase.qa_owner = run.qa_owner;
    if (run.dev_owner && !testCase.dev_owner) testCase.dev_owner = run.dev_owner;
    if (run.ticket && !testCase.ticket) testCase.ticket = run.ticket;
  }

  const cleanBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  if (cleanBaseUrl && ground !== false) {
    await groundCases({
      root,
      baseUrl: cleanBaseUrl,
      config,
      credentials,
      cases: normalizedCases
    });
  }

  await saveCasesFile(runDir, normalizedCases);
  await writeJson(
    path.join(runDir, TEST_PLAN_JSON),
    casesToTestPlan(normalizedCases, {
      sourceMd: SOURCE_CASES_JSON,
      appName: run.app_name || 'ProGuide Markdown Cases'
    })
  );

  const isAnyListo = normalizedCases.some((item) => item.automation_state === 'listo');
  if (!isAnyListo) {
    run.status = 'blocked';
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'warning',
      status: run.status,
      message: `${normalizedCases.length} caso(s) estructurado(s), 0 automatizables.`
    });
  } else {
    run.status = 'ready';
  }
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

export async function previewMarkdownRun({
  root,
  sourceMd,
  baseUrl,
  metadata = {},
  useAgent = false,
  credentials = {},
  ground = true
}: PrepareMarkdownRunInput): Promise<ProGuide.Dict> {
  await ensureLayout(root);
  await loadDotEnv(root);
  const sources = await readMarkdownSources(sourceMd);
  const cases: ProGuide.Dict[] = [];
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

  const cleanBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  if (cleanBaseUrl && ground !== false) {
    const config = await loadUiConfig(root);
    await groundCases({
      root,
      baseUrl: cleanBaseUrl,
      config,
      credentials,
      cases
    });
  }

  return {
    cases,
    warnings: normalizationWarnings(cases)
  };
}

export async function saveCasesForRun({
  root,
  runId,
  casesPayload
}: SaveCasesForRunInput): Promise<ProGuide.Dict> {
  const runDir = runPath(root, runId);
  const existing = await readJson(path.join(runDir, NORMALIZED_CASES_JSON), []);
  const cases = casesPayload.map((item, index) =>
    normalizeCaseForStorage(item, index + 1, existing[index])
  );
  await saveCasesFile(runDir, cases);
  const run = await loadRunRecord(runDir);
  await writeJson(
    path.join(runDir, TEST_PLAN_JSON),
    casesToTestPlan(cases, {
      sourceMd: SOURCE_MD,
      appName: run.app_name || 'ProGuide Markdown Cases'
    })
  );
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

export async function appendCasesToRun({
  root,
  runId,
  casesPayload,
  baseUrl = '',
  metadata = {}
}: AppendCasesToRunInput): Promise<ProGuide.Dict> {
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
  const additions = casesPayload.map((item, index) =>
    normalizeCaseForStorage(
      {
        ...item,
        qa_owner: item.qa_owner ?? metadata.qa_owner,
        dev_owner: item.dev_owner ?? metadata.dev_owner,
        ticket: item.ticket ?? metadata.ticket
      },
      existing.length + index + 1
    )
  );
  const cases = [...existing, ...additions];
  await saveCasesFile(runDir, cases);
  const run = await loadRunRecord(runDir);
  if (String(baseUrl || '').trim()) run.base_url = String(baseUrl || '').replace(/\/+$/, '');
  await writeJson(
    path.join(runDir, TEST_PLAN_JSON),
    casesToTestPlan(cases, {
      sourceMd: run.source_filename || SOURCE_MD,
      appName: run.app_name || 'ProGuide Markdown Cases'
    })
  );
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

export async function executePreparedRun({
  root,
  runId,
  baseUrl,
  credentials = {},
  fromPlan = false,
  frozen = false
}: ExecutePreparedRunInput): Promise<ProGuide.Dict> {
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
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'plan_generated',
    status: run.status,
    message: 'Generando plan ejecutable.'
  });

  const plan = fromPlan
    ? await loadExistingTestPlan(runDir, cases, run)
    : casesToTestPlan(cases, {
        sourceMd: SOURCE_MD,
        appName: run.app_name || 'ProGuide Markdown Cases'
      });
  if (!plan.cases.length) {
    const dropped = cases
      .filter((c) => !c.excluded)
      .map((c) => `- ${c.id} (${c.title}): ${c.automation_state} — ${c.state_reason}`);
    const detail = dropped.length
      ? `Todos los casos quedaron fuera del plan:\n${dropped.join('\n')}\n` +
        `Sólo se generan casos en estado 'listo'. Revisá pasos/resultado esperado o pasá los casos como JSON estructurado.`
      : 'No hay casos para generar codigo. Revisa normalized_cases.json.';
    run.status = 'blocked';
    run.finished_at = nowIso();
    run.blocked = cases.length;
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'error_global',
      status: run.status,
      message: detail
    });
    throw new Error(detail);
  }

  // Carry the dry-run grounding verdict onto each plan case so result
  // classification can tell a real regression (grounding had confirmed the
  // target) from a calibration miss.
  const groundedCaseIds = new Set(
    cases.filter((testCase) => caseGroundingConfirmed(testCase)).map((testCase) => String(testCase.id))
  );
  for (const planCase of plan.cases) {
    planCase.grounding_confirmed = groundedCaseIds.has(String(planCase.id));
  }

  await writeJson(path.join(runDir, TEST_PLAN_JSON), plan);
  const generatedDir = path.join(runDir, 'generated');

  let summary: ProGuide.Dict;
  try {
    if (frozen) {
      if (!(await exists(generatedDir))) {
        throw new Error(`no hay spec congelado para ${runId}; corré una calibración o promove primero`);
      }
      const files = await fs.readdir(generatedDir).catch(() => []);
      const hasSpec = files.some(file => file.endsWith('.spec.ts'));
      if (!hasSpec) {
        throw new Error(`no hay spec congelado para ${runId}; corré una calibración o promove primero`);
      }

      run.status = 'running';
      await saveRun(runDir, run);
      await appendEvent(runDir, {
        run_id: run.id,
        type: 'run_started',
        status: run.status,
        message: 'Ejecucion iniciada en Playwright Test (modo frozen).',
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
    } else {
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
          config,
          credentials
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
      await appendEvent(runDir, {
        run_id: run.id,
        type: 'tests_generated',
        status: 'running',
        message: 'Codigo TypeScript Playwright generado.'
      });

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
    }
  } catch (error: any) {
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

  await writeJson(path.join(runDir, RESULTS_JSON), summary);
  await writeJson(path.join(runDir, 'summary.json'), summary);
  const counts = countSummary(summary);
  run.finished_at = summary.finished_at;
  run.passed = counts.passed;
  run.failed = counts.failed;
  run.inconclusive = counts.inconclusive;
  run.setup_failed = counts.setup_failed;
  run.needs_calibration = counts.needs_calibration;
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
  await appendEvent(runDir, {
    run_id: run.id,
    type: 'run_finished',
    status: run.status,
    message: 'Run finalizado.'
  });
  return summary;
}

// Resolves the suite directory for a module, rejecting path traversal so a
// crafted module name (e.g. "../../x") cannot escape proguide_tests/suite/.
function suiteDirFor(root: string, module: string): string {
  const suiteRoot = path.join(root, PROGUIDE_DIR, 'suite');
  const suiteDir = path.join(suiteRoot, module);
  if (suiteDir === suiteRoot || !isPathInside(suiteRoot, suiteDir)) {
    throw new Error(`module invalido: "${module}"`);
  }
  return suiteDir;
}

export async function promoteRunToSuite({
  root,
  runId,
  module
}: {
  root: string;
  runId: string;
  module: string;
}) {
  const runDir = runPath(root, runId);
  const run = await loadRunRecord(runDir);
  const suiteDir = suiteDirFor(root, module);

  await fs.mkdir(suiteDir, { recursive: true });

  const casesSrc = path.join(runDir, NORMALIZED_CASES_JSON);
  const planSrc = path.join(runDir, TEST_PLAN_JSON);
  const generatedSrc = path.join(runDir, 'generated');

  if (!(await exists(casesSrc)) || !(await exists(planSrc)) || !(await exists(generatedSrc))) {
    throw new Error(`El run ${runId} no esta calibrado. Ejecutalo primero.`);
  }

  // Copy cases and plan
  await fs.copyFile(casesSrc, path.join(suiteDir, 'cases.json'));
  await fs.copyFile(planSrc, path.join(suiteDir, 'plan.json'));

  // Copy generated folder (spec files + runtime shim)
  const generatedDest = path.join(suiteDir, 'generated');
  await fs.rm(generatedDest, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(generatedDest, { recursive: true });
  
  const files = await fs.readdir(generatedSrc);
  for (const file of files) {
    const src = path.join(generatedSrc, file);
    const dest = path.join(generatedDest, file);
    const stat = await fs.stat(src);
    if (stat.isFile()) {
      await fs.copyFile(src, dest);
    }
  }

  // Write suite.json
  const metadata = {
    module,
    calibration_base_url: run.base_url || '',
    origin_run_id: runId,
    created_at: nowIso()
  };
  await writeJson(path.join(suiteDir, 'suite.json'), metadata);

  return { suiteDir, metadata };
}

export async function loadSuite({
  root,
  module
}: {
  root: string;
  module: string;
}) {
  const suiteDir = suiteDirFor(root, module);
  const suiteJsonPath = path.join(suiteDir, 'suite.json');
  if (!(await exists(suiteJsonPath))) {
    return null;
  }
  const metadata = await readJson(suiteJsonPath, {});
  const cases = await readJson(path.join(suiteDir, 'cases.json'), []);
  return {
    module,
    metadata,
    cases
  };
}

export async function listSuites(root: string): Promise<string[]> {
  const suiteDir = path.join(root, PROGUIDE_DIR, 'suite');
  if (!(await exists(suiteDir))) {
    return [];
  }
  const entries = await fs.readdir(suiteDir, { withFileTypes: true });
  const suites: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      suites.push(entry.name);
    }
  }
  return suites.sort();
}

export async function executeFrozenSuite({
  root,
  module,
  baseUrl,
  credentials = {}
}: {
  root: string;
  module: string;
  baseUrl?: string;
  credentials?: ProGuide.Dict;
}) {
  const suiteDir = suiteDirFor(root, module);
  const casesPath = path.join(suiteDir, 'cases.json');
  const planPath = path.join(suiteDir, 'plan.json');
  const generatedDir = path.join(suiteDir, 'generated');
  const suiteJsonPath = path.join(suiteDir, 'suite.json');

  if (!(await exists(casesPath)) || !(await exists(planPath)) || !(await exists(generatedDir))) {
    throw new Error(`La suite ${module} no existe o no tiene codigo congelado. Proba promoviendo un run primero.`);
  }

  const suiteMeta = await readJson(suiteJsonPath, {});
  const cases = await readJson(casesPath, []);
  const plan = await readJson(planPath, {});

  const runDir = await newRunDir(root);
  const runId = path.basename(runDir);
  
  const run = {
    id: runId,
    status: 'ready',
    app_name: plan.app_name || 'ProGuide Markdown Cases',
    base_url: baseUrl || suiteMeta.calibration_base_url || '',
    created_at: nowIso(),
    total_cases: cases.length,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    setup_failed: 0,
    needs_calibration: 0,
    blocked: 0,
    html_path: null,
    pdf_path: null
  };
  await saveRun(runDir, run);
  
  await fs.copyFile(casesPath, path.join(runDir, NORMALIZED_CASES_JSON));
  await fs.copyFile(planPath, path.join(runDir, TEST_PLAN_JSON));
  
  const runGeneratedDir = path.join(runDir, 'generated');
  await fs.mkdir(runGeneratedDir, { recursive: true });
  const files = await fs.readdir(generatedDir);
  for (const file of files) {
    const src = path.join(generatedDir, file);
    if (!(await fs.stat(src)).isFile()) continue;
    await fs.copyFile(src, path.join(runGeneratedDir, file));
  }

  return executePreparedRun({
    root,
    runId,
    baseUrl: run.base_url,
    credentials,
    fromPlan: true,
    frozen: true
  });
}
