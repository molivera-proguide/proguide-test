import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

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

const ANTHROPIC_PRICING_SOURCE = 'https://docs.anthropic.com/en/docs/about-claude/pricing';
const ANTHROPIC_PRICING_BY_FAMILY = {
  sonnet: {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_write_5m_per_mtok: 3.75,
    cache_write_1h_per_mtok: 6,
    cache_read_per_mtok: 0.30
  },
  opus: {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_write_5m_per_mtok: 6.25,
    cache_write_1h_per_mtok: 10,
    cache_read_per_mtok: 0.50
  },
  haiku: {
    input_per_mtok: 1,
    output_per_mtok: 5,
    cache_write_5m_per_mtok: 1.25,
    cache_write_1h_per_mtok: 2,
    cache_read_per_mtok: 0.10
  }
};

const FIELD_ALIASES = {
  titulo: 'title',
  title: 'title',
  descripcion: 'description',
  description: 'description',
  prioridad: 'priority',
  priority: 'priority',
  criticidad: 'priority',
  criticality: 'priority',
  severidad: 'priority',
  severity: 'priority',
  precondicion: 'preconditions',
  precondiciones: 'preconditions',
  precondition: 'preconditions',
  preconditions: 'preconditions',
  datos: 'data_used',
  'datos utilizados': 'data_used',
  data: 'data_used',
  'test data': 'data_used',
  pasos: 'original_steps',
  acciones: 'original_steps',
  steps: 'original_steps',
  'resultado esperado': 'expected_results',
  'resultados esperados': 'expected_results',
  esperado: 'expected_results',
  esperados: 'expected_results',
  expected: 'expected_results',
  'expected result': 'expected_results',
  'expected results': 'expected_results',
  tags: 'tags',
  etiquetas: 'tags',
  qa: 'qa_owner',
  responsable: 'qa_owner',
  resp: 'qa_owner',
  'qa responsable': 'qa_owner',
  desarrollo: 'dev_owner',
  desa: 'dev_owner',
  dev: 'dev_owner',
  ticket: 'ticket',
  requerimiento: 'ticket',
  ruta: 'route',
  route: 'route',
  url: 'route'
};

const GENERIC_EXPECTED_RE = /\b(correcto|correctamente|funciona|ok|exitoso|exitosamente|segun corresponda|adecuado)\b/i;
const NOT_AUTOMATABLE_RE = /\b(captcha|2fa|otp|token fisico|sms|llamada|telefono|fuera del navegador|manual|base de datos|db|api externa|correo fisico|impresion)\b/i;
const REVIEW_STEP_RE = /\b(validar que corresponda|segun criterio|revisar visualmente|comprobar manualmente|buscar el expediente|ubicar el expediente|datos de ambiente|consultar con)\b/i;
const BULLET_CHARS = '\u2022\u25e6\u2043\u2219\u00b7\u2014\u2013\ufffd';
const NAVIGATION_RE = /\b(ir|abrir|navegar|visitar|acceder|entrar|dirigirse|volver)\b/i;

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
Generate production-ready Python pytest + Playwright code from already-approved QA test cases.

Rules:
- Do not create, remove, merge, split, or rename test cases.
- Generate one pytest function per input test case.
- Each function name must be exactly the provided function_name.
- Each test must include @pytest.mark.proguide_case("<case id>").
- Use the existing fixtures: page, proguide_base_url, proguide_steps.
- Use Python Playwright sync API style.
- Use proguide_steps.set_case(case_id, title) at the start of each test.
- Use proguide_steps.log(step, "started"|"passed"|"failed", message) around meaningful actions/assertions.
- Use robust locators: get_by_role, get_by_label, get_by_placeholder, get_by_text, locator with semantic attributes.
- When dom_context is available, prefer its real roles, labels, placeholders, text, data-testid, id, and name attributes over guessed selectors.
- Treat normalized steps as authoritative DSL:
  - fill [selector] with value -> page.locator(selector).fill(value)
  - click [selector] -> page.locator(selector).click()
  - expect [selector] to contain text "value" -> assert that exact text
  - expect [selector] to be visible -> assert visibility
  - expect text "value" -> assert visible text containing value
- Do not use PROGUIDE_USER_* environment credentials when the step contains a literal email, username, password, or value.
- Use credentials from environment variables PROGUIDE_USER_EMAIL, PROGUIDE_USER_USERNAME, PROGUIDE_USER_PASSWORD when needed.
- If a test case includes data.user.email or data.user.password, prefer those per-case values for inputs over global defaults.
- Exact strings in expected and expected_results override shorter or older strings in original_steps.
- Never invent data-testid/id selectors. Use only selectors present in normalized steps or dom_context.snapshot.controls[].selector_hint. If no selector exists, assert real headings or visible text from dom_context instead.
- Prefer data-testid/id selector_hint over placeholder locators when the placeholder is empty, generic, or rendered as bullets/symbols.
- Keep assertions explicit with playwright.sync_api.expect.
- Include imports and any helper functions in the generated file.
- Return only valid JSON with this shape:
  {"files":[{"path":"test_markdown_cases.py","content":"...python code..."}]}
- Do not include markdown fences.`;

const DOM_CONTEXT_PROBE_SCRIPT = String.raw`
from __future__ import annotations

import json
import sys
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright


DOM_SNAPSHOT_JS = r"""
(maxControls) => {
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
}
"""


def target_url(base_url: str, route: str) -> str:
    if route.startswith("http://") or route.startswith("https://"):
        return route
    return urljoin(base_url.rstrip("/") + "/", route.lstrip("/") or "")


