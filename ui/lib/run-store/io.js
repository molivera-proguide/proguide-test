// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../shared/time.js';
import { safeId } from '../shared/id.js';

// Low-level run-store primitives: path layout/constants, JSON read/write,
// existence checks, event log append, artifact/evidence collection, and small
// summary/log utilities. Leaf I/O — depends only on fs/path plus the shared
// time/id helpers. Extracted verbatim from proguide-service.js; the service and
// the runner import these back.

export const PROGUIDE_DIR = 'proguide_tests';
export const RUNS_DIR = 'runs';
export const RUN_JSON = 'run.json';
export const SOURCE_MD = 'source.md';
export const SOURCE_CASES_JSON = 'source_cases.json';
export const NORMALIZED_CASES_JSON = 'normalized_cases.json';
export const TEST_PLAN_JSON = 'test_plan.json';
export const EVENTS_JSONL = 'events.jsonl';
export const RESULTS_JSON = 'results.json';
export const USAGE_DIR = 'usage';
export const LLM_USAGE_JSON = 'llm_usage.json';
export const LLM_USAGE_JSONL = 'llm_usage.jsonl';

export async function ensureLayout(root) {
  await fs.mkdir(path.join(root, PROGUIDE_DIR, RUNS_DIR), { recursive: true });
  await fs.mkdir(usageRoot(root), { recursive: true });
}

export function usageRoot(root) {
  return path.join(root, PROGUIDE_DIR, USAGE_DIR);
}

export function globalUsageLogPath(root) {
  return path.join(usageRoot(root), LLM_USAGE_JSONL);
}

export function runsRoot(root) {
  return path.join(root, PROGUIDE_DIR, RUNS_DIR);
}

export function runPath(root, runId) {
  return path.join(runsRoot(root), runId);
}

export async function newRunDir(root) {
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

export function makeRunId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export async function loadRunRecord(runDir) {
  return readJson(path.join(runDir, RUN_JSON));
}

export async function legacyRunRecord(runDir, runId, error) {
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

export async function saveRun(runDir, run) {
  await fs.mkdir(runDir, { recursive: true });
  await writeJson(path.join(runDir, RUN_JSON), run);
}

export async function saveCasesFile(runDir, cases) {
  await writeJson(path.join(runDir, NORMALIZED_CASES_JSON), cases);
}

export async function loadSummary(runDir) {
  const resultsPath = path.join(runDir, RESULTS_JSON);
  if (await exists(resultsPath)) return readJson(resultsPath);
  const summaryPath = path.join(runDir, 'summary.json');
  if (await exists(summaryPath)) return readJson(summaryPath);
  return null;
}

export async function loadEvents(runDir) {
  const eventsPath = path.join(runDir, EVENTS_JSONL);
  if (!(await exists(eventsPath))) return [];
  const text = await fs.readFile(eventsPath, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export async function appendEvent(runDir, event) {
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

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (arguments.length >= 2) return fallback;
    throw error;
  }
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadLoggedSteps(runDir, caseId) {
  const stepPath = path.join(runDir, 'step_logs', `${safeId(caseId)}.json`);
  if (!(await exists(stepPath))) return [];
  const payload = await readJson(stepPath, {});
  return (payload.steps || []).map((entry) => `${entry.status}: ${entry.step}`);
}

export async function collectArtifacts(directory, relativeTo, suffixes, stem = null) {
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

export async function collectApiEvidence(runDir, caseId) {
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

export async function walk(directory, onFile) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath, onFile);
    if (entry.isFile()) await onFile(fullPath);
  }
}

export function countSummary(summary) {
  const counts = { passed: 0, failed: 0, inconclusive: 0, setup_failed: 0 };
  for (const result of summary.results || []) {
    if (result.status === 'passed') counts.passed += 1;
    else if (result.status === 'failed') counts.failed += 1;
    else if (result.status === 'setup_failed') counts.setup_failed += 1;
    else counts.inconclusive += 1;
  }
  return counts;
}

export function statusFromSummary(counts, blocked) {
  if (counts.setup_failed) return 'setup_failed';
  if (counts.failed) return 'failed';
  if (counts.inconclusive) return 'inconclusive';
  if (blocked && !counts.passed) return 'blocked';
  if (blocked && counts.passed) return 'finished';
  if (counts.passed && !counts.failed && !counts.inconclusive) return 'passed';
  return 'finished';
}

export function setupFailureMessage(exitCode, logText, relativeLogPath) {
  const firstUseful = firstUsefulLogLine(logText);
  const reason = firstUseful || `playwright test exited with code ${exitCode}`;
  return `setup_failed: ${reason}. See ${relativeLogPath}. Run proguide doctor --fix.`;
}

export function firstUsefulLogLine(logText) {
  return String(logText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /Cannot find module|Error|Traceback|Target page|Timeout|ERR_|playwright/i.test(line)) || '';
}

export function chunkArray(items, size) {
  const chunks = [];
  const chunkSize = Math.max(1, size);
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function relativePath(filePath, base) {
  return path.relative(base, filePath).split(path.sep).join('/');
}
