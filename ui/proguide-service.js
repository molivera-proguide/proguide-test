import Anthropic from '@anthropic-ai/sdk';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { playwrightCommand, proguideRequireAnchor, runtimeEnv } from './playwright-runtime.js';
import { loadDotEnv } from './lib/shared/env.js';
import { escapeHtml } from './lib/shared/html.js';
import { safeNumber, roundMoney } from './lib/shared/num.js';
import { estimateLlmCost, normalizeLlmUsage } from './lib/usage/pricing.js';
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
import { isApiPlanCase, generateApiTestSpec } from './lib/codegen/api-spec.js';
import { casesToTestPlan } from './lib/codegen/test-plan.js';
import {
  collectPlaywrightSpecs,
  caseFromPlaywrightSpec,
  normalizePlaywrightSpecResult
} from './lib/runner/results.js';
import {
  playwrightWorkerArgs,
  normalizePlaywrightScreenshot,
  normalizePlaywrightTrace,
  normalizePlaywrightVideo
} from './lib/runner/config.js';

export { playwrightWorkerArgs };

const PROGUIDE_DIR = 'proguide_tests';
const RUNS_DIR = 'runs';
const RUN_JSON = 'run.json';
const SOURCE_MD = 'source.md';
const SOURCE_CASES_JSON = 'source_cases.json';
const NORMALIZED_CASES_JSON = 'normalized_cases.json';
const TEST_PLAN_JSON = 'test_plan.json';
const EVENTS_JSONL = 'events.jsonl';
const RESULTS_JSON = 'results.json';
const USAGE_DIR = 'usage';
const LLM_USAGE_JSON = 'llm_usage.json';
const LLM_USAGE_JSONL = 'llm_usage.jsonl';
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

const PLAYWRIGHT_CODE_AGENT_PROMPT = `You are a senior QA automation engineer.
Generate production-ready TypeScript Playwright Test code from already-approved QA test cases.

Rules:
- Do not create, remove, merge, split, or rename test cases.
- Generate one Playwright test(...) per input test case.
- Each test title must start with the exact provided test_title_prefix.
- Import Playwright from the generated runtime shim with:
  import { test, expect } from './proguide-test-runtime.mjs';
- Use TypeScript/JavaScript Playwright Test async API style.
- Use test.step for meaningful actions/assertions so evidence keeps readable steps.
- Use robust locators: getByRole, getByLabel, getByPlaceholder, getByText, locator with semantic attributes.
- When dom_context is available, prefer its real roles, labels, placeholders, text, data-testid, id, and name attributes over guessed selectors.
- Treat normalized steps as authoritative DSL:
  - fill [selector] with value -> page.locator(selector).fill(value)
  - click [selector] -> page.locator(selector).click()
  - expect [selector] to contain text "value" -> assert that exact text
  - expect [selector] to be visible -> assert visibility
  - expect text "value" -> assert visible text containing value
- API/REST cases are normally generated deterministically by ProGuide. If a case with type "api" appears, use Playwright request fixtures, not browser page locators.
- Do not use PROGUIDE_USER_* environment credentials when the step contains a literal email, username, password, or value.
- Use credentials from environment variables PROGUIDE_USER_EMAIL, PROGUIDE_USER_USERNAME, PROGUIDE_USER_PASSWORD when needed.
- If a test case includes data.user.email or data.user.password, prefer those per-case values for inputs over global defaults.
- Exact strings in expected and expected_results override shorter or older strings in original_steps.
- Never invent data-testid/id selectors. Use only selectors present in normalized steps or dom_context.snapshot.controls[].selector_hint. If no selector exists, assert real headings or visible text from dom_context instead.
- Prefer data-testid/id selector_hint over placeholder locators when the placeholder is empty, generic, or rendered as bullets/symbols.
- Keep assertions explicit with Playwright expect.
- Include imports and any helper functions in the generated file.
- Return only valid JSON with this shape:
  {"files":[{"path":"test_markdown_cases.spec.ts","content":"...typescript code..."}]}
- Do not include markdown fences.`;

const DOM_CONTEXT_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { URL } = require('node:url');

const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || __filename);
const playwright = req('playwright');

const DOM_SNAPSHOT_JS = (maxControls) => {
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const text = (value, limit = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const cssEscape = (value) => {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  };
  const inferredRole = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') return el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return '';
  };
  const labelsFor = (el) => {
    const labels = [];
    if (el.id) {
      document.querySelectorAll('label[for="' + cssEscape(el.id) + '"]').forEach((label) => labels.push(text(label.textContent)));
    }
    if (el.labels) Array.from(el.labels).forEach((label) => labels.push(text(label.textContent)));
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) labels.push(text(wrappingLabel.textContent));
    return [...new Set(labels.filter(Boolean))].slice(0, 3);
  };
  const selectorHint = (el) => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
    if (testId) return '[data-testid="' + testId + '"]';
    if (el.id) return '#' + cssEscape(el.id);
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
    return el.tagName.toLowerCase();
  };
  const controls = Array.from(document.querySelectorAll('input, textarea, select, button, a, [role], [data-testid], [data-test], [data-cy]'))
    .filter(visible)
    .slice(0, maxControls)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: inferredRole(el),
      text: text(el.innerText || el.textContent),
      label: labelsFor(el),
      aria_label: text(el.getAttribute('aria-label')),
      placeholder: text(el.getAttribute('placeholder')),
      name: text(el.getAttribute('name')),
      type: text(el.getAttribute('type')),
      id: text(el.id),
      data_testid: text(el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy')),
      selector_hint: selectorHint(el)
    }));
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .filter(visible)
    .slice(0, 20)
    .map((el) => text(el.innerText || el.textContent));
  const visible_text = Array.from(document.querySelectorAll('main, body'))
    .slice(0, 1)
    .map((el) => text(el.innerText || el.textContent, 1000))[0] || '';
  return {
    url: window.location.href,
    title: document.title,
    headings,
    controls,
    visible_text
  };
};