def main() -> int:
    input_path, output_path = sys.argv[1], sys.argv[2]
    payload = json.loads(open(input_path, encoding="utf-8").read())
    timeout = int(payload.get("timeout_ms") or 6000)
    max_controls = int(payload.get("max_controls") or 80)
    browser_name = payload.get("browser") or "chromium"
    by_case_id = {}

    with sync_playwright() as playwright:
      browser_type = getattr(playwright, browser_name, playwright.chromium)
      browser = browser_type.launch(headless=True)
      context = browser.new_context()
      for case in payload.get("cases", []):
        case_id = case.get("id") or ""
        route = case.get("route") or "/"
        page = context.new_page()
        try:
          page.goto(target_url(payload.get("base_url") or "", route), wait_until="domcontentloaded", timeout=timeout)
          try:
            page.wait_for_load_state("networkidle", timeout=2000)
          except Exception:
            pass
          by_case_id[case_id] = {
            "available": True,
            "route": route,
            "snapshot": page.evaluate(DOM_SNAPSHOT_JS, max_controls),
          }
        except Exception as exc:
          by_case_id[case_id] = {
            "available": False,
            "route": route,
            "error": str(exc)[:500],
          }
        finally:
          page.close()
      context.close()
      browser.close()

    output = {
      "available": any(item.get("available") for item in by_case_id.values()),
      "by_case_id": by_case_id,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
      handle.write(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
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
    if (found || path.extname(filePath).toLowerCase() !== '.py') return;
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
  const runDir = await newRunDir(root);
  const run = {
    id: path.basename(runDir),
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    status: 'interpreting',
    mode: 'url',
    base_url: String(baseUrl || '').replace(/\/+$/, ''),
    source_filename: path.basename(sourceMd),
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
  const markdown = await readMarkdownText(sourceMd);
  await fs.writeFile(path.join(runDir, SOURCE_MD), maskSecretText(markdown), 'utf8');
  await appendEvent(runDir, { run_id: run.id, type: 'file_received', message: `Archivo recibido: ${path.basename(sourceMd)}` });

  let cases;
  try {
    cases = useAgent
      ? await interpretMarkdownWithAgent(markdown, {
        root,
        sourceName: path.basename(sourceMd),
        usageContext: { runId: run.id, runDir }
      })
      : parseMarkdownCases(markdown, { sourceName: path.basename(sourceMd) });
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

  const normalizedCases = cases.map((item, index) => normalizeCaseForStorage(item, index + 1));
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
  const markdown = await readMarkdownText(sourceMd);
  const cases = useAgent
    ? await interpretMarkdownWithAgent(markdown, { root, sourceName: path.basename(sourceMd) })
    : parseMarkdownCases(markdown, { sourceName: path.basename(sourceMd) });
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

export async function executePreparedRun({ root, runId, baseUrl, credentials = {}, python = 'python', fromPlan = false }) {
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
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'dom_context_started',
      status: run.status,
      message: 'Abriendo browser para leer contexto visible de la app.'
    });
    const domContext = await collectDomContext({
      python,
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
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'code_generation_started',
      status: run.status,
      message: 'Agente generando codigo Python Playwright.'
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
    await appendEvent(runDir, { run_id: run.id, type: 'tests_generated', status: 'running', message: 'Codigo Python Playwright generado.' });

    run.status = 'running';
    await saveRun(runDir, run);
    await appendEvent(runDir, {
      run_id: run.id,
      type: 'run_started',
      status: run.status,
      message: 'Ejecucion iniciada en pytest.',
      payload: { parallel_workers: config.runner.parallel_workers || 'auto' }
    });

    summary = await runPytest({
      python,
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

async function runPytest({ python, testsDir, runDir, plan, baseUrl, config, projectRoot, credentials }) {
  await fs.mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  const junitPath = path.join(runDir, 'junit.xml');
  const pytestLogPath = path.join(runDir, 'pytest.log');
  const command = [
    python,
    '-m',
    'pytest',
    testsDir,
    '--junitxml',
    junitPath,
    ...pytestWorkerArgs(config)
  ];
  const runnerConfig = {
    browser: config.runner.browser || 'chromium',
    video: config.runner.video || 'on',
    screenshots: config.runner.screenshots === 'on_failure' ? 'on' : (config.runner.screenshots || 'on'),
    traces: config.runner.traces || 'retain_on_failure'
  };
  const env = {
    ...process.env,
    PROGUIDE_BASE_URL: baseUrl,
    PROGUIDE_RUN_DIR: runDir,
    PROGUIDE_BROWSER: runnerConfig.browser,
    PROGUIDE_VIDEO: runnerConfig.video,
    PROGUIDE_SCREENSHOTS: runnerConfig.screenshots,
    PROGUIDE_TRACES: runnerConfig.traces,
    PYTHONPATH: pythonPathForRunner(projectRoot)
  };
  if (credentials.email) env.PROGUIDE_USER_EMAIL = credentials.email;
  if (credentials.username) env.PROGUIDE_USER_USERNAME = credentials.username;
  if (credentials.password) env.PROGUIDE_USER_PASSWORD = credentials.password;

  await fs.writeFile(pytestLogPath, `$ ${command.join(' ')}\n`, 'utf8');
  const completed = await runProcess(command, { cwd: projectRoot, env, logPath: pytestLogPath });
  let results = await parsePytestResults({ plan, junitPath, runDir });
  if (completed.code !== 0 && !(await exists(junitPath))) {
    const logText = await fs.readFile(pytestLogPath, 'utf8').catch(() => '');
    const setupMessage = setupFailureMessage(completed.code, logText, relativePath(pytestLogPath, projectRoot));
    results = plan.cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      status: 'setup_failed',
      duration_seconds: 0,
      message: setupMessage,
      steps: testCase.steps,
      expected: testCase.expected,
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

export function pytestWorkerArgs(config = {}) {
  const rawWorkers = config?.runner?.parallel_workers ?? 'auto';
  const workers = String(rawWorkers ?? '').trim().toLowerCase();
  if (!workers || ['1', '0', 'false', 'off', 'none'].includes(workers)) return [];
  if (workers === 'auto') return ['-n', 'auto'];

  const count = Number(rawWorkers);
  if (Number.isInteger(count) && count > 1) return ['-n', String(count)];

  throw new Error(`runner.parallel_workers invalido: ${rawWorkers}. Usa "auto", 1 o un entero mayor que 1.`);
}

function pythonPathForRunner(projectRoot) {
  return [
    packagedPythonRoot(),
    projectRoot,
    process.env.PYTHONPATH || ''
  ].filter(Boolean).join(path.delimiter);
}

function packagedPythonRoot() {
  return path.join(__dirname, 'python');
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

export async function parsePytestResults({ plan, junitPath, runDir }) {
  const caseBySafeId = new Map(plan.cases.map((testCase) => [safeId(testCase.id), testCase]));
  const parsed = new Map();
  if (await exists(junitPath)) {
    const xml = await fs.readFile(junitPath, 'utf8');
    const testcaseRe = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*?)>([\s\S]*?)<\/testcase>/g;
    let match;
    while ((match = testcaseRe.exec(xml))) {
      const attrs = parseXmlAttrs(match[1] || match[2] || '');
      const inner = match[3] || '';
      const safeCaseId = safeId(String(attrs.name || '').replace(/^test_/, ''));
      const testCase = caseBySafeId.get(safeCaseId);
      if (!testCase) continue;
      let status = 'passed';
      let message = '';
      const failure = inner.match(/<failure\b([^>]*)>([\s\S]*?)<\/failure>/);
      const error = inner.match(/<error\b([^>]*)>([\s\S]*?)<\/error>/);
      const skipped = inner.match(/<skipped\b([^>]*)>([\s\S]*?)<\/skipped>/);
      if (failure) {
        status = 'failed';
        message = parseXmlAttrs(failure[1]).message || stripXml(failure[2]);
      } else if (error) {
        status = 'inconclusive';
        message = parseXmlAttrs(error[1]).message || stripXml(error[2]);
      } else if (skipped) {
        status = 'inconclusive';
        message = parseXmlAttrs(skipped[1]).message || 'Skipped';
      }
      parsed.set(testCase.id, {
        id: testCase.id,
        title: testCase.title,
        status,
        duration_seconds: Number(attrs.time || 0) || 0,
        message: decodeXml(message),
        steps: await loadLoggedSteps(runDir, testCase.id) || testCase.steps,
        expected: testCase.expected,
        videos: await collectArtifacts(path.join(runDir, 'videos', safeId(testCase.id)), runDir, new Set(['.webm'])),
        screenshots: await collectArtifacts(path.join(runDir, 'screenshots'), runDir, new Set(['.png']), safeId(testCase.id)),
        traces: await collectArtifacts(path.join(runDir, 'traces'), runDir, new Set(['.zip']), safeId(testCase.id))
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
      message: 'No pytest result was found for this case.',
      steps: testCase.steps,
      expected: testCase.expected,
      videos: await collectArtifacts(path.join(runDir, 'videos', safeId(testCase.id)), runDir, new Set(['.webm'])),
      screenshots: await collectArtifacts(path.join(runDir, 'screenshots'), runDir, new Set(['.png']), safeId(testCase.id)),
      traces: await collectArtifacts(path.join(runDir, 'traces'), runDir, new Set(['.zip']), safeId(testCase.id))
    });
  }
  return results;
}

async function collectDomContext({ python, root, runDir, plan, baseUrl, config }) {
  const cases = (plan.cases || []).slice(0, positiveInteger(config.llm.dom_context_max_cases, 12));
  if (!cases.length) return { available: false, error: 'no_plan_cases', by_case_id: {} };

  const inputPath = path.join(runDir, 'dom_context_input.json');
  const outputPath = path.join(runDir, 'dom_context.json');
  const scriptPath = path.join(runDir, 'dom_context_probe.py');
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
  await fs.writeFile(logPath, `$ ${python} ${scriptPath} ${inputPath} ${outputPath}\n`, 'utf8');

  try {
    const completed = await runProcess([python, scriptPath, inputPath, outputPath], {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: pythonPathForRunner(root)
      },
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
  await fs.writeFile(path.join(outputDir, 'conftest.py'), 'pytest_plugins = ["proguide.pytest_plugin"]\n', 'utf8');

  const batchSize = positiveInteger(config.llm.max_cases, 12);
  const batches = chunkArray(plan.cases, batchSize);
  const usedPaths = new Set();
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
      purpose: `generar codigo Python Playwright (lote ${batchIndex + 1}/${batches.length})`,
      usageContext
    });
    const files = normalizeGeneratedFiles(data);
    if (!files.length) {
      throw new Error(`El agente no devolvio archivos Python para ejecutar en el lote ${batchIndex + 1}.`);
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

function buildCodeGenerationPayload({ planCases, sourceCases, domContext = {}, batchIndex, batchCount }) {
  const outputPath = batchCount > 1
    ? `test_markdown_cases_${String(batchIndex + 1).padStart(3, '0')}.py`
    : 'test_markdown_cases.py';
  return {
    project: {
      base_url_is_available_as_fixture: 'proguide_base_url',
      test_runner: 'pytest',
      browser_library: 'python-playwright-sync',
      evidence_fixture: 'proguide_steps'
    },
    required_output: {
      files: [
        {
          path: outputPath,
          content: 'complete python source'
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
        function_name: `test_${safeId(testCase.id)}`,
        title: testCase.title,
        description: testCase.description,
        route: testCase.route,
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
  const start = lines.findIndex((line) => {
    if (!line.includes('@pytest.mark.proguide_case')) return false;
    return line.includes(JSON.stringify(caseId)) || line.includes(`'${String(caseId).replace(/'/g, "\\'")}'`);
  });
  if (start >= 0) {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index].startsWith('@pytest.mark.proguide_case')) {
        end = index;
        break;
      }
    }
    return lines.slice(start, end).join('\n').trim();
  }

  const functionName = `test_${safeId(caseId)}`;
  const defIndex = lines.findIndex((line) => line.startsWith(`def ${functionName}(`));
  if (defIndex < 0) return '';
  let blockStart = defIndex;
  while (blockStart > 0 && lines[blockStart - 1].startsWith('@')) {
    blockStart -= 1;
  }
  let blockEnd = lines.length;
  for (let index = defIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('@pytest.mark.proguide_case') || lines[index].startsWith('def test_')) {
      blockEnd = index;
      break;
    }
  }
  return lines.slice(blockStart, blockEnd).join('\n').trim();
}

function normalizeGeneratedFiles(data) {
  const files = Array.isArray(data.files) ? data.files : [];
  return files
    .map((file, index) => ({
      path: file.path || (index === 0 ? 'test_markdown_cases.py' : `test_generated_${index + 1}.py`),
      content: file.content || file.code || ''
    }))
    .filter((file) => String(file.content || '').trim());
}

function safeGeneratedPath(value) {
  const normalized = String(value || 'test_markdown_cases.py').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Ruta de codigo generada no permitida: ${value}`);
  }
  if (!normalized.endsWith('.py')) {
    throw new Error(`El agente genero un archivo no Python: ${normalized}`);
  }
  return normalized;
}

function targetGeneratedPath(value, batchIndex, batchCount, usedPaths) {
  let relative = safeGeneratedPath(value);
  if (batchCount > 1 && path.basename(relative) === 'test_markdown_cases.py') {
    relative = path.posix.join(path.posix.dirname(relative), `test_markdown_cases_${String(batchIndex + 1).padStart(3, '0')}.py`);
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
  const pythonFiles = [];
  await walk(outputDir, async (filePath) => {
    if (path.extname(filePath).toLowerCase() === '.py' && path.basename(filePath) !== 'conftest.py') {
      pythonFiles.push(filePath);
    }
  });
  if (!pythonFiles.length) {
    throw new Error('No se genero ningun archivo de test Python.');
  }
  const combined = (await Promise.all(pythonFiles.map((filePath) => fs.readFile(filePath, 'utf8')))).join('\n');
  for (const testCase of plan.cases) {
    if (!combined.includes(`proguide_case(${JSON.stringify(testCase.id)})`) && !combined.includes(`proguide_case('${String(testCase.id).replace(/'/g, "\\'")}')`)) {
      throw new Error(`El codigo generado no incluye el marcador proguide_case para ${testCase.id}.`);
    }
    if (!combined.includes(`def test_${safeId(testCase.id)}(`)) {
      throw new Error(`El codigo generado no incluye la funcion test_${safeId(testCase.id)}.`);
    }
  }
}

function casesToTestPlan(cases, { sourceMd, appName }) {
  const plannedCases = [];
  for (const testCase of cases) {
    if (testCase.excluded) continue;
    if (testCase.automation_state !== 'listo') continue;
    const steps = (testCase.executable_steps || []).map((step) => step.normalized_action || step.original_text).filter(Boolean);
    const caseData = mergeCaseData(testCase.data || {}, dataFromLines(testCase.data_used || []));
    const route = inferCaseRoute(testCase.route, testCase.original_steps, testCase.executable_steps);
    plannedCases.push({
      id: testCase.id,
      feature_id: 'markdown_cases',
      scenario_id: testCase.id,
      title: testCase.title,
      description: testCase.description || testCase.title,
      route,
      priority: priorityForPlan(testCase.priority),
      steps: steps.length ? steps : ['go to /'],
      expected: (testCase.expected_results || []).length ? testCase.expected_results : ['page is visible'],
      data: {
        ...caseData,
        preconditions: testCase.preconditions || [],
        data_used: maskSecretLines(testCase.data_used || []),
        qa_owner: testCase.qa_owner || null,
        dev_owner: testCase.dev_owner || null,
        ticket: testCase.ticket || null
      }
    });
  }
  return {
    schema_version: '1.0',
    generated_at: nowIso(),
    app_name: appName,
    source_prd: sourceMd,
    cases: plannedCases
  };
}

function parseMarkdownCases(markdown, { sourceName = 'source.md' } = {}) {
  const blocks = splitCaseBlocks(markdown);
  const cases = [];
  blocks.forEach((block, index) => {
    const testCase = parseBlock(block, index + 1);
    if (testCase) cases.push(testCase);
  });
  if (!cases.length && markdown.trim()) {
    const fallback = parseBlock({ heading: sourceName, lines: markdown.split(/\r?\n/) }, 1);
    if (fallback) cases.push(fallback);
  }
  return cases;
}

function splitCaseBlocks(markdown) {
  const blocks = [];
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading && isCaseHeading(heading[1], heading[2])) {
      if (current) blocks.push(current);
      current = { heading: cleanHeading(heading[2]), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  if (blocks.length) return blocks;

  const fallbackBlocks = [];
  current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (heading && !isFieldLabel(norm(heading[2]))) {
      if (current) fallbackBlocks.push(current);
      current = { heading: cleanHeading(heading[2]), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) fallbackBlocks.push(current);
  const contentBlocks = fallbackBlocks.filter(hasCaseContent);
  return contentBlocks.length ? contentBlocks : [{ heading: 'Caso 1', lines: markdown.split(/\r?\n/) }];
}

function isCaseHeading(prefix, text) {
  const normalized = norm(text);
  if (/^(?:caso|case|test|tc)(?:\s|#|:|\.|-|_|\d|$)/.test(normalized)) return true;
  if (/\btc[\s._-]*\d+\b/.test(normalized)) return true;
  return false;
}

function hasCaseContent(block) {
  let currentField = null;
  let hasSteps = false;
  let hasExpected = false;
  for (const rawLine of block.lines || []) {
    const line = rawLine.trim();
    if (!line || isSeparatorLine(line)) continue;
    if (line.startsWith('#')) {
      currentField = fieldFromHeading(line) || currentField;
      if (currentField === 'original_steps') hasSteps = true;
      if (currentField === 'expected_results') hasExpected = true;
      continue;
    }
    const stripped = stripListMarker(stripMarkdownEmphasis(line));
    const [label] = extractLabel(stripped);
    if (label) {
      currentField = label;
      if (label === 'original_steps') hasSteps = true;
      if (label === 'expected_results') hasExpected = true;
      continue;
    }
    if (currentField === 'original_steps' || looksLikeStep(line)) hasSteps = true;
    if (currentField === 'expected_results') hasExpected = true;
  }
  return hasSteps && hasExpected;
}

function parseBlock(block, number) {
  const fields = {
    title: titleFromHeading(block.heading, number),
    description: '',
    priority: 'media',
    preconditions: [],
    data_used: [],
    data: {},
    original_steps: [],
    expected_results: [],
    tags: [],
    route: '/'
  };
  let currentField = null;
  const originalLines = [`## ${block.heading}`, ...block.lines];
  for (const rawLine of block.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isSeparatorLine(line)) continue;
    if (line.startsWith('#')) {
      const label = fieldFromHeading(line);
      if (label) currentField = label;
      continue;
    }
    const stripped = stripListMarker(stripMarkdownEmphasis(line));
    const [label, value] = extractLabel(stripped);
    if (label) {
      currentField = label;
      if (value) appendField(fields, label, value);
      continue;
    }
    if (currentField) {
      appendField(fields, currentField, stripped);
    } else if (looksLikeStep(stripped)) {
      fields.original_steps.push(stripped);
    } else if (stripped) {
      fields.description = joinText(fields.description, stripped);
    }
  }

  fields.priority = normalizePriority(fields.priority || 'media');
  fields.tags = splitTags(fields.tags);
  fields.preconditions = cleanList(fields.preconditions);
  fields.data_used = cleanList(fields.data_used);
  fields.data = dataFromLines(fields.data_used);
  fields.original_steps = cleanList(fields.original_steps);
  fields.expected_results = cleanList(fields.expected_results);
  fields.route = inferCaseRoute(fields.route, fields.original_steps);

  const title = String(fields.title || `Caso ${number}`).trim();
  const [automationState, stateReason, confidence] = assessAutomation(fields.original_steps, fields.expected_results);
  return {
    id: safeId(`caso_${number}_${title}`),
    number,
    title,
    description: String(fields.description || '').trim(),
    priority: fields.priority,
    tags: fields.tags,
    preconditions: fields.preconditions,
    data_used: maskSecretLines(fields.data_used),
    data: fields.data,
    original_steps: fields.original_steps,
    executable_steps: buildSteps(fields.original_steps),
    expected_results: fields.expected_results,
    confidence,
    automation_state: automationState,
    state_reason: stateReason,
    original_markdown: maskSecretText(originalLines.join('\n').trim()),
    route: fields.route,
    qa_owner: noneIfEmpty(fields.qa_owner),
    dev_owner: noneIfEmpty(fields.dev_owner),
    ticket: noneIfEmpty(fields.ticket),
    excluded: false,
    parallelizable: true,
    result_obtained: '',
    status: 'pending',
    started_at: null,
    finished_at: null,
    duration_seconds: 0,
    artifacts: []
  };
}

function buildSteps(originalSteps) {
  return originalSteps.map((step, index) => ({
    number: index + 1,
    original_text: step,
    normalized_action: normalizeStep(step),
    status: 'pending',
    started_at: null,
    finished_at: null,
    duration_seconds: 0,
    observed_result: '',
    screenshot: null,
    error: null,
    confidence: stepConfidence(step),
    needs_review: REVIEW_STEP_RE.test(step),
    review_reason: REVIEW_STEP_RE.test(step) ? 'Paso ambiguo o dependiente de datos de ambiente.' : ''
  }));
}

function normalizeStep(step) {
  const normalized = norm(step);
  const explicit = explicitStep(step);
  if (explicit) return explicit;
  const isAssertion = /\b(expect|validar|verificar|comprobar|debe|mostrar|muestra|contiene|visible|aparece)\b/.test(normalized);
  const route = extractRoute(step);
  const clickTarget = extractClickTarget(step);
  if (clickTarget) return `click button ${clickTarget}`;
  if (route) return `go to ${route}`;
  if (/\b(email|e-mail|correo|usuario|user)\b/.test(normalized) && /\b(completar|ingresar|escribir|cargar|enter)\b/.test(normalized)) {
    return /\b(invalido|invalid|malformado|incorrecto)\b/.test(normalized) ? 'enter invalid email' : 'enter valid email';
  }
  if (/\b(password|pass|clave|contrasena)\b/.test(normalized) && /\b(completar|ingresar|escribir|cargar|enter)\b/.test(normalized)) {
    return /\b(invalido|invalid|corta|corto|incorrecto)\b/.test(normalized) ? 'enter invalid password' : 'enter valid password';
  }
  if (isAssertion && /\bdashboard\b/.test(normalized)) return 'expect text "Dashboard"';
  if (!isAssertion && /\b(enviar|submit|login|iniciar sesion|continuar)\b/.test(normalized)) return 'submit form';
  if (NAVIGATION_RE.test(normalized)) return 'go to /';
  if (/\b(recargar|refresh)\b/.test(normalized)) return 'refresh page';
  return step;
}

function assessAutomation(steps, expected) {
  const joinedSteps = steps.join('\n');
  const joinedExpected = expected.join('\n');
  if (!steps.length) return ['no_automatizable_aun', 'El caso no tiene pasos ejecutables.', 0.2];
  if (NOT_AUTOMATABLE_RE.test(joinedSteps)) return ['no_automatizable_aun', 'El caso requiere acciones fuera del navegador o controles no automatizables.', 0.35];
  if (!expected.length) return ['necesita_revision', 'Falta resultado esperado verificable.', 0.55];
  if (GENERIC_EXPECTED_RE.test(joinedExpected) && !hasConcreteExpected(expected)) return ['necesita_revision', 'El resultado esperado es generico; conviene hacerlo verificable.', 0.6];
  if (REVIEW_STEP_RE.test(joinedSteps)) return ['necesita_revision', 'Hay pasos ambiguos o dependientes de datos de ambiente.', 0.65];
  return ['listo', 'Caso listo para automatizar con el resolvedor actual.', 0.9];
}

function hasConcreteExpected(expected) {
  return expected.some((item) => /\b(url|muestra|shows|visible|contains|contiene|mensaje|texto|dashboard|home|error)\b/i.test(item));
}

function stepConfidence(step) {
  if (explicitStep(step)) return 0.95;
  if (NOT_AUTOMATABLE_RE.test(step)) return 0.2;
  if (REVIEW_STEP_RE.test(step)) return 0.45;
  return normalizeStep(step) !== step ? 0.85 : 0.7;
}

function explicitStep(step) {
  const text = String(step || '').trim();
  if (/^(?:fill|click|expect)\s+\[[^\]]+\]/i.test(text)) return text;
  if (/^expect\s+text\s+["'][^"']+["']/i.test(text)) return text;
  const selector = extractExplicitSelector(text);
  if (!selector) return null;
  const normalized = norm(text);
  if (/\b(click|clic|hacer clic|presionar|seleccionar|tocar)\b/.test(normalized)) {
    return `click ${selector}`;
  }
  if (/\b(fill|completar|ingresar|escribir|cargar|setear|introducir)\b/.test(normalized)) {
    const value = valueAfterSelector(text, selector, /(?:\bcon\b|\bwith\b|\bvalor\b|\bvalue\b)\s+(.+)$/i);
    return value ? `fill ${selector} with ${value}` : `fill ${selector}`;
  }
  if (/\b(expect|validar|verificar|comprobar|debe|mostrar|muestra|contiene|visible)\b/.test(normalized)) {
    const value = valueAfterSelector(text, selector, /(?:\bmuestra\b|\bmostrar\b|\bcontiene\b|\btexto\b|\bvalor\b|\bshows?\b|\bcontains?\b)\s+(.+)$/i);
    return value ? `expect ${selector} to contain text ${JSON.stringify(value)}` : `expect ${selector} to be visible`;
  }
  return null;
}

function extractExplicitSelector(text) {
  const bracketSelector = String(text || '').match(/\[[^\]]+\]/)?.[0];
  if (bracketSelector) return bracketSelector;
  const token = extractSelectorToken(text);
  return token ? `[data-testid="${escapeSelectorValue(token)}"]` : null;
}

function extractSelectorToken(text) {
  const normalizedText = stripAccents(String(text || ''));
  const patterns = [
    /\b(?:campo|input|elemento|selector|boton|enlace|link|badge|contador|toggle|id|data-testid)\s+["']?([A-Za-z][A-Za-z0-9_-]{1,80})["']?/i,
    /["']([A-Za-z][A-Za-z0-9_-]{1,80})["']/i
  ];
  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (!match) continue;
    const token = match[1].trim().replace(/[.,;:]+$/, '');
    if (isSelectorLikeToken(token)) return token;
  }
  const fallback = normalizedText.match(/\b([A-Za-z][A-Za-z0-9_-]*(?:[-_][A-Za-z0-9]+)+)\b/);
  if (fallback && /\b(attribute|atributo)\b/i.test(normalizedText) && /^data-/i.test(fallback[1])) return '';
  return fallback && isSelectorLikeToken(fallback[1]) ? fallback[1] : '';
}

function isSelectorLikeToken(token) {
  const value = String(token || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(value)) return false;
  if (/[-_]/.test(value)) return true;
  return /[a-z][A-Z]/.test(value);
}

function escapeSelectorValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function valueAfterSelector(text, selector, pattern) {
  const source = String(text || '');
  const selectorIndex = source.indexOf(selector);
  const afterSelector = selectorIndex >= 0 ? source.slice(selectorIndex + selector.length) : source;
  const match = afterSelector.match(pattern);
  if (!match) {
    const quoted = [...String(text || '').matchAll(/["']([^"']+)["']/g)]
      .map((item) => item[1].trim())
      .find((item) => item && item !== selector && !isSelectorLikeToken(item));
    return quoted || '';
  }
  return match[1].trim().replace(/^["']|["']$/g, '').replace(/[.;]+$/, '').trim();
}

function mergeCaseData(primary = {}, fallback = {}) {
  const merged = { ...(isPlainObject(fallback) ? fallback : {}) };
  if (!isPlainObject(primary)) return merged;
  for (const [key, value] of Object.entries(primary)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeCaseData(value, merged[key]);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dataFromLines(lines) {
  const data = {};
  for (const line of cleanList(lines)) {
    const match = String(line).match(/^([^:]{2,60}):\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    const normalizedKey = norm(key);
    if (!value) continue;
    if (isSecretKey(normalizedKey)) {
      if (allowsTestPasswordKey(normalizedKey)) {
        data.user = { ...(data.user || {}), password: value };
      }
      continue;
    }
    if (/\b(email|e-mail|correo)\b/.test(normalizedKey) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      data.user = { ...(data.user || {}), email: value };
      continue;
    }
    if (/\b(usuario|user|username)\b/.test(normalizedKey)) {
      data.user = { ...(data.user || {}), username: value };
      continue;
    }
    const dataKey = normalizedKey.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (dataKey) data[dataKey] = value;
  }
  return data;
}

function sanitizeCaseData(value) {
  if (Array.isArray(value)) return value.map(sanitizeCaseData);
  if (!isPlainObject(value)) return value;
  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    sanitized[key] = sanitizeCaseData(entry);
  }
  return sanitized;
}

function maskSecretsDeep(value, key = '') {
  if (Array.isArray(value)) return value.map((entry) => maskSecretsDeep(entry));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      maskSecretsDeep(entryValue, entryKey)
    ]));
  }
  if (isSecretKey(key)) return '******';
  if (typeof value === 'string') return maskSecretLine(value);
  return value;
}

function isSecretKey(key) {
  return /\b(password|pass|clave|contrasena|secret|token|api[_ -]?key)\b/i.test(norm(key));
}

function allowsTestPasswordKey(key) {
  const normalized = norm(key).replace(/_/g, ' ');
  return /\b(password|pass|clave|contrasena)\b/.test(normalized) &&
    /\b(test|prueba|dummy|fake|no productiv[oa]|non production)\b/.test(normalized);
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
  const executableSteps = Array.isArray(item.executable_steps) && item.executable_steps.length
    ? item.executable_steps.map((step, index) => ({
      number: Number(step.number || index + 1),
      original_text: String(step.original_text || originalSteps[index] || ''),
      normalized_action: String(step.normalized_action || normalizeStep(step.original_text || originalSteps[index] || '')),
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
    : buildSteps(originalSteps);
  const route = inferCaseRoute(item.route || fallback.route, originalSteps, executableSteps);
  return {
    id: safeId(item.id || fallback.id || `caso_${number}_${title}`),
    number: Number(item.number || fallback.number || number),
    title,
    description: String(item.description ?? fallback.description ?? ''),
    priority: normalizePriority(item.priority || fallback.priority || 'media'),
    tags: splitTags(item.tags || fallback.tags || []),
    preconditions: cleanList(item.preconditions || fallback.preconditions || []),
    data_used: maskSecretLines(cleanList(item.data_used || fallback.data_used || [])),
    data: sanitizeCaseData(mergeCaseData(item.data || {}, fallback.data || {})),
    original_steps: originalSteps,
    executable_steps: executableSteps,
    expected_results: expectedResults,
    confidence: Number(item.confidence ?? fallback.confidence ?? 1),
    automation_state: normalizeAutomationState(item.automation_state || fallback.automation_state || 'listo'),
    state_reason: String(item.state_reason ?? fallback.state_reason ?? ''),
    original_markdown: String(item.original_markdown ?? fallback.original_markdown ?? ''),
    route,
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
      title: 'Login valido',
      description: 'string',
      priority: 'baja|media|alta|critica',
      tags: ['string'],
      preconditions: ['string'],
      data_used: ['Password: ******'],
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
  if (provider === 'openai') {
    const apiKey = providerApiKey('openai');
    if (!apiKey.value) throw new Error(`Falta OPENAI_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY para ${purpose}. Root efectivo: ${root}. Provider: ${provider}. Config: ${configPath}.`);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.value}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: Number(config.llm.temperature ?? 0.2),
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI fallo al ${purpose} (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
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
    const choice = data.choices?.[0] || {};
    if (choice.finish_reason === 'length') {
      throw new Error(`OpenAI trunco la respuesta al ${purpose}. max_tokens=${maxOutputTokens}. Sube llm.max_output_tokens o baja llm.max_cases en ${configPath}.`);
    }
    return extractJson(choice.message?.content || '', { purpose, provider, maxOutputTokens, configPath });
  }
  if (provider === 'anthropic') {
    const apiKey = providerApiKey('anthropic');
    if (!apiKey.value) throw new Error(`Falta ANTHROPIC_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY para ${purpose}. Root efectivo: ${root}. Provider: ${provider}. Config: ${configPath}.`);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey.value,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llm.model,
        max_tokens: maxOutputTokens,
        temperature: Number(config.llm.temperature ?? 0.2),
        system,
        messages: [
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`Anthropic fallo al ${purpose} (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
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
  throw new Error(`Proveedor LLM no soportado: ${provider}. Root efectivo: ${root}. Config: ${configPath}.`);
}

function providerApiKey(provider) {
  const names = provider === 'anthropic'
    ? ['ANTHROPIC_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY']
    : ['OPENAI_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY'];
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
    return `<tr>
      <td>${escapeHtml(testCase.number || '')}</td>
      <td>${escapeHtml(result.title)}</td>
      <td>${escapeHtml(result.status)}</td>
      <td>${escapeHtml(result.message || '')}</td>
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
      screenshots: 'on_failure',
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

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

async function loadDotEnv(root) {
  for (const envPath of envFileCandidates(root)) {
    if (!(await exists(envPath))) continue;
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

function envFileCandidates(root) {
  return [
    process.env.PROGUIDE_ENV_FILE,
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.proguide', '.env'),
    path.join(root, '.env')
  ].filter(Boolean).map((item) => path.resolve(String(item)));
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

function extractLabel(line) {
  const match = line.match(/^([^:]{2,40}):\s*(.*)$/);
  if (!match) return [null, ''];
  const field = FIELD_ALIASES[norm(match[1])];
  return field ? [field, match[2].trim()] : [null, ''];
}

function fieldFromHeading(line) {
  const label = line.replace(/^#+\s*/, '').trim();
  return FIELD_ALIASES[norm(label)] || null;
}

function appendField(fields, label, value) {
  const cleanValue = stripListMarker(value).trim();
  if (!cleanValue) return;
  if (['preconditions', 'data_used', 'original_steps', 'expected_results', 'tags'].includes(label)) {
    fields[label] = fields[label] || [];
    fields[label].push(cleanValue);
  } else if (['qa_owner', 'dev_owner', 'ticket', 'route', 'priority', 'title'].includes(label)) {
    fields[label] = cleanValue;
  } else if (label === 'description') {
    fields[label] = joinText(String(fields[label] || ''), cleanValue);
  }
}

function looksLikeStep(line) {
  return /^(?:\d+[\).\s-]+|paso\s+\d+[:.\s-]+)/i.test(norm(line));
}

function stripListMarker(line) {
  const bulletPattern = escapeRegExp(BULLET_CHARS);
  return line.replace(new RegExp(`^\\s*(?:[-*+${bulletPattern}]\\s+|\\d+[\\).\\s-]+|paso\\s+\\d+[:.\\s-]+)`, 'i'), '').trim();
}

function stripMarkdownEmphasis(line) {
  return line.replace(/\*\*/g, '').replace(/__/g, '').trim();
}

function isSeparatorLine(line) {
  return /^[-*_]{3,}$/.test(String(line || '').trim());
}

function titleFromHeading(heading, number) {
  const title = stripListMarker(String(heading).replace(/^\s*(?:caso|case|test|tc)(?:\s|#|:|\.|-|_)*\d*[\s:.\-_]*/i, '').trim());
  return title || `Caso ${number}`;
}

function cleanHeading(heading) {
  return stripListMarker(String(heading).trim().replace(/^#+|#+$/g, '').trim());
}

function isFieldLabel(text) {
  return Boolean(FIELD_ALIASES[text]);
}

function norm(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ');
}

function stripAccents(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '');
}

function normalizePriority(value) {
  const normalized = norm(value);
  if (['critica', 'critical', 'bloqueante'].includes(normalized)) return 'critica';
  if (['alta', 'high'].includes(normalized)) return 'alta';
  if (['baja', 'low'].includes(normalized)) return 'baja';
  return 'media';
}

function priorityForPlan(value) {
  return { baja: 'low', media: 'medium', alta: 'high', critica: 'critical' }[normalizePriority(value)] || 'medium';
}

function normalizeAutomationState(value) {
  const normalized = String(value || '').trim();
  return ['listo', 'necesita_revision', 'no_automatizable_aun'].includes(normalized) ? normalized : 'listo';
}

function splitTags(value) {
  const rawValues = typeof value === 'string' ? [value] : Array.from(value || []);
  return rawValues.flatMap((item) => String(item).split(/[,;]/).map((part) => part.trim()).filter(Boolean));
}

function cleanList(values) {
  const rawValues = typeof values === 'string' ? [values] : Array.from(values || []);
  return rawValues.map((value) => stripListMarker(String(value)).trim()).filter(Boolean);
}

function joinText(existing, value) {
  return existing ? `${existing}\n${String(value).trim()}` : String(value).trim();
}

function inferCaseRoute(explicitRoute, originalSteps = [], executableSteps = []) {
  const explicit = normalizeRouteValue(explicitRoute);
  if (explicit && explicit !== '/') return explicit;

  const candidates = [];
  for (const step of cleanList(originalSteps)) {
    candidates.push(extractRoute(step));
  }
  for (const step of executableSteps || []) {
    candidates.push(routeFromNormalizedAction(step?.normalized_action));
    candidates.push(extractRoute(step?.original_text || ''));
  }

  const inferred = candidates.map(normalizeRouteValue).find((route) => route && route !== '/');
  return inferred || explicit || '/';
}

function routeFromNormalizedAction(action) {
  const match = String(action || '').trim().match(/^go to\s+(.+)$/i);
  return match ? match[1] : null;
}

function normalizeRouteValue(value) {
  const text = String(value || '').trim().replace(/[.,;]+$/, '');
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
  return text.startsWith('/') ? text : `/${text}`;
}

function extractRoute(step) {
  const text = String(step);
  const normalized = norm(text);
  const hasRouteContext = NAVIGATION_RE.test(normalized) ||
    (/\bingresar\b/.test(normalized) && /(https?:\/\/|\/[A-Za-z0-9_\-/?#=&.]+)/.test(text)) ||
    /\b(ruta|route|url)\b/.test(normalized) ||
    /^\s*(?:https?:\/\/|\/[A-Za-z0-9_\-/?#=&.]+)/.test(text);
  if (!hasRouteContext) return null;

  let match = text.match(/(https?:\/\/\S+|\/[A-Za-z0-9_\-/?#=&.]+)/);
  if (match) return match[1].replace(/[.,;]+$/, '');
  match = text.match(/\b(?:ruta|route|url)\s+([A-Za-z0-9_\-/?#=&.]+)/i);
  if (!match) return null;
  const value = match[1].trim().replace(/[.,;]+$/, '');
  return value.startsWith('/') ? value : `/${value}`;
}

function extractClickTarget(step) {
  const patterns = [
    /(?:hacer\s+)?clic\s+(?:en\s+)?(?:el\s+boton\s+|boton\s+)?["']?([^"']+?)["']?$/i,
    /(?:click|press|presionar|seleccionar)\s+(?:button\s+|boton\s+)?["']?([^"']+?)["']?$/i
  ];
  for (const pattern of patterns) {
    const match = String(step).match(pattern);
    if (!match) continue;
    const target = match[1].trim().replace(/[.,;]+$/, '');
    if (target && !['formulario', 'boton', 'button'].includes(norm(target))) return target;
  }
  return null;
}

function maskSecretText(text) {
  return String(text).split(/\r?\n/).map(maskSecretLine).join('\n');
}

function maskSecretLines(values) {
  return values.map(maskSecretLine);
}

function maskSecretLine(value) {
  const text = String(value);
  const normalized = norm(text);
  if (!/\b(password|pass|clave|contrasena|secret|token)\b/.test(normalized)) return text;
  if (/\b(valido|valid|campo|input|completar|ingresar|escribir|placeholder)\b/.test(normalized)) return text;
  if (text.includes(':')) {
    const prefix = text.slice(0, text.indexOf(':') + 1);
    return `${prefix}${prefix.endsWith(' ') ? '' : ' '}******`;
  }
  const match = text.match(/^(\s*[-*+]?\s*(?:password|pass|clave|contrasena|secret|token)\b).*$/i);
  return match ? `${match[1]}: ******` : text;
}

function noneIfEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
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

function normalizeLlmUsage(provider, usage = {}) {
  const inputTokens = safeNumber(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const outputTokens = safeNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens);
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {};
  const hasDetailedCacheCreation = usage.cache_creation_5m_input_tokens !== undefined ||
    usage.cache_creation_1h_input_tokens !== undefined ||
    Boolean(usage.cache_creation);
  const cacheCreation5m = safeNumber(usage.cache_creation_5m_input_tokens ?? cacheCreation.ephemeral_5m_input_tokens) +
    safeNumber(!hasDetailedCacheCreation ? usage.cache_creation_input_tokens : 0);
  const cacheCreation1h = safeNumber(usage.cache_creation_1h_input_tokens ?? cacheCreation.ephemeral_1h_input_tokens);
  const cacheRead = safeNumber(usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const cacheCreationTotal = cacheCreation5m + cacheCreation1h;
  const reportedTotal = safeNumber(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = reportedTotal || inputTokens + outputTokens + cacheCreationTotal + cacheRead;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTotal,
    cache_creation_5m_input_tokens: cacheCreation5m,
    cache_creation_1h_input_tokens: cacheCreation1h,
    cache_read_input_tokens: cacheRead,
    total_tokens: totalTokens,
    provider: String(provider || '').toLowerCase()
  };
}

function estimateLlmCost(provider, model, usage) {
  if (String(provider || '').toLowerCase() !== 'anthropic') {
    return {
      cost_usd: null,
      pricing: {
        source: 'unknown',
        note: 'Costo no estimado para este proveedor.'
      }
    };
  }
  const family = anthropicModelFamily(model);
  const pricing = family ? ANTHROPIC_PRICING_BY_FAMILY[family] : null;
  if (!pricing) {
    return {
      cost_usd: null,
      pricing: {
        source: ANTHROPIC_PRICING_SOURCE,
        note: `Modelo Anthropic sin tabla local de precios: ${model || 'unknown'}.`
      }
    };
  }
  const cost = (
    safeNumber(usage.input_tokens) * pricing.input_per_mtok +
    safeNumber(usage.output_tokens) * pricing.output_per_mtok +
    safeNumber(usage.cache_creation_5m_input_tokens) * pricing.cache_write_5m_per_mtok +
    safeNumber(usage.cache_creation_1h_input_tokens) * pricing.cache_write_1h_per_mtok +
    safeNumber(usage.cache_read_input_tokens) * pricing.cache_read_per_mtok
  ) / 1_000_000;
  return {
    cost_usd: roundMoney(cost),
    pricing: {
      source: ANTHROPIC_PRICING_SOURCE,
      provider: 'anthropic',
      model_family: family,
      unit: 'USD_per_million_tokens',
      rates: pricing
    }
  };
}

function anthropicModelFamily(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('haiku')) return 'haiku';
  return '';
}

function formatUsageTokensForEvent(usage) {
  return String(safeNumber(usage.total_tokens));
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 1_000_000_000) / 1_000_000_000 : null;
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

async function walk(directory, onFile) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath, onFile);
    if (entry.isFile()) await onFile(fullPath);
  }
}

function parseXmlAttrs(text) {
  const attrs = {};
  const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g;
  let match;
  while ((match = attrRe.exec(text))) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

function stripXml(text) {
  return decodeXml(String(text || '').replace(/<[^>]+>/g, '').trim());
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
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
  const reason = firstUseful || `pytest exited with code ${exitCode}`;
  return `setup_failed: ${reason}. See ${relativeLogPath}. Run proguide doctor --fix.`;
}

function firstUsefulLogLine(logText) {
  return String(logText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /ModuleNotFoundError|ImportError|No module named|Error|Traceback|pytest: error|Target page|Timeout|ERR_/i.test(line)) || '';
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

function safeId(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'item';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function nowIso() {
  return new Date().toISOString();
}
