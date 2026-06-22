import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadGeneratedCaseCode,
  loadUsageSummary,
  listRunRecords,
  loadRunBundle
} from './proguide-service.js';
import {
  layout,
  renderRunsIndex,
  renderUsageDashboard,
  renderRunDetail,
  renderCaseDetail
} from './views/pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require('./package.json').version;
const VIEWER_CAPABILITIES = ['usage'];
const ROOT = path.resolve(process.env.PROGUIDE_UI_ROOT || path.join(__dirname, '..'));
const HOST = process.env.PROGUIDE_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.PROGUIDE_UI_PORT || 8787);
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = nonNegativeNumber(process.env.PROGUIDE_VIEWER_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);

const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
let activeRequests = 0;
let idleTimer = null;

app.addHook('onRequest', async () => {
  activeRequests += 1;
  clearIdleTimer();
});

app.addHook('onResponse', async () => {
  activeRequests = Math.max(0, activeRequests - 1);
  scheduleIdleShutdown();
});

app.addHook('onClose', async () => {
  clearIdleTimer();
});

app.get('/', async (_request, reply) => {
  return reply.redirect('/runs');
});

app.get('/runs', async (_request, reply) => {
  const [runs, usage] = await Promise.all([
    listRunRecords(ROOT),
    loadUsageSummary(ROOT)
  ]);
  return reply.header('Content-Type', 'text/html; charset=utf-8').send(layout('Ejecuciones', renderRunsIndex(runs, usage)));
});

app.get('/usage', async (_request, reply) => {
  const usage = await loadUsageSummary(ROOT);
  return reply.header('Content-Type', 'text/html; charset=utf-8').send(layout('Uso LLM', renderUsageDashboard(usage)));
});

app.get('/preview', async (_request, reply) => {
  return reply.redirect('/runs');
});

app.post('/runs/prepare', async (_request, reply) => {
  return reply.code(410).send('La importacion de casos se realiza por MCP. Usa la herramienta run_cases/create_run o los aliases run_markdown_cases/create_run_from_markdown.');
});

app.get('/runs/:runId/preview', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  return reply.redirect(`/runs/${encodeURIComponent(runId)}`);
});

app.get('/runs/:runId/usage', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  const usage = await loadUsageSummary(ROOT, { runId });
  return reply.header('Content-Type', 'text/html; charset=utf-8').send(layout('Uso LLM', renderUsageDashboard(usage, { runId })));
});

app.get('/runs/:runId', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  const [payload, usage] = await Promise.all([
    loadRunBundle(ROOT, runId),
    loadUsageSummary(ROOT, { runId })
  ]);
  return reply.header('Content-Type', 'text/html; charset=utf-8').send(layout('Ejecucion', renderRunDetail(payload.run, payload.cases || [], payload.summary, usage)));
});

app.get('/runs/:runId/cases/:caseId', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  const caseId = cleanCaseId(request.params.caseId);
  const payload = await loadRunBundle(ROOT, runId);
  const testCase = (payload.cases || []).find((item) => item.id === caseId);
  if (!testCase) {
    return reply.code(404).send('Caso no encontrado.');
  }
  const stepLog = await readStepLog(runId, caseId);
  const generatedCode = await loadGeneratedCaseCode(ROOT, runId, caseId);
  return reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .send(layout('Detalle de caso', renderCaseDetail(payload.run, testCase, payload.summary, stepLog, generatedCode)));
});

app.get('/api/runs/:runId', async (request) => {
  const runId = cleanRunId(request.params.runId);
  return loadRunBundle(ROOT, runId);
});

app.get('/api/usage', async () => loadUsageSummary(ROOT));

app.get('/api/runs/:runId/usage', async (request) => {
  const runId = cleanRunId(request.params.runId);
  return loadUsageSummary(ROOT, { runId });
});

app.get('/api/health', async () => ({
  service: 'proguide-test-viewer',
  version: PACKAGE_VERSION,
  capabilities: VIEWER_CAPABILITIES,
  root: ROOT,
  host: HOST,
  port: PORT,
  pid: process.pid,
  idle_timeout_ms: IDLE_TIMEOUT_MS
}));

app.post('/api/shutdown', async (request, reply) => {
  const requestedRoot = path.resolve(String(request.body?.root || ''));
  if (rootIdentity(requestedRoot) !== rootIdentity(ROOT)) {
    return reply.code(403).send({ error: 'root_mismatch' });
  }
  reply.send({ ok: true, pid: process.pid });
  setTimeout(() => {
    app.close()
      .catch(() => {})
      .finally(() => process.exit(0));
  }, 50);
});

app.post('/api/runs/:runId/cases', async (request, reply) => {
  cleanRunId(request.params.runId);
  return reply.code(410).send({ error: 'La edicion de casos no esta disponible en el visor. Envia casos actualizados por MCP.' });
});

app.post('/api/runs/:runId/execute', async (request, reply) => {
  cleanRunId(request.params.runId);
  return reply.code(410).send({ error: 'La ejecucion se dispara por MCP. Usa run_cases o execute_run.' });
});

app.get('/runs/:runId/events', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  let offset = 0;
  const eventsPath = path.join(ROOT, 'proguide_tests', 'runs', runId, 'events.jsonl');
  const timer = setInterval(async () => {
    try {
      const data = await fs.readFile(eventsPath, 'utf8');
      const next = data.slice(offset);
      offset = data.length;
      for (const line of next.split(/\r?\n/)) {
        if (line.trim()) {
          reply.raw.write(`data: ${line}\n\n`);
        }
      }
    } catch {
      // The file can appear after the browser subscribes.
    }
  }, 700);
  request.raw.on('close', () => clearInterval(timer));
});

app.get('/artifacts/:runId/*', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  const relative = request.params['*'] || '';
  const runDir = path.join(ROOT, 'proguide_tests', 'runs', runId);
  const baseDir = path.resolve(runDir);
  const target = path.resolve(baseDir, relative);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    return reply.code(403).send('Ruta no permitida.');
  }
  try {
    await fs.access(target);
  } catch {
    return reply.code(404).send('No encontrado.');
  }
  reply.type(contentType(target));
  return reply.send(createReadStream(target));
});

app.listen({ host: HOST, port: PORT }).then((address) => {
  console.log(`ProGuide Test Cases UI: ${address}`);
  console.log(`Workspace root: ${ROOT}`);
  scheduleIdleShutdown();
});

function scheduleIdleShutdown() {
  if (!IDLE_TIMEOUT_MS || activeRequests > 0) return;
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    app.close()
      .catch(() => {})
      .finally(() => process.exit(0));
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function clearIdleTimer() {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

async function readStepLog(runId, caseId) {
  const logsDir = path.join(ROOT, 'proguide_tests', 'runs', runId, 'step_logs');
  const baseDir = path.resolve(logsDir);
  const target = path.resolve(logsDir, `${caseId}.json`);
  if (!target.startsWith(baseDir + path.sep)) return null;
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}


function cleanRunId(value) {
  const runId = String(value || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw new Error('Run ID invalido.');
  return runId;
}

function cleanCaseId(value) {
  const caseId = String(value || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(caseId)) throw new Error('Case ID invalido.');
  return caseId;
}


function rootIdentity(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}



function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.log' || ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