function targetUrl(baseUrl, route) {
  const value = String(route || '/');
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(baseUrl || '').replace(/\/+$/, '') + '/';
  return new URL(value.replace(/^\/+/, ''), base).href;
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const timeout = Number(payload.timeout_ms || 6000);
  const maxControls = Number(payload.max_controls || 80);
  const browserName = payload.browser || 'chromium';
  const browserType = playwright[browserName] || playwright.chromium;
  const byCaseId = {};

  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  for (const testCase of payload.cases || []) {
    const caseId = testCase.id || '';
    const route = testCase.route || '/';
    const page = await context.newPage();
    try {
      await page.goto(targetUrl(payload.base_url || '', route), { waitUntil: 'domcontentloaded', timeout });
      try {
        await page.waitForLoadState('networkidle', { timeout: 2000 });
      } catch {
        // Network-idle is only a best-effort stabilizer for SPAs.
      }
      byCaseId[caseId] = {
        available: true,
        route,
        snapshot: await page.evaluate(DOM_SNAPSHOT_JS, maxControls)
      };
    } catch (error) {
      byCaseId[caseId] = {
        available: false,
        route,
        error: String(error.message || error).slice(0, 500)
      };
    } finally {
      await page.close();
    }
  }
  await context.close();
  await browser.close();

  const output = {
    available: Object.values(byCaseId).some((item) => item.available),
    by_case_id: byCaseId
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
`;

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

export async function recordLlmUsage({
  root,
  runId = null,
  runDir = null,
  provider,
  model,
  purpose,
  usage,
  request = {}
}) {
  const normalized = normalizeLlmUsage(provider, usage);
  if (!normalized.total_tokens && !normalized.input_tokens && !normalized.output_tokens) return null;

  const estimate = estimateLlmCost(provider, model, normalized);
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: nowIso(),
    run_id: runId || null,
    provider: String(provider || '').toLowerCase(),
    model: String(model || ''),
    purpose: String(purpose || ''),
    usage: normalized,
    estimated_cost_usd: estimate.cost_usd,
    pricing: estimate.pricing,
    request: {
      max_output_tokens: request.max_output_tokens || null
    }
  };

  await fs.mkdir(usageRoot(root), { recursive: true });
  await fs.appendFile(globalUsageLogPath(root), `${JSON.stringify(entry)}\n`, 'utf8');

  const effectiveRunDir = runDir || (runId ? runPath(root, runId) : null);
  if (effectiveRunDir) {
    const runUsagePath = path.join(effectiveRunDir, LLM_USAGE_JSON);
    const current = await readJson(runUsagePath, { run_id: runId || path.basename(effectiveRunDir), entries: [] });
    const entries = Array.isArray(current.entries) ? current.entries : [];
    entries.push(entry);
    await writeJson(runUsagePath, {
      run_id: runId || path.basename(effectiveRunDir),
      updated_at: entry.timestamp,
      summary: summarizeUsageEntries(entries, { scope: 'run', runId: runId || path.basename(effectiveRunDir) }),
      entries
    });
    await appendEvent(effectiveRunDir, {
      run_id: runId || path.basename(effectiveRunDir),
      type: 'llm_usage_recorded',
      status: '',
      message: `Uso LLM registrado: ${formatUsageTokensForEvent(normalized)} tokens.`,
      payload: {
        provider: entry.provider,
        model: entry.model,
        purpose: entry.purpose,
        estimated_cost_usd: entry.estimated_cost_usd,
        usage: entry.usage
      }
    }).catch(() => {});
  }

  return entry;
}

export async function loadUsageSummary(root, { runId = null } = {}) {
  const entries = runId
    ? await loadRunUsageEntries(root, runId)
    : await loadGlobalUsageEntries(root);
  return summarizeUsageEntries(entries, {
    scope: runId ? 'run' : 'workspace',
    runId: runId || null
  });
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

async function runPlaywrightTests({ testsDir, runDir, plan, baseUrl, config, projectRoot, credentials }) {
  await fs.mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  const reportPath = path.join(runDir, 'playwright-report.json');
  const playwrightLogPath = path.join(runDir, 'playwright.log');
  const outputDir = path.join(runDir, 'artifacts', 'playwright');
  const configPath = path.join(runDir, 'playwright.config.cjs');
  const runnerConfig = {
    browser: config.runner.browser || 'chromium',
    video: config.runner.video || 'on',
    screenshots: config.runner.screenshots || 'on',
    traces: config.runner.traces || 'retain_on_failure'
  };
  await writePlaywrightConfig({ configPath, testsDir, outputDir, reportPath, runnerConfig });
  const command = playwrightCommand([
    'test',
    '--config',
    configPath,
    ...playwrightWorkerArgs(config)
  ]);
  const env = {
    ...runtimeEnv(),
    PROGUIDE_BASE_URL: baseUrl,
    PROGUIDE_RUN_DIR: runDir,
    PROGUIDE_BROWSER: runnerConfig.browser,
    PROGUIDE_VIDEO: normalizePlaywrightVideo(runnerConfig.video),
    PROGUIDE_SCREENSHOTS: normalizePlaywrightScreenshot(runnerConfig.screenshots),
    PROGUIDE_TRACES: normalizePlaywrightTrace(runnerConfig.traces)
  };
  if (credentials.email) env.PROGUIDE_USER_EMAIL = credentials.email;
  if (credentials.username) env.PROGUIDE_USER_USERNAME = credentials.username;
  if (credentials.password) env.PROGUIDE_USER_PASSWORD = credentials.password;

  await fs.writeFile(playwrightLogPath, `$ ${command.join(' ')}\n`, 'utf8');
  const completed = await runProcess(command, { cwd: projectRoot, env, logPath: playwrightLogPath });
  let results = await parsePlaywrightResults({ plan, reportPath, runDir });
  if (completed.code !== 0 && !(await exists(reportPath))) {
    const logText = await fs.readFile(playwrightLogPath, 'utf8').catch(() => '');
    const setupMessage = setupFailureMessage(completed.code, logText, relativePath(playwrightLogPath, projectRoot));
    results = plan.cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      status: 'setup_failed',
      duration_seconds: 0,
      message: setupMessage,
      error_details: logText.trim() || setupMessage,
      actual_response: null,
      steps: testCase.steps,
      expected: testCase.expected,
      api_evidence: [],
      videos: [],
      screenshots: [],
      traces: []
    }));
  }
  return {
    run_id: path.basename(runDir),
    base_url: baseUrl,
    started_at: startedAt,
    finished_at: nowIso(),
    results
  };
}

async function writePlaywrightConfig({ configPath, testsDir, outputDir, reportPath, runnerConfig }) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const configSource = [
    "const path = require('node:path');",
    '',
    'module.exports = {',
    `  testDir: ${JSON.stringify(testsDir)},`,
    `  outputDir: ${JSON.stringify(outputDir)},`,
    `  reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],`,
    '  fullyParallel: true,',
    '  use: {',
    `    baseURL: process.env.PROGUIDE_BASE_URL || ${JSON.stringify('')},`,
    `    browserName: process.env.PROGUIDE_BROWSER || ${JSON.stringify(runnerConfig.browser || 'chromium')},`,
    `    screenshot: process.env.PROGUIDE_SCREENSHOTS || ${JSON.stringify(normalizePlaywrightScreenshot(runnerConfig.screenshots))},`,
    `    video: process.env.PROGUIDE_VIDEO || ${JSON.stringify(normalizePlaywrightVideo(runnerConfig.video))},`,
    `    trace: process.env.PROGUIDE_TRACES || ${JSON.stringify(normalizePlaywrightTrace(runnerConfig.traces))}`,
    '  }',
    '};',
    ''
  ].join('\n');
  await fs.writeFile(configPath, configSource, 'utf8');
}


function runProcess(command, { cwd, env, logPath }) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', reject);
    child.stdout.on('data', (chunk) => fs.appendFile(logPath, chunk).catch(() => {}));
    child.stderr.on('data', (chunk) => fs.appendFile(logPath, chunk).catch(() => {}));
    child.on('close', (code) => resolve({ code: code ?? 0 }));
  });
}

export async function parsePlaywrightResults({ plan, reportPath, runDir }) {
  const caseById = new Map(plan.cases.map((testCase) => [String(testCase.id), testCase]));
  const caseBySafeId = new Map(plan.cases.map((testCase) => [safeId(testCase.id), testCase]));
  const parsed = new Map();
  if (await exists(reportPath)) {
    const report = await readJson(reportPath, null);
    for (const spec of collectPlaywrightSpecs(report)) {
      const testCase = caseFromPlaywrightSpec(spec, caseById, caseBySafeId);
      if (!testCase) continue;
      const normalized = normalizePlaywrightSpecResult(spec);
      parsed.set(testCase.id, {
        id: testCase.id,
        title: testCase.title,
        status: normalized.status,
        duration_seconds: normalized.duration_seconds,
        message: normalized.message,
        error_details: normalized.error_details,
        actual_response: normalized.actual_response,
        steps: normalized.steps.length ? normalized.steps : testCase.steps,
        expected: testCase.expected,
        api_evidence: await collectApiEvidence(runDir, testCase.id),
        videos: await artifactPaths(runDir, normalized.attachments, new Set(['.webm']), safeId(testCase.id)),
        screenshots: await artifactPaths(runDir, normalized.attachments, new Set(['.png']), safeId(testCase.id)),
        traces: await artifactPaths(runDir, normalized.attachments, new Set(['.zip']), safeId(testCase.id))
      });
    }
  }

  const results = [];
  for (const testCase of plan.cases) {
    results.push(parsed.get(testCase.id) || {
      id: testCase.id,
      title: testCase.title,
      status: 'inconclusive',
      duration_seconds: 0,
      message: 'No Playwright result was found for this case.',
      error_details: '',
      actual_response: null,
      steps: testCase.steps,
      expected: testCase.expected,
      api_evidence: await collectApiEvidence(runDir, testCase.id),
      videos: await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, new Set(['.webm']), safeId(testCase.id)),
      screenshots: await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, new Set(['.png']), safeId(testCase.id)),
      traces: await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, new Set(['.zip']), safeId(testCase.id))
    });
  }
  return results;
}

async function artifactPaths(runDir, attachments, suffixes, stem) {
  const direct = [];
  for (const attachment of attachments || []) {
    const filePath = attachment.path ? path.resolve(String(attachment.path)) : '';
    if (!filePath || !suffixes.has(path.extname(filePath).toLowerCase()) || !(await exists(filePath))) continue;
    direct.push(relativePath(filePath, runDir));
  }
  const collected = await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, suffixes, stem);
  return [...new Set([...direct, ...collected])].sort();
}

async function collectDomContext({ root, runDir, plan, baseUrl, config }) {
  const cases = (plan.cases || [])
    .filter((testCase) => !isApiPlanCase(testCase))
    .slice(0, positiveInteger(config.llm.dom_context_max_cases, 12));
  if (!cases.length) return { available: false, error: 'no_plan_cases', by_case_id: {} };

  const inputPath = path.join(runDir, 'dom_context_input.json');
  const outputPath = path.join(runDir, 'dom_context.json');
  const scriptPath = path.join(runDir, 'dom_context_probe.cjs');
  const logPath = path.join(runDir, 'dom_context.log');
  const payload = {
    base_url: baseUrl,
    browser: config.runner.browser || 'chromium',
    timeout_ms: positiveInteger(config.llm.dom_context_timeout_ms, 6000),
    max_controls: positiveInteger(config.llm.dom_context_max_controls, 80),
    cases: cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      route: testCase.route || '/'
    }))
  };

  await writeJson(inputPath, payload);
  await fs.writeFile(scriptPath, DOM_CONTEXT_PROBE_SCRIPT, 'utf8');
  await fs.writeFile(logPath, `$ ${process.execPath} ${scriptPath} ${inputPath} ${outputPath}\n`, 'utf8');

  try {
    const completed = await runProcess([process.execPath, scriptPath, inputPath, outputPath], {
      cwd: root,
      env: runtimeEnv(),
      logPath
    });
    if (completed.code !== 0 && !(await exists(outputPath))) {
      const logText = await fs.readFile(logPath, 'utf8').catch(() => '');
      return {
        available: false,
        error: firstUsefulLogLine(logText) || `dom context probe exited with code ${completed.code}`,
        by_case_id: {}
      };
    }
    const context = await readJson(outputPath, null);
    if (!context || !context.by_case_id) {
      return { available: false, error: 'dom context probe did not produce JSON', by_case_id: {} };
    }
    return context;
  } catch (error) {
    return { available: false, error: error.message || String(error), by_case_id: {} };
  }
}

async function generateTestsWithAgent({ root, plan, cases, outputDir, config, domContext = {}, usageContext = null }) {
  await fs.mkdir(outputDir, { recursive: true });
  await writePlaywrightRuntimeShim(outputDir);

  const apiCases = (plan.cases || []).filter(isApiPlanCase);
  const uiCases = (plan.cases || []).filter((testCase) => !isApiPlanCase(testCase));
  if (apiCases.length) {
    await fs.writeFile(path.join(outputDir, 'test_api_cases.spec.ts'), generateApiTestSpec(apiCases), 'utf8');
    if (usageContext?.runDir) {
      await appendEvent(usageContext.runDir, {
        run_id: usageContext.runId,
        type: 'code_generation_progress',
        status: 'generating',
        message: `Codigo REST generado sin LLM para ${apiCases.length} caso(s).`,
        payload: {
          cases: apiCases.map((testCase) => testCase.id)
        }
      });
    }
  }

  const batchSize = positiveInteger(config.llm.max_cases, 12);
  const batches = chunkArray(uiCases, batchSize);
  const usedPaths = new Set();
  if (apiCases.length) usedPaths.add('test_api_cases.spec.ts');
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchCases = batches[batchIndex];
    const payload = buildCodeGenerationPayload({
      planCases: batchCases,
      sourceCases: cases,
      domContext,
      batchIndex,
      batchCount: batches.length
    });
    const data = await callJsonModel(config, {
      root,
      system: PLAYWRIGHT_CODE_AGENT_PROMPT,
      payload,
      purpose: `generar codigo TypeScript Playwright (lote ${batchIndex + 1}/${batches.length})`,
      usageContext
    });
    const files = normalizeGeneratedFiles(data);
    if (!files.length) {
      throw new Error(`El agente no devolvio archivos TypeScript para ejecutar en el lote ${batchIndex + 1}.`);
    }
    for (const file of files) {
      const relative = targetGeneratedPath(file.path, batchIndex, batches.length, usedPaths);
      await fs.writeFile(path.join(outputDir, relative), String(file.content || ''), 'utf8');
    }
    if (usageContext?.runDir) {
      await appendEvent(usageContext.runDir, {
        run_id: usageContext.runId,
        type: 'code_generation_progress',
        status: 'generating',
        message: `Codigo generado para lote ${batchIndex + 1}/${batches.length}.`,
        payload: {
          batch_index: batchIndex + 1,
          batch_count: batches.length,
          cases: batchCases.map((testCase) => testCase.id)
        }
      });
    }
  }
  await validateGeneratedCode(outputDir, plan);
}

async function writePlaywrightRuntimeShim(outputDir) {
  const source = [
    "import { createRequire } from 'node:module';",
    `const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || ${JSON.stringify(proguideRequireAnchor())});`,
    "const runtime = req('@playwright/test');",
    'export const test = runtime.test;',
    'export const expect = runtime.expect;',
    'export default runtime;',
    ''
  ].join('\n');
  await fs.writeFile(path.join(outputDir, 'proguide-test-runtime.mjs'), source, 'utf8');
}

function buildCodeGenerationPayload({ planCases, sourceCases, domContext = {}, batchIndex, batchCount }) {
  const outputPath = batchCount > 1
    ? `test_markdown_cases_${String(batchIndex + 1).padStart(3, '0')}.spec.ts`
    : 'test_markdown_cases.spec.ts';
  return {
    project: {
      base_url_is_available_as_playwright_base_url: true,
      test_runner: '@playwright/test',
      browser_library: 'playwright-test-typescript',
      runtime_shim: './proguide-test-runtime.mjs',
      required_import: "import { test, expect } from './proguide-test-runtime.mjs';"
    },
    required_output: {
      files: [
        {
          path: outputPath,
          content: 'complete TypeScript Playwright spec'
        }
      ]
    },
    batch: {
      index: batchIndex + 1,
      total: batchCount
    },
    test_cases: planCases.map((testCase) => {
      const sourceCase = sourceCases.find((item) => item.id === testCase.id) || {};
      return {
        id: testCase.id,
        test_title_prefix: `[${testCase.id}]`,
        type: testCase.type || 'ui',
        title: testCase.title,
        description: testCase.description,
        route: testCase.route,
        request: testCase.request || null,
        assertions: testCase.assertions || [],
        priority: testCase.priority,
        steps: testCase.steps,
        expected: testCase.expected,
        original_steps: sourceCase.original_steps || [],
        expected_results: sourceCase.expected_results || [],
        preconditions: sourceCase.preconditions || [],
        data_used: sourceCase.data_used || [],
        data: sourceCase.data || testCase.data || {},
        dom_context: domContext.by_case_id?.[testCase.id] || {
          available: false,
          reason: domContext.error || 'dom_context_not_collected'
        }
      };
    })
  };
}

async function loadExistingTestPlan(runDir, cases, run) {
  const planPath = path.join(runDir, TEST_PLAN_JSON);
  const existing = await readJson(planPath, null);
  if (existing && Array.isArray(existing.cases)) {
    return existing;
  }
  return casesToTestPlan(cases, { sourceMd: SOURCE_MD, appName: run.app_name || 'ProGuide Markdown Cases' });
}

function extractCaseCode(moduleText, caseId) {
  const lines = moduleText.split(/\r?\n/);
  const testLineIndex = lines.findIndex((line) => {
    const text = String(line);
    return /\btest\s*\(/.test(text) &&
      (text.includes(`[${caseId}]`) || text.includes(JSON.stringify(`[${caseId}]`)) || text.includes(String(caseId)));
  });
  if (testLineIndex >= 0) {
    let blockEnd = lines.length;
    for (let index = testLineIndex + 1; index < lines.length; index += 1) {
      if (/^\s*test\s*\(/.test(lines[index])) {
        blockEnd = index;
        break;
      }
    }
    return lines.slice(testLineIndex, blockEnd).join('\n').trim();
  }
  return '';
}

function normalizeGeneratedFiles(data) {
  const files = Array.isArray(data.files) ? data.files : [];
  return files
    .map((file, index) => ({
      path: file.path || (index === 0 ? 'test_markdown_cases.spec.ts' : `test_generated_${index + 1}.spec.ts`),
      content: file.content || file.code || ''
    }))
    .filter((file) => String(file.content || '').trim());
}

function safeGeneratedPath(value) {
  const normalized = String(value || 'test_markdown_cases.spec.ts').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Ruta de codigo generada no permitida: ${value}`);
  }
  if (!/\.spec\.(?:ts|js)$/i.test(normalized)) {
    throw new Error(`El agente genero un archivo que no es spec TypeScript/JavaScript ejecutable por Playwright: ${normalized}`);
  }
  return normalized;
}

