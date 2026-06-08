import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const PROGUIDE_DIR = 'proguide_tests';
const RUNS_DIR = 'runs';
const RUN_JSON = 'run.json';
const SOURCE_MD = 'source.md';
const NORMALIZED_CASES_JSON = 'normalized_cases.json';
const TEST_PLAN_JSON = 'test_plan.json';
const EVENTS_JSONL = 'events.jsonl';
const RESULTS_JSON = 'results.json';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  expected: 'expected_results',
  'expected result': 'expected_results',
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
- Use credentials from environment variables PROGUIDE_USER_EMAIL, PROGUIDE_USER_USERNAME, PROGUIDE_USER_PASSWORD when needed.
- Keep assertions explicit with playwright.sync_api.expect.
- Include imports and any helper functions in the generated file.
- Return only valid JSON with this shape:
  {"files":[{"path":"test_markdown_cases.py","content":"...python code..."}]}
- Do not include markdown fences.`;

export async function listRunRecords(root) {
  const runsDir = runsRoot(root);
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        records.push(await loadRunRecord(path.join(runsDir, entry.name)));
      } catch {
        // Ignore partial or corrupted run folders in history.
      }
    }
    return records.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    return [];
  }
}

export async function loadRunBundle(root, runId) {
  const runDir = runPath(root, runId);
  const run = await loadRunRecord(runDir);
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

export async function prepareMarkdownRun({ root, sourceMd, baseUrl, metadata = {}, useAgent = false }) {
  await ensureLayout(root);
  await loadDotEnv(root);
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
    app_name: metadata.app_name || metadata.title || null,
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
      ? await interpretMarkdownWithAgent(markdown, { root, sourceName: path.basename(sourceMd) })
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
  await appendEvent(runDir, {
    run_id: runId,
    type: 'cases_saved',
    status: 'ready',
    message: 'Cambios de preview guardados.'
  });
  return { cases };
}

export async function executePreparedRun({ root, runId, baseUrl, credentials = {}, python = 'python' }) {
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

  const plan = casesToTestPlan(cases, { sourceMd: SOURCE_MD, appName: run.app_name || 'ProGuide Markdown Cases' });
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
      type: 'code_generation_started',
      status: run.status,
      message: 'Agente generando codigo Python Playwright.'
    });
    await generateTestsWithAgent({ root, plan, cases, outputDir: generatedDir, config });
    await appendEvent(runDir, { run_id: run.id, type: 'tests_generated', status: 'running', message: 'Codigo Python Playwright generado.' });

    run.status = 'running';
    await saveRun(runDir, run);
    await appendEvent(runDir, { run_id: run.id, type: 'run_started', status: run.status, message: 'Ejecucion iniciada.' });

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
  const command = [python, '-m', 'pytest', testsDir, '--junitxml', junitPath];
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
    results = plan.cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      status: 'inconclusive',
      duration_seconds: 0,
      message: `pytest exited with code ${completed.code}. See ${relativePath(pytestLogPath, projectRoot)}.`,
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

async function parsePytestResults({ plan, junitPath, runDir }) {
  const caseBySafeId = new Map(plan.cases.map((testCase) => [safeId(testCase.id), testCase]));
  const parsed = new Map();
  if (await exists(junitPath)) {
    const xml = await fs.readFile(junitPath, 'utf8');
    const testcaseRe = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^/>]*)\/>/g;
    let match;
    while ((match = testcaseRe.exec(xml))) {
      const attrs = parseXmlAttrs(match[1] || match[3] || '');
      const inner = match[2] || '';
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

async function generateTestsWithAgent({ root, plan, cases, outputDir, config }) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'conftest.py'), 'pytest_plugins = ["proguide.pytest_plugin"]\n', 'utf8');
  const payload = {
    project: {
      base_url_is_available_as_fixture: 'proguide_base_url',
      test_runner: 'pytest',
      browser_library: 'python-playwright-sync',
      evidence_fixture: 'proguide_steps'
    },
    required_output: {
      files: [
        {
          path: 'test_markdown_cases.py',
          content: 'complete python source'
        }
      ]
    },
    test_cases: plan.cases.map((testCase) => {
      const sourceCase = cases.find((item) => item.id === testCase.id) || {};
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
        data_used: sourceCase.data_used || []
      };
    })
  };
  const data = await callJsonModel(config, {
    root,
    system: PLAYWRIGHT_CODE_AGENT_PROMPT,
    payload,
    purpose: 'generar codigo Python Playwright'
  });
  const files = normalizeGeneratedFiles(data);
  if (!files.length) {
    throw new Error('El agente no devolvio archivos Python para ejecutar.');
  }
  for (const file of files) {
    const relative = safeGeneratedPath(file.path);
    await fs.writeFile(path.join(outputDir, relative), String(file.content || ''), 'utf8');
  }
  await validateGeneratedCode(outputDir, plan);
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
    const steps = (testCase.executable_steps || []).map((step) => step.normalized_action || step.original_text).filter(Boolean);
    plannedCases.push({
      id: testCase.id,
      feature_id: 'markdown_cases',
      scenario_id: testCase.id,
      title: testCase.title,
      description: testCase.description || testCase.title,
      route: testCase.route || '/',
      priority: priorityForPlan(testCase.priority),
      steps: steps.length ? steps : ['go to /'],
      expected: (testCase.expected_results || []).length ? testCase.expected_results : ['page is visible'],
      data: {
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

  current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (heading) {
      if (current) blocks.push(current);
      current = { heading: cleanHeading(heading[2]), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks.length ? blocks : [{ heading: 'Caso 1', lines: markdown.split(/\r?\n/) }];
}

function isCaseHeading(prefix, text) {
  const normalized = norm(text);
  if (/^(?:caso|case|test|tc)(?:\s|#|:|\.|-|_|\d|$)/.test(normalized)) return true;
  return [2, 3].includes(prefix.length) && !isFieldLabel(normalized);
}

function parseBlock(block, number) {
  const fields = {
    title: titleFromHeading(block.heading, number),
    description: '',
    priority: 'media',
    preconditions: [],
    data_used: [],
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
  fields.original_steps = cleanList(fields.original_steps);
  fields.expected_results = cleanList(fields.expected_results);

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
    original_steps: fields.original_steps,
    executable_steps: buildSteps(fields.original_steps),
    expected_results: fields.expected_results,
    confidence,
    automation_state: automationState,
    state_reason: stateReason,
    original_markdown: maskSecretText(originalLines.join('\n').trim()),
    route: String(fields.route || '/').trim() || '/',
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
  const route = extractRoute(step);
  const clickTarget = extractClickTarget(step);
  if (clickTarget) return `click button ${clickTarget}`;
  if (route) return `go to ${route}`;
  if (/\b(enviar|submit|login|iniciar sesion|continuar)\b/.test(normalized)) return 'submit form';
  if (/\b(ir|abrir|navegar|visitar|acceder|ingresar)\b/.test(normalized)) return 'go to /';
  if (/\b(email|e-mail|correo|usuario|user)\b/.test(normalized) && /\b(completar|ingresar|escribir|cargar|enter)\b/.test(normalized)) return 'enter valid email';
  if (/\b(password|pass|clave|contrasena)\b/.test(normalized) && /\b(completar|ingresar|escribir|cargar|enter)\b/.test(normalized)) return 'enter valid password';
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
  if (NOT_AUTOMATABLE_RE.test(step)) return 0.2;
  if (REVIEW_STEP_RE.test(step)) return 0.45;
  return normalizeStep(step) !== step ? 0.85 : 0.7;
}

async function interpretMarkdownWithAgent(markdown, { root, sourceName }) {
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
    purpose: 'interpretar casos Markdown'
  });
  const casesData = coerceCasesPayload(parsed);
  const cases = casesData.map((item, index) => normalizeCaseForStorage(item, index + 1, baseline[index]));
  return cases.slice(0, config.llm.max_cases).length ? cases.slice(0, config.llm.max_cases) : baseline;
}

function normalizeCaseForStorage(item, number, fallback = {}) {
  const title = String(item.title || fallback.title || `Caso ${number}`).trim();
  const originalSteps = cleanList(item.original_steps || fallback.original_steps || []);
  const expectedResults = cleanList(item.expected_results || fallback.expected_results || []);
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
  return {
    id: safeId(item.id || fallback.id || `caso_${number}_${title}`),
    number: Number(item.number || fallback.number || number),
    title,
    description: String(item.description ?? fallback.description ?? ''),
    priority: normalizePriority(item.priority || fallback.priority || 'media'),
    tags: splitTags(item.tags || fallback.tags || []),
    preconditions: cleanList(item.preconditions || fallback.preconditions || []),
    data_used: maskSecretLines(cleanList(item.data_used || fallback.data_used || [])),
    original_steps: originalSteps,
    executable_steps: executableSteps,
    expected_results: expectedResults,
    confidence: Number(item.confidence ?? fallback.confidence ?? 1),
    automation_state: normalizeAutomationState(item.automation_state || fallback.automation_state || 'listo'),
    state_reason: String(item.state_reason ?? fallback.state_reason ?? ''),
    original_markdown: String(item.original_markdown ?? fallback.original_markdown ?? ''),
    route: String(item.route || fallback.route || '/').trim() || '/',
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

async function callJsonModel(config, { root, system, payload, purpose }) {
  await loadDotEnv(root);
  if (config.llm.provider === 'disabled') {
    throw new Error(`El agente LLM esta deshabilitado en proguide_tests/config.yaml; no se puede ${purpose}.`);
  }
  if (config.llm.provider === 'openai') {
    const apiKey = providerApiKey('openai');
    if (!apiKey.value) throw new Error(`Falta OPENAI_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY para ${purpose}.`);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.value}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: Number(config.llm.temperature ?? 0.2),
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
    return extractJson(data.choices?.[0]?.message?.content || '');
  }
  if (config.llm.provider === 'anthropic') {
    const apiKey = providerApiKey('anthropic');
    if (!apiKey.value) throw new Error(`Falta ANTHROPIC_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY para ${purpose}.`);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey.value,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llm.model,
        max_tokens: Number(config.llm.max_output_tokens || 8000),
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
    const text = (data.content || [])
      .map((block) => block.type === 'text' ? block.text : '')
      .join('\n');
    return extractJson(text);
  }
  throw new Error(`Proveedor LLM no soportado: ${config.llm.provider}`);
}

function providerApiKey(provider) {
  const names = provider === 'anthropic'
    ? ['ANTHROPIC_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY']
    : ['OPENAI_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY'];
  const name = names.find((item) => process.env[item]);
  return { name: name || names[0], value: name ? process.env[name] : '' };
}

function extractJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1));
    throw new Error('El agente no devolvio JSON valido.');
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
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
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

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

async function loadDotEnv(root) {
  const envPath = path.join(root, '.env');
  if (!(await exists(envPath))) return;
  const text = await fs.readFile(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
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

function extractRoute(step) {
  let match = String(step).match(/(https?:\/\/\S+|\/[A-Za-z0-9_\-/?#=&.]+)/);
  if (match) return match[1].replace(/[.,;]+$/, '');
  match = String(step).match(/\b(?:ruta|route)\s+([A-Za-z0-9_\-/?#=&.]+)/i);
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

async function ensureLayout(root) {
  await fs.mkdir(path.join(root, PROGUIDE_DIR, RUNS_DIR), { recursive: true });
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
  const counts = { passed: 0, failed: 0, inconclusive: 0 };
  for (const result of summary.results || []) {
    if (result.status === 'passed') counts.passed += 1;
    else if (result.status === 'failed') counts.failed += 1;
    else counts.inconclusive += 1;
  }
  return counts;
}

function statusFromSummary(counts, blocked) {
  if (counts.failed) return 'failed';
  if (counts.inconclusive) return 'inconclusive';
  if (blocked && !counts.passed) return 'blocked';
  if (counts.passed && !counts.failed && !counts.inconclusive) return 'passed';
  return 'finished';
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