function targetGeneratedPath(value, batchIndex, batchCount, usedPaths) {
  let relative = safeGeneratedPath(value);
  if (batchCount > 1 && path.basename(relative) === 'test_markdown_cases.spec.ts') {
    relative = path.posix.join(path.posix.dirname(relative), `test_markdown_cases_${String(batchIndex + 1).padStart(3, '0')}.spec.ts`);
  }
  if (!usedPaths.has(relative)) {
    usedPaths.add(relative);
    return relative;
  }
  const parsed = path.posix.parse(relative);
  let suffix = 2;
  let candidate = path.posix.join(parsed.dir, `${parsed.name}_${suffix}${parsed.ext}`);
  while (usedPaths.has(candidate)) {
    suffix += 1;
    candidate = path.posix.join(parsed.dir, `${parsed.name}_${suffix}${parsed.ext}`);
  }
  usedPaths.add(candidate);
  return candidate;
}

async function validateGeneratedCode(outputDir, plan) {
  const specFiles = [];
  await walk(outputDir, async (filePath) => {
    if (/\.spec\.(?:ts|js)$/i.test(path.basename(filePath))) {
      specFiles.push(filePath);
    }
  });
  if (!specFiles.length) {
    throw new Error('No se genero ningun archivo de test TypeScript.');
  }
  const combined = (await Promise.all(specFiles.map((filePath) => fs.readFile(filePath, 'utf8')))).join('\n');
  if (!combined.includes("from './proguide-test-runtime.mjs'") && !combined.includes('from "./proguide-test-runtime.mjs"')) {
    throw new Error('El codigo generado no importa el runtime shim de ProGuide.');
  }
  for (const testCase of plan.cases) {
    if (!combined.includes(`[${testCase.id}]`)) {
      throw new Error(`El codigo generado no incluye el prefijo de test [${testCase.id}].`);
    }
  }
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

async function callJsonModel(config, { root, system, payload, purpose, usageContext = null }) {
  await loadDotEnv(root);
  const provider = String(config.llm.provider || 'disabled').toLowerCase();
  const configPath = path.join(root, PROGUIDE_DIR, 'config.yaml');
  const maxOutputTokens = positiveInteger(config.llm.max_output_tokens, 8000);
  if (provider === 'disabled') {
    throw new Error(`El agente LLM esta deshabilitado; no se puede ${purpose}. Root efectivo: ${root}. Provider: ${provider}. Config: ${configPath}.`);
  }
  if (provider === 'anthropic') {
    const apiKey = anthropicApiKey();
    if (!apiKey.value) throw new Error(`Falta ANTHROPIC_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY para ${purpose}. Root efectivo: ${root}. Provider: ${provider}. Config: ${configPath}.`);
    const client = new Anthropic({ apiKey: apiKey.value });
    let data;
    try {
      data = await client.messages.create({
        model: config.llm.model,
        max_tokens: maxOutputTokens,
        temperature: Number(config.llm.temperature ?? 0.2),
        system,
        messages: [
          { role: 'user', content: JSON.stringify(payload) }
        ]
      });
    } catch (error) {
      throw new Error(`Anthropic fallo al ${purpose}${anthropicErrorDetails(error)}`);
    }
    await recordLlmUsage({
      root,
      runId: usageContext?.runId || null,
      runDir: usageContext?.runDir || null,
      provider,
      model: config.llm.model,
      purpose,
      usage: data.usage,
      request: { max_output_tokens: maxOutputTokens }
    }).catch(() => {});
    const text = (data.content || [])
      .map((block) => block.type === 'text' ? block.text : '')
      .join('\n');
    if (data.stop_reason === 'max_tokens') {
      throw new Error(`Anthropic trunco la respuesta al ${purpose}. max_tokens=${maxOutputTokens}. Sube llm.max_output_tokens o baja llm.max_cases en ${configPath}.`);
    }
    return extractJson(text, { purpose, provider, maxOutputTokens, configPath });
  }
  throw new Error(`Proveedor LLM no soportado: ${provider}. ProGuide solo soporta anthropic. Root efectivo: ${root}. Config: ${configPath}.`);
}

function anthropicErrorDetails(error) {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ? ` (${error.status})` : '';
    const message = error.message || error.name || 'sin detalle';
    return `${status}: ${message}`;
  }
  return `: ${error?.message || String(error)}`;
}

function anthropicApiKey() {
  const names = ['ANTHROPIC_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY'];
  const name = names.find((item) => process.env[item]);
  return { name: name || names[0], value: name ? process.env[name] : '' };
}

function extractJson(content, context = {}) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        // Fall through to the contextual error below.
      }
    }
    const details = context.purpose
      ? ` al ${context.purpose}. Provider: ${context.provider}. max_tokens=${context.maxOutputTokens}. Config: ${context.configPath}.`
      : '.';
    throw new Error(`El agente no devolvio JSON valido${details} ${error.message}`);
  }
}

async function writeEvidenceReport({ summary, run, cases, runDir }) {
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const rows = summary.results.map((result) => {
    const testCase = caseById.get(result.id) || {};
    const errorDetails = result.error_details
      ? `<details class="error-console"><summary>Error Playwright completo</summary><pre>${escapeHtml(result.error_details)}</pre></details>`
      : '';
    const actualResponse = result.actual_response
      ? `<details class="error-console"><summary>Actual response</summary><pre>${escapeHtml(JSON.stringify(result.actual_response, null, 2))}</pre></details>`
      : '';
    const apiEvidence = (result.api_evidence || []).length
      ? `<details class="error-console"><summary>API evidence</summary><pre>${escapeHtml(JSON.stringify(result.api_evidence, null, 2))}</pre></details>`
      : '';
    return `<tr>
      <td>${escapeHtml(testCase.number || '')}</td>
      <td>${escapeHtml(result.title)}</td>
      <td>${escapeHtml(result.status)}</td>
      <td>${escapeHtml(result.message || '')}${apiEvidence}${actualResponse}${errorDetails}</td>
    </tr>`;
  }).join('');
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(run.title || run.ticket || 'Evidencia QA')}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 32px; line-height: 1.45; }
    h1 { margin: 0 0 8px; }
    .muted { color: #64748b; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; color: #475569; font-size: 12px; text-transform: uppercase; }
    .error-console { margin-top: 10px; }
    .error-console summary { cursor: pointer; color: #991b1b; font-weight: 700; }
    .error-console pre { white-space: pre-wrap; overflow-x: auto; background: #111827; color: #f8fafc; border-radius: 6px; padding: 12px; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <h1>${escapeHtml(run.title || run.ticket || 'Evidencia QA')}</h1>
  <p class="muted">${escapeHtml(summary.base_url || '')}</p>
  <p><strong>Run:</strong> ${escapeHtml(run.id)} | <strong>Estado:</strong> ${escapeHtml(run.status)}</p>
  <table>
    <thead><tr><th>N</th><th>Caso</th><th>Estado</th><th>Mensaje</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
  const htmlPath = path.join(runDir, 'evidence.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
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

async function loadGlobalUsageEntries(root) {
  const logPath = globalUsageLogPath(root);
  if (!(await exists(logPath))) return [];
  const text = await fs.readFile(logPath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return normalizeStoredUsageEntry(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

async function loadRunUsageEntries(root, runId) {
  const runDir = runPath(root, runId);
  const payload = await readJson(path.join(runDir, LLM_USAGE_JSON), null);
  if (payload && Array.isArray(payload.entries)) {
    return payload.entries
      .map(normalizeStoredUsageEntry)
      .filter(Boolean)
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  }
  const entries = await loadGlobalUsageEntries(root);
  return entries.filter((entry) => entry.run_id === runId);
}

function normalizeStoredUsageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const provider = String(entry.provider || '').toLowerCase();
  return {
    id: String(entry.id || `${entry.timestamp || nowIso()}_${provider || 'llm'}`),
    timestamp: entry.timestamp || '',
    run_id: entry.run_id || null,
    provider,
    model: String(entry.model || ''),
    purpose: String(entry.purpose || ''),
    usage: normalizeLlmUsage(provider, entry.usage || {}),
    estimated_cost_usd: finiteOrNull(entry.estimated_cost_usd),
    pricing: entry.pricing || { source: 'unknown', note: 'Sin informacion de precios.' },
    request: entry.request || {}
  };
}

function summarizeUsageEntries(entries, { scope = 'workspace', runId = null } = {}) {
  const normalizedEntries = (entries || []).map(normalizeStoredUsageEntry).filter(Boolean);
  const totals = usageTotals(normalizedEntries);
  return {
    scope,
    run_id: runId || null,
    generated_at: nowIso(),
    entries_count: normalizedEntries.length,
    ...totals,
    unknown_cost_entries: normalizedEntries.filter((entry) => entry.estimated_cost_usd === null).length,
    by_provider: groupUsage(normalizedEntries, (entry) => entry.provider || 'unknown'),
    by_model: groupUsage(normalizedEntries, (entry) => entry.model || 'unknown'),
    by_run: groupUsage(normalizedEntries, (entry) => entry.run_id || 'sin_run'),
    entries: normalizedEntries.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))),
    pricing_note: 'Costos estimados con tokens reportados por la API. La factura final puede diferir por descuentos, impuestos, tiers o cambios de proveedor.'
  };
}

function usageTotals(entries) {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0
  };
  let hasKnownCost = false;
  for (const entry of entries || []) {
    const usage = entry.usage || {};
    totals.input_tokens += safeNumber(usage.input_tokens);
    totals.output_tokens += safeNumber(usage.output_tokens);
    totals.cache_creation_input_tokens += safeNumber(usage.cache_creation_input_tokens);
    totals.cache_creation_5m_input_tokens += safeNumber(usage.cache_creation_5m_input_tokens);
    totals.cache_creation_1h_input_tokens += safeNumber(usage.cache_creation_1h_input_tokens);
    totals.cache_read_input_tokens += safeNumber(usage.cache_read_input_tokens);
    totals.total_tokens += safeNumber(usage.total_tokens);
    if (entry.estimated_cost_usd !== null && Number.isFinite(Number(entry.estimated_cost_usd))) {
      hasKnownCost = true;
      totals.estimated_cost_usd += Number(entry.estimated_cost_usd);
    }
  }
  totals.estimated_cost_usd = hasKnownCost ? roundMoney(totals.estimated_cost_usd) : null;
  return totals;
}

function groupUsage(entries, keyFn) {
  const groups = new Map();
  for (const entry of entries || []) {
    const key = String(keyFn(entry) || 'unknown');
    const current = groups.get(key) || { key, entries: [] };
    current.entries.push(entry);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      entries_count: group.entries.length,
      last_at: group.entries.map((entry) => entry.timestamp || '').sort().at(-1) || '',
      ...usageTotals(group.entries)
    }))
    .sort((a, b) => {
      const costA = a.estimated_cost_usd ?? -1;
      const costB = b.estimated_cost_usd ?? -1;
      if (costA !== costB) return costB - costA;
      return String(b.last_at || '').localeCompare(String(a.last_at || ''));
    });
}

function formatUsageTokensForEvent(usage) {
  return String(safeNumber(usage.total_tokens));
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function ensureLayout(root) {
  await fs.mkdir(path.join(root, PROGUIDE_DIR, RUNS_DIR), { recursive: true });
  await fs.mkdir(usageRoot(root), { recursive: true });
}

function usageRoot(root) {
  return path.join(root, PROGUIDE_DIR, USAGE_DIR);
}

function globalUsageLogPath(root) {
  return path.join(usageRoot(root), LLM_USAGE_JSONL);
}

function runsRoot(root) {
  return path.join(root, PROGUIDE_DIR, RUNS_DIR);
}

function runPath(root, runId) {
  return path.join(runsRoot(root), runId);
}

async function newRunDir(root) {
  const runsDir = runsRoot(root);
  await fs.mkdir(runsDir, { recursive: true });
  const baseId = makeRunId();
  let candidate = path.join(runsDir, baseId);
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = path.join(runsDir, `${baseId}_${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function makeRunId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

async function loadRunRecord(runDir) {
  return readJson(path.join(runDir, RUN_JSON));
}

async function legacyRunRecord(runDir, runId, error) {
  let createdAt = '';
  try {
    createdAt = (await fs.stat(runDir)).mtime.toISOString();
  } catch {
    createdAt = nowIso();
  }
  return {
    id: runId,
    created_at: createdAt,
    started_at: null,
    finished_at: null,
    status: 'unknown',
    mode: 'url',
    base_url: '',
    source_filename: '',
    app_name: null,
    project_name: null,
    project_key: null,
    run_user_email: null,
    run_user_name: null,
    company_domain: null,
    workspace_root: null,
    run_source: null,
    git_branch: null,
    git_commit: null,
    identity_source: {},
    ticket: null,
    module: null,
    title: null,
    qa_owner: null,
    dev_owner: null,
    total_cases: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    inconclusive: 0,
    setup_failed: 0,
    pdf_path: null,
    html_path: null,
    data_dir: runDir,
    load_error: error?.message || String(error || 'run.json no disponible'),
    recovery_hint: 'El directorio existe pero no tiene run.json valido. Re-crea el run o conserva el directorio solo como evidencia legacy.'
  };
}

async function saveRun(runDir, run) {
  await fs.mkdir(runDir, { recursive: true });
  await writeJson(path.join(runDir, RUN_JSON), run);
}

async function saveCasesFile(runDir, cases) {
  await writeJson(path.join(runDir, NORMALIZED_CASES_JSON), cases);
}

async function loadSummary(runDir) {
  const resultsPath = path.join(runDir, RESULTS_JSON);
  if (await exists(resultsPath)) return readJson(resultsPath);
  const summaryPath = path.join(runDir, 'summary.json');
  if (await exists(summaryPath)) return readJson(summaryPath);
  return null;
}

async function loadEvents(runDir) {
  const eventsPath = path.join(runDir, EVENTS_JSONL);
  if (!(await exists(eventsPath))) return [];
  const text = await fs.readFile(eventsPath, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function appendEvent(runDir, event) {
  const payload = {
    run_id: event.run_id || path.basename(runDir),
    type: event.type,
    status: event.status || '',
    message: event.message || '',
    timestamp: event.timestamp || nowIso(),
    case_id: event.case_id || null,
    step_id: event.step_id || null,
    payload: event.payload || {}
  };
  await fs.mkdir(runDir, { recursive: true });
  await fs.appendFile(path.join(runDir, EVENTS_JSONL), `${JSON.stringify(payload)}\n`, 'utf8');
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (arguments.length >= 2) return fallback;
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadLoggedSteps(runDir, caseId) {
  const stepPath = path.join(runDir, 'step_logs', `${safeId(caseId)}.json`);
  if (!(await exists(stepPath))) return [];
  const payload = await readJson(stepPath, {});
  return (payload.steps || []).map((entry) => `${entry.status}: ${entry.step}`);
}

async function collectArtifacts(directory, relativeTo, suffixes, stem = null) {
  if (!(await exists(directory))) return [];
  const files = [];
  await walk(directory, async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const safeStem = safeId(path.parse(filePath).name);
    const safeRelative = safeId(relativePath(filePath, relativeTo));
    if (suffixes.has(ext) && (!stem || safeStem.startsWith(stem) || safeRelative.includes(stem))) {
      files.push(relativePath(filePath, relativeTo));
    }
  });
  return files.sort();
}

async function collectApiEvidence(runDir, caseId) {
  const directory = path.join(runDir, 'api_evidence', safeId(caseId));
  if (!(await exists(directory))) return [];
  const entries = [];
  await walk(directory, async (filePath) => {
    if (path.extname(filePath).toLowerCase() !== '.json') return;
    const payload = await readJson(filePath, null);
    if (!payload) return;
    entries.push({
      ...payload,
      path: relativePath(filePath, runDir)
    });
  });
  return entries.sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0) ||
    String(a.path || '').localeCompare(String(b.path || '')));
}

async function walk(directory, onFile) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath, onFile);
    if (entry.isFile()) await onFile(fullPath);
  }
}

function countSummary(summary) {
  const counts = { passed: 0, failed: 0, inconclusive: 0, setup_failed: 0 };
  for (const result of summary.results || []) {
    if (result.status === 'passed') counts.passed += 1;
    else if (result.status === 'failed') counts.failed += 1;
    else if (result.status === 'setup_failed') counts.setup_failed += 1;
    else counts.inconclusive += 1;
  }
  return counts;
}

function statusFromSummary(counts, blocked) {
  if (counts.setup_failed) return 'setup_failed';
  if (counts.failed) return 'failed';
  if (counts.inconclusive) return 'inconclusive';
  if (blocked && !counts.passed) return 'blocked';
  if (blocked && counts.passed) return 'finished';
  if (counts.passed && !counts.failed && !counts.inconclusive) return 'passed';
  return 'finished';
}

function setupFailureMessage(exitCode, logText, relativeLogPath) {
  const firstUseful = firstUsefulLogLine(logText);
  const reason = firstUseful || `playwright test exited with code ${exitCode}`;
  return `setup_failed: ${reason}. See ${relativeLogPath}. Run proguide doctor --fix.`;
}

function firstUsefulLogLine(logText) {
  return String(logText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /Cannot find module|Error|Traceback|Target page|Timeout|ERR_|playwright/i.test(line)) || '';
}

function chunkArray(items, size) {
  const chunks = [];
  const chunkSize = Math.max(1, size);
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function relativePath(filePath, base) {
  return path.relative(base, filePath).split(path.sep).join('/');
}

