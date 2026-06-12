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

function renderRunsIndex(runs, usage) {
  return `
    <section class="tool-band reveal">
      <div class="tool-band-main">
        <span class="eyebrow">Resultados</span>
        <h1>Ejecuciones de pruebas</h1>
        <p class="muted run-meta">Los runs se crean y ejecutan desde MCP. Este visor muestra estado, evidencia y codigo generado.</p>
      </div>
      <div class="actions">
        <a class="button-link ghost" href="/usage">Uso LLM</a>
      </div>
    </section>
    ${renderUsageStrip(usage, { href: '/usage' })}
    <main class="grid detail">
      <section class="panel reveal" style="--delay:.05s">
        <header class="panel-head">
          <h2>Historial</h2>
          <p class="panel-sub">${runs.length} ${runs.length === 1 ? 'ejecucion guardada' : 'ejecuciones guardadas'}</p>
        </header>
        ${renderHistory(runs)}
      </section>
    </main>`;
}

function renderHistory(runs) {
  if (!runs.length) {
    return `
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">o</div>
        <p>Aun no hay ejecuciones guardadas.</p>
        <span class="muted">Tu primera corrida aparecera aqui.</span>
      </div>`;
  }
  return `
    <div class="table-wrap">
    <table>
      <thead><tr><th>Fecha</th><th>Proyecto</th><th>Usuario</th><th>Estado</th><th>URL</th><th>Casos</th><th></th></tr></thead>
      <tbody>
        ${runs.map((run) => `
          <tr>
            <td class="mono nowrap">${escapeHtml(run.created_at || '')}</td>
            <td class="truncate" title="${attr(run.project_name || run.app_name || '')}">${escapeHtml(run.project_name || run.app_name || '-')}</td>
            <td class="truncate" title="${attr(run.run_user_email || run.run_user_name || '')}">${escapeHtml(run.run_user_email || run.run_user_name || '-')}</td>
            <td>${renderBadge(run.status)}</td>
            <td class="truncate" title="${attr(run.base_url || '')}">${escapeHtml(run.base_url || '-')}</td>
            <td class="mono">${run.total_cases || 0}</td>
            <td><a class="row-link" href="/runs/${encodeURIComponent(run.id)}">Abrir<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>`;
}

function renderRunIdentity(run) {
  const items = [
    ['Proyecto', run.project_name || run.app_name || '-'],
    ['Usuario', run.run_user_email || run.run_user_name || '-'],
    ['Origen', run.run_source || '-'],
    ['Git', [run.git_branch, run.git_commit].filter(Boolean).join(' @ ') || '-']
  ];
  return `
    <section class="identity-strip reveal" style="--delay:.035s">
      ${items.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd title="${attr(value)}">${escapeHtml(value)}</dd>
        </div>`).join('')}
    </section>`;
}

function renderUsageStrip(usage, { href = '/usage' } = {}) {
  if (!usage?.entries_count) return '';
  return `
    <section class="usage-strip reveal" style="--delay:.03s">
      <div class="usage-strip-main">
        <span class="eyebrow">LLM</span>
        <strong>${escapeHtml(formatUsd(usage.estimated_cost_usd))}</strong>
        <span class="muted">${escapeHtml(formatTokens(usage.total_tokens))} tokens en ${usage.entries_count} llamada(s)</span>
      </div>
      <dl class="usage-strip-kv">
        <div><dt>Input</dt><dd>${escapeHtml(formatTokens(usage.input_tokens))}</dd></div>
        <div><dt>Output</dt><dd>${escapeHtml(formatTokens(usage.output_tokens))}</dd></div>
        <div><dt>Cache</dt><dd>${escapeHtml(formatTokens(usage.cache_creation_input_tokens + usage.cache_read_input_tokens))}</dd></div>
      </dl>
      <a class="row-link" href="${attr(href)}">Ver uso<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
    </section>`;
}

function renderUsageDashboard(usage, { runId = null } = {}) {
  const isRun = Boolean(runId);
  return `
    <section class="tool-band reveal">
      <div class="tool-band-main">
        <a class="back-link" href="${isRun ? `/runs/${encodeURIComponent(runId)}` : '/runs'}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H4M7 4.5 3.5 8 7 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>${isRun ? 'Run' : 'Runs'}</a>
        <span class="eyebrow">Costo estimado</span>
        <h1>Uso LLM</h1>
        <p class="muted run-meta">${isRun ? `<span class="mono">${escapeHtml(runId)}</span>` : 'Workspace local'}<span class="meta-sep">&middot;</span>${escapeHtml(usage.entries_count)} llamada(s)</p>
      </div>
      <div class="actions">
        ${isRun ? '<a class="button-link ghost" href="/usage">Workspace</a>' : ''}
      </div>
    </section>
    <main class="usage-page">
      ${renderUsageStats(usage)}
      ${usage.entries_count ? `
        <section class="usage-grid">
          <section class="panel reveal" style="--delay:.08s">
            <header class="panel-head"><h2>Por modelo</h2><p class="panel-sub">${usage.by_model.length} modelo(s)</p></header>
            ${renderUsageGroupTable(usage.by_model, 'Modelo')}
          </section>
          <section class="panel reveal" style="--delay:.12s">
            <header class="panel-head"><h2>${isRun ? 'Por proveedor' : 'Por run'}</h2><p class="panel-sub">${isRun ? usage.by_provider.length : usage.by_run.length} grupo(s)</p></header>
            ${isRun ? renderUsageGroupTable(usage.by_provider, 'Proveedor') : renderUsageGroupTable(usage.by_run, 'Run', { runLinks: true })}
          </section>
        </section>
        <section class="panel reveal" style="--delay:.16s">
          <header class="panel-head">
            <h2>Llamadas</h2>
            <p class="panel-sub">${escapeHtml(usage.pricing_note)}</p>
          </header>
          ${renderUsageEntriesTable(usage.entries, { showRun: !isRun })}
        </section>` : renderUsageEmpty()}
    </main>`;
}

function renderUsageStats(usage) {
  const stats = [
    ['Costo', formatUsd(usage.estimated_cost_usd), usage.unknown_cost_entries ? `${usage.unknown_cost_entries} sin estimar` : 'Estimacion local'],
    ['Total tokens', formatTokens(usage.total_tokens), `${usage.entries_count} llamada(s)`],
    ['Input', formatTokens(usage.input_tokens), `Cache read ${formatTokens(usage.cache_read_input_tokens)}`],
    ['Output', formatTokens(usage.output_tokens), `Cache write ${formatTokens(usage.cache_creation_input_tokens)}`]
  ];
  return `
    <section class="usage-stats reveal" style="--delay:.04s">
      ${stats.map(([label, value, hint]) => `
        <article class="usage-stat">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(hint)}</small>
        </article>`).join('')}
    </section>`;
}

function renderUsageEmpty() {
  return `
    <section class="panel reveal" style="--delay:.08s">
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">o</div>
        <p>Todavia no hay uso LLM registrado.</p>
        <span class="muted">Los proximos runs guardaran tokens y costo estimado automaticamente.</span>
      </div>
    </section>`;
}

function renderUsageGroupTable(groups, label, { runLinks = false } = {}) {
  if (!groups.length) return '<p class="muted">Sin datos.</p>';
  return `
    <div class="table-wrap">
      <table class="usage-table">
        <thead><tr><th>${escapeHtml(label)}</th><th>Llamadas</th><th>Tokens</th><th>Costo</th><th>Ultima</th></tr></thead>
        <tbody>
          ${groups.map((group) => {
            const title = runLinks && group.key !== 'sin_run'
              ? `<a href="/runs/${encodeURIComponent(group.key)}/usage">${escapeHtml(group.key)}</a>`
              : escapeHtml(group.key);
            return `
              <tr>
                <td class="mono">${title}</td>
                <td>${escapeHtml(group.entries_count)}</td>
                <td class="mono">${escapeHtml(formatTokens(group.total_tokens))}</td>
                <td class="mono">${escapeHtml(formatUsd(group.estimated_cost_usd))}</td>
                <td class="mono nowrap">${escapeHtml(shortDate(group.last_at))}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderUsageEntriesTable(entries, { showRun = true } = {}) {
  if (!entries.length) return '<p class="muted">Sin llamadas registradas.</p>';
  return `
    <div class="table-wrap">
      <table class="usage-table">
        <thead>
          <tr>
            <th>Fecha</th>${showRun ? '<th>Run</th>' : ''}
            <th>Modelo</th><th>Proposito</th><th>Input</th><th>Output</th><th>Cache</th><th>Costo</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry) => `
            <tr>
              <td class="mono nowrap">${escapeHtml(shortDate(entry.timestamp))}</td>
              ${showRun ? `<td class="mono">${entry.run_id ? `<a href="/runs/${encodeURIComponent(entry.run_id)}/usage">${escapeHtml(entry.run_id)}</a>` : '<span class="muted">-</span>'}</td>` : ''}
              <td><span class="usage-provider">${escapeHtml(entry.provider || 'llm')}</span><span class="mono usage-model">${escapeHtml(entry.model || '-')}</span></td>
              <td>${escapeHtml(entry.purpose || '-')}</td>
              <td class="mono">${escapeHtml(formatTokens(entry.usage.input_tokens))}</td>
              <td class="mono">${escapeHtml(formatTokens(entry.usage.output_tokens))}</td>
              <td class="mono">${escapeHtml(formatTokens(entry.usage.cache_creation_input_tokens + entry.usage.cache_read_input_tokens))}</td>
              <td class="mono">${escapeHtml(formatUsd(entry.estimated_cost_usd))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderBadge(status) {
  const label = String(status || '').replace(/_/g, ' ');
  const indicator = isActiveStatus(status) ? '<i class="status-spinner"></i>' : '<i class="badge-dot"></i>';
  return `<span class="badge ${escapeHtml(statusClass(status))}">${indicator}${escapeHtml(label || '-')}</span>`;
}

function statusClass(status) {
  return String(status || 'pending').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'pending';
}

function isActiveStatus(status) {
  return ['running', 'executing', 'ejecutando', 'queued', 'started', 'generating', 'interpreting'].includes(statusClass(status));
}

function renderRunDetail(run, cases, summary, usage) {
  return `
    <section class="tool-band reveal">
      <div class="tool-band-main">
        <a class="back-link" href="/"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H4M7 4.5 3.5 8 7 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Inicio</a>
        <h1>Ejecucion ${renderBadge(run.status)}</h1>
        <p class="muted run-meta"><span class="mono">${escapeHtml(run.id)}</span>${run.base_url ? `<span class="meta-sep">·</span><a href="${attr(run.base_url)}" target="_blank" rel="noreferrer">${escapeHtml(run.base_url)}</a>` : ''}</p>
      </div>
      <div class="actions">
        <a class="button-link ghost" href="/runs/${encodeURIComponent(run.id)}/usage">Uso LLM</a>
        ${run.html_path ? `<a class="button-link ghost" href="/artifacts/${encodeURIComponent(run.id)}/${encodeURIComponent(run.html_path)}">Reporte HTML</a>` : ''}
        ${run.pdf_path ? `<a class="button-link ghost" href="/artifacts/${encodeURIComponent(run.id)}/${encodeURIComponent(run.pdf_path)}">PDF</a>` : ''}
      </div>
    </section>
    ${renderUsageStrip(usage, { href: `/runs/${encodeURIComponent(run.id)}/usage` })}
    ${renderRunIdentity(run)}
    ${renderRunProgress(run, cases, summary)}
    <main class="grid detail">
      <section class="panel cases-panel reveal" style="--delay:.05s">
        <header class="panel-head"><h2>Casos</h2><p class="panel-sub">${cases.length} ${cases.length === 1 ? 'caso' : 'casos'}</p></header>
        <div class="table-wrap">
        <table id="casesTable">
          <thead><tr><th class="col-n">N</th><th>Test</th><th>Estado</th><th>Resultado</th><th>Evidencia</th><th>Codigo</th></tr></thead>
          <tbody>
            ${cases.map((testCase) => renderCaseRow(testCase, summary, run)).join('')}
          </tbody>
        </table>
        </div>
      </section>
    </main>
    <script>
      const runId = ${JSON.stringify(run.id)};
      ${clientRunScript()}
    </script>`;
}

function renderRunProgress(run, cases, summary) {
  const state = initialRunProgress(run, summary);
  return `
    <section id="runProgress" class="run-progress reveal ${state.active ? 'is-active' : ''} ${state.done ? 'is-done' : ''} ${state.error ? 'is-error' : ''}" style="--delay:.04s; --progress:${state.percent}%;" data-stage="${attr(state.stage)}" data-status="${attr(state.status)}">
      <div class="run-progress-main">
        <div class="run-progress-kicker">
          <span class="eyebrow">Live run</span>
          <span id="runProgressBadge">${renderBadge(state.status)}</span>
        </div>
        <h2 id="runProgressTitle">${escapeHtml(state.title)}</h2>
        <p id="runProgressMessage" class="muted">${escapeHtml(state.message)}</p>
      </div>
      <div class="run-progress-track" aria-hidden="true"><span></span></div>
      <div class="run-progress-steps" aria-label="Progreso de ejecucion">
        ${progressStepsMarkup(state.stage, state)}
      </div>
      <div class="run-progress-counts mono" aria-label="Resumen de casos">
        ${escapeHtml(progressCounts(cases, summary))}
      </div>
    </section>`;
}

function renderCaseRow(testCase, summary, run) {
  const result = findCaseResult(summary, testCase.id);
  const runnable = isRunnableCase(testCase);
  const status = initialCaseStatus(testCase, result, run);
  const message = initialCaseMessage(testCase, result, run);
  const detailHref = `/runs/${encodeURIComponent(run.id)}/cases/${encodeURIComponent(testCase.id)}`;
  const evidence = renderEvidenceLinks(result, run.id);
  return `
    <tr class="case-row ${isActiveStatus(status) ? 'is-live' : ''}" data-case-id="${attr(testCase.id)}" data-runnable="${runnable ? '1' : '0'}" data-status="${attr(status)}" data-href="${attr(detailHref)}" tabindex="0" aria-label="Abrir detalle de ${attr(cleanCaseTitle(testCase.title))}">
      <td class="col-n mono">${testCase.number}</td>
      <td class="case-title"><a class="case-title-link" href="${attr(detailHref)}">${escapeHtml(cleanCaseTitle(testCase.title))}</a></td>
      <td class="status-cell">${renderBadge(status)}</td>
      <td class="message-cell">${escapeHtml(message)}</td>
      <td class="evidence-cell">${evidence || '<span class="muted">-</span>'}</td>
      <td class="code-cell">
        <a class="chip-link" href="${attr(detailHref)}#codigo-python">Python</a>
        <a class="chip-link" href="${attr(detailHref)}#codigo-typescript">TS</a>
      </td>
    </tr>`;
}

function initialCaseStatus(testCase, result, run) {
  if (result?.status) return result.status;
  if (isRunnableCase(testCase) && isExecutionActive(run.status)) return 'queued';
  return testCase.automation_state || 'pending';
}

function initialCaseMessage(testCase, result, run) {
  if (result?.message) return result.message;
  if (isRunnableCase(testCase) && isExecutionActive(run.status)) return 'Esperando worker disponible...';
  return testCase.state_reason || '';
}

function isRunnableCase(testCase) {
  return testCase.automation_state === 'listo' && !testCase.excluded;
}

function isExecutionActive(status) {
  return ['running', 'executing', 'ejecutando', 'queued', 'started'].includes(statusClass(status));
}

const PROGRESS_STEPS = [
  ['plan', 'Plan'],
  ['dom', 'Browser'],
  ['code', 'Codigo'],
  ['tests', 'Tests'],
  ['report', 'Reporte']
];

function initialRunProgress(run, summary) {
  const status = statusClass(run.status);
  const counts = countSummary(summary);
  if (['passed', 'failed', 'finished', 'inconclusive', 'setup_failed', 'blocked'].includes(status)) {
    return {
      stage: 'report',
      status: run.status || 'finished',
      title: 'Run finalizado',
      message: progressFinishedMessage(counts, run),
      percent: 100,
      done: true,
      active: false,
      error: status === 'setup_failed'
    };
  }
  if (status === 'error') {
    return {
      stage: 'report',
      status: 'error',
      title: 'Run detenido',
      message: 'Se produjo un error durante la ejecucion.',
      percent: 100,
      done: false,
      active: false,
      error: true
    };
  }
  if (status === 'running') {
    return {
      stage: 'tests',
      status: 'running',
      title: 'Ejecutando tests en browser',
      message: 'Los casos listos se estan distribuyendo entre workers.',
      percent: 78,
      active: true
    };
  }
  if (status === 'generating') {
    return {
      stage: 'code',
      status: 'generating',
      title: 'Preparando automatizacion',
      message: 'ProGuide esta recolectando contexto y generando codigo Playwright.',
      percent: 48,
      active: true
    };
  }
  return {
    stage: 'plan',
    status: run.status || 'ready',
    title: 'Run listo para ejecutar',
    message: 'El visor se actualizara automaticamente cuando empiece la ejecucion.',
    percent: 8,
    active: false
  };
}

function progressStepsMarkup(activeStage, state) {
  const activeIndex = PROGRESS_STEPS.findIndex(([key]) => key === activeStage);
  return PROGRESS_STEPS.map(([key, label], index) => {
    const className = [
      'run-progress-step',
      index < activeIndex || state.done ? 'is-done' : '',
      index === activeIndex && state.active ? 'is-active' : '',
      index === activeIndex && state.error ? 'is-error' : ''
    ].filter(Boolean).join(' ');
    return `<span class="${className}" data-progress-step="${attr(key)}"><i></i>${escapeHtml(label)}</span>`;
  }).join('');
}

function progressCounts(cases, summary) {
  const counts = countSummary(summary);
  const total = cases.length || counts.total || 0;
  const done = counts.passed + counts.failed + counts.inconclusive + counts.setup_failed;
  return `${done}/${total} casos con resultado`;
}

function progressFinishedMessage(counts, run) {
  const total = Number(run.total_cases || counts.total || 0);
  const passed = Number(run.passed ?? counts.passed ?? 0);
  const failed = Number(run.failed ?? counts.failed ?? 0);
  const inconclusive = Number(run.inconclusive ?? counts.inconclusive ?? 0);
  const setupFailed = Number(run.setup_failed ?? counts.setup_failed ?? 0);
  return `Resultados: ${passed} passed, ${failed} failed, ${inconclusive} inconclusive, ${setupFailed} setup_failed de ${total}.`;
}

function countSummary(summary) {
  return (summary?.results || []).reduce((acc, result) => {
    acc.total += 1;
    if (result.status === 'passed') acc.passed += 1;
    else if (result.status === 'failed') acc.failed += 1;
    else if (result.status === 'setup_failed') acc.setup_failed += 1;
    else acc.inconclusive += 1;
    return acc;
  }, { total: 0, passed: 0, failed: 0, inconclusive: 0, setup_failed: 0 });
}

function renderCaseDetail(run, testCase, summary, stepLog, generatedCode) {
  const result = findCaseResult(summary, testCase.id);
  const status = result?.status || testCase.automation_state || 'pending';
  const evidence = renderEvidenceLinks(result, run.id);
  const firstScreenshot = result?.screenshots?.[0] || '';
  const detailItems = [
    ['Estado', renderBadge(status)],
    ['Ruta', escapeHtml(testCase.route || '-')],
    ['Duracion', escapeHtml(formatSeconds(result?.duration_seconds))],
    ['ID', `<span class="mono">${escapeHtml(testCase.id)}</span>`],
  ];
  if (testCase.ticket) detailItems.push(['Ticket', escapeHtml(testCase.ticket)]);
  if (testCase.qa_owner) detailItems.push(['QA', escapeHtml(testCase.qa_owner)]);
  if (testCase.dev_owner) detailItems.push(['Dev', escapeHtml(testCase.dev_owner)]);

  return `
    <section class="tool-band reveal">
      <div class="tool-band-main">
        <a class="back-link" href="/runs/${encodeURIComponent(run.id)}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H4M7 4.5 3.5 8 7 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Casos</a>
        <h1>Caso ${escapeHtml(testCase.number)} ${renderBadge(status)}</h1>
        <p class="muted run-meta"><span class="mono">${escapeHtml(run.id)}</span>${run.base_url ? `<span class="meta-sep">·</span><a href="${attr(run.base_url)}" target="_blank" rel="noreferrer">${escapeHtml(run.base_url)}</a>` : ''}</p>
      </div>
      <div class="actions">
        ${evidence || ''}
        ${run.html_path ? `<a class="button-link ghost" href="/artifacts/${encodeURIComponent(run.id)}/${encodeURIComponent(run.html_path)}">Reporte HTML</a>` : ''}
      </div>
    </section>
    <main class="grid case-detail-grid">
      <section class="panel reveal" style="--delay:.05s">
        <header class="case-detail-head">
          <span class="eyebrow">Detalle del test</span>
          <h2>${escapeHtml(cleanCaseTitle(testCase.title))}</h2>
          ${testCase.description ? `<p class="detail-lede">${escapeHtml(testCase.description)}</p>` : ''}
        </header>
        ${result?.message ? `<div class="result-note ${escapeHtml(statusClass(status))}"><strong>Resultado</strong><p>${escapeHtml(result.message)}</p></div>` : ''}
        <section class="detail-section">
          <h3>Pasos ejecutados</h3>
          ${renderStepTimeline(testCase, result, stepLog)}
        </section>
        <section class="detail-section">
          <h3>Resultado esperado</h3>
          ${renderList(testCase.expected_results || result?.expected || [], 'Sin resultado esperado registrado.')}
        </section>
        <section class="detail-section code-section" id="codigo-playwright">
          ${renderCodeTabs(generatedCode, testCase, run)}
        </section>
      </section>
      <aside class="detail-side">
        <section class="panel reveal" style="--delay:.1s">
          <header class="panel-head"><h2>Resumen</h2></header>
          <dl class="detail-kv">
            ${detailItems.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join('')}
          </dl>
        </section>
        <section class="panel reveal" style="--delay:.15s">
          <header class="panel-head"><h2>Evidencia</h2></header>
          ${firstScreenshot ? `<a class="evidence-preview" href="${attr(artifactHref(run.id, firstScreenshot))}"><img src="${attr(artifactHref(run.id, firstScreenshot))}" alt="Screenshot del caso ${attr(testCase.number)}"></a>` : '<p class="muted">Todavia no hay screenshot para este caso.</p>'}
          <div class="evidence-actions">${evidence || '<span class="muted">Sin archivos de evidencia.</span>'}</div>
        </section>
        <section class="panel reveal" style="--delay:.2s">
          <header class="panel-head"><h2>Datos y condiciones</h2></header>
          <div class="detail-section compact">
            <h3>Precondiciones</h3>
            ${renderList(testCase.preconditions || [], 'Sin precondiciones registradas.')}
          </div>
          <div class="detail-section compact">
            <h3>Datos usados</h3>
            ${renderList(testCase.data_used || [], 'Sin datos registrados.')}
          </div>
        </section>
      </aside>
    </main>
    <script>${codeTabsScript()}</script>`;
}

function findCaseResult(summary, caseId) {
  return (summary?.results || []).find((item) => item.id === caseId);
}

function artifactHref(runId, relativePath) {
  return `/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(relativePath)}`;
}

function renderEvidenceLinks(result, runId) {
  if (!result) return '';
  const evidence = [];
  for (const screenshot of result.screenshots || []) {
    evidence.push(`<a class="chip-link" href="${attr(artifactHref(runId, screenshot))}">Screenshot</a>`);
  }
  for (const video of result.videos || []) {
    evidence.push(`<a class="chip-link" href="${attr(artifactHref(runId, video))}">Video</a>`);
  }
  for (const trace of result.traces || []) {
    evidence.push(`<a class="chip-link" href="${attr(artifactHref(runId, trace))}">Trace</a>`);
  }
  return evidence.join('');
}

function renderCodeTabs(generatedCode, testCase, run) {
  const typeScriptCode = {
    code: buildTypeScriptCode(testCase, run),
    path: `generated/${safeName(testCase.id || 'case')}.spec.ts`
  };
  return `
    <div class="code-section-head">
      <h3>Codigo Playwright</h3>
      <div class="code-tabs" role="tablist" aria-label="Lenguaje del codigo generado" data-code-tabs>
        <button class="code-tab is-active" type="button" role="tab" id="tab-codigo-python" aria-selected="true" aria-controls="codigo-python" data-tab-target="codigo-python">Python</button>
        <button class="code-tab" type="button" role="tab" id="tab-codigo-typescript" aria-selected="false" aria-controls="codigo-typescript" data-tab-target="codigo-typescript">TypeScript</button>
      </div>
    </div>
    <div class="code-panels">
      <div class="code-panel is-active" id="codigo-python" role="tabpanel" aria-labelledby="tab-codigo-python">
        ${renderCodeBlock(generatedCode, 'El codigo Python se genera cuando ejecutas el run.', 'generated/test_markdown_cases.py', 'python')}
      </div>
      <div class="code-panel" id="codigo-typescript" role="tabpanel" aria-labelledby="tab-codigo-typescript" hidden>
        ${renderCodeBlock(typeScriptCode, 'No hay datos suficientes para generar el ejemplo TypeScript.', `generated/${safeName(testCase.id || 'case')}.spec.ts`, 'typescript')}
      </div>
    </div>`;
}

function renderCodeBlock(codeData, emptyText, fallbackPath, language) {
  if (!codeData?.code) {
    return `
      <div class="code-empty">
        <p class="muted">${escapeHtml(emptyText)}</p>
      </div>`;
  }
  return `
    <div class="code-block">
      <div class="code-block-head">
        <span class="mono">${escapeHtml(codeData.path || fallbackPath)}</span>
        <span class="code-lang">${escapeHtml(language === 'typescript' ? 'TypeScript' : 'Python')}</span>
      </div>
      <pre class="code-editor language-${escapeHtml(language)}"><code>${highlightCode(codeData.code, language)}</code></pre>
    </div>`;
}

function highlightCode(code, language) {
  return String(code || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `<span class="code-line">${highlightCodeLine(line, language) || '&nbsp;'}</span>`)
    .join('');
}

function highlightCodeLine(line, language) {
  const tokens = [];
  const keywordSet = codeKeywords(language);
  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    if (language === 'python' && rest.startsWith('#')) {
      tokens.push(token('comment', rest));
      break;
    }
    if (language === 'typescript' && rest.startsWith('//')) {
      tokens.push(token('comment', rest));
      break;
    }
    if (language === 'typescript' && rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      const comment = end >= 0 ? rest.slice(0, end + 2) : rest;
      tokens.push(token('comment', comment));
      index += comment.length;
      continue;
    }

    const quote = line[index];
    if (quote === '"' || quote === "'" || (language === 'typescript' && quote === '`')) {
      const value = readQuoted(line, index, quote);
      tokens.push(token('string', value));
      index += value.length;
      continue;
    }

    const numberMatch = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (numberMatch) {
      tokens.push(token('number', numberMatch[0]));
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (identifierMatch) {
      const value = identifierMatch[0];
      if (keywordSet.has(value)) {
        tokens.push(token('keyword', value));
      } else if (rest.slice(value.length).trimStart().startsWith('(')) {
        tokens.push(token('function', value));
      } else {
        tokens.push(escapeHtml(value));
      }
      index += value.length;
      continue;
    }

    const punctuationMatch = rest.match(/^[{}()[\].,;:+\-*/%=<>!|&?]+/);
    if (punctuationMatch) {
      tokens.push(token('punctuation', punctuationMatch[0]));
      index += punctuationMatch[0].length;
      continue;
    }

    tokens.push(escapeHtml(line[index]));
    index += 1;
  }
  return tokens.join('');
}

function readQuoted(line, start, quote) {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      index += 1;
      break;
    }
    index += 1;
  }
  return line.slice(start, index);
}

function token(kind, value) {
  return `<span class="tok-${kind}">${escapeHtml(value)}</span>`;
}

function codeKeywords(language) {
  if (language === 'python') {
    return new Set([
      'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
      'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
      'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
      'raise', 'return', 'try', 'while', 'with', 'yield'
    ]);
  }
  return new Set([
    'as', 'async', 'await', 'break', 'catch', 'class', 'const', 'continue', 'default',
    'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
    'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of',
    'return', 'throw', 'true', 'try', 'type', 'undefined', 'var', 'while'
  ]);
}

function buildTypeScriptCode(testCase, run) {
  const steps = (testCase.executable_steps || [])
    .map((step) => step.normalized_action || step.original_text)
    .filter(Boolean);
  const expected = (testCase.expected_results || []).filter(Boolean);
  const route = testCase.route || '/';
  const baseUrl = run.base_url || 'http://localhost:3000';
  const user = testCase.data?.user || {};
  const lines = [
    "import { test, expect, type Locator, type Page } from '@playwright/test';",
    '',
    `test(${jsString(cleanCaseTitle(testCase.title) || testCase.id || 'ProGuide case')}, async ({ page }) => {`,
    `  const baseUrl = process.env.PROGUIDE_BASE_URL ?? ${jsString(baseUrl)};`,
    '  const user = {',
    `    email: process.env.PROGUIDE_USER_EMAIL ?? ${jsString(user.email || 'test@example.com')},`,
    `    username: process.env.PROGUIDE_USER_USERNAME ?? ${jsString(user.username || user.email || 'test@example.com')},`,
    "    password: process.env.PROGUIDE_USER_PASSWORD ?? 'password123',",
    '  };',
    ''
  ];

  let hasNavigation = false;
  const actionBlocks = [];
  for (const step of steps) {
    const rendered = renderTypeScriptAction(step, route);
    hasNavigation ||= rendered.navigates;
    actionBlocks.push(...rendered.lines);
  }
  if (!hasNavigation && route) {
    lines.push(`  await goto(page, baseUrl, ${jsString(route)});`, '');
  }
  lines.push(...actionBlocks);
  for (const item of expected) {
    lines.push(...renderTypeScriptExpectation(item));
  }
  if (!steps.length && !expected.length) {
    lines.push('  await expect(page.locator("body")).toBeVisible({ timeout: 10000 });');
  }
  lines.push('});', '', ...typeScriptHelperLines());
  return lines.join('\n') + '\n';
}

function renderTypeScriptAction(step, caseRoute) {
  const text = String(step || '').trim();
  const normalized = text.toLowerCase();
  const lines = [`  // ${tsComment(text)}`];

  const fillMatch = text.match(/^\s*fill\s+\[([^\]]+)\]\s+(?:with\s+)?(.+?)\s*$/i);
  if (fillMatch) {
    lines.push(`  await page.locator(${jsString(selectorFromBracket(fillMatch[1]))}).first().fill(${jsString(stripQuotes(fillMatch[2].trim()))}, { timeout: 5000 });`, '');
    return { lines, navigates: false };
  }

  const clickMatch = text.match(/^\s*click\s+\[([^\]]+)\]\s*$/i);
  if (clickMatch) {
    lines.push(`  await page.locator(${jsString(selectorFromBracket(clickMatch[1]))}).first().click({ timeout: 5000 });`);
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  const textExpectation = renderExplicitTextExpectation(text, '  ');
  if (textExpectation.length) {
    lines.push(...textExpectation, '');
    return { lines, navigates: false };
  }

  const route = routeFromStep(text);
  if (route || /\b(go to|open|navigate|visitar|abrir|navegar)\b/i.test(text)) {
    const targetRoute = route && route !== '/' ? route : caseRoute || '/';
    lines.push(`  await goto(page, baseUrl, ${jsString(targetRoute)});`, '');
    return { lines, navigates: true };
  }

  if (normalized.includes('refresh') || normalized.includes('recargar')) {
    lines.push('  await page.reload();');
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  if ((normalized.includes('empty') || normalized.includes('vacio')) && /email|correo/.test(normalized)) {
    lines.push("  await fillEmail(page, '');", '');
    return { lines, navigates: false };
  }

  if (/email|e-mail|correo|username|usuario|user/.test(normalized)) {
    const value = /invalid|invalido|malformado|incorrecto/.test(normalized) ? "'invalid-email'" : 'user.email';
    lines.push(`  await fillEmail(page, ${value});`, '');
    return { lines, navigates: false };
  }

  if (/password|pass|clave|contrasena|contrase/.test(normalized)) {
    const value = /invalid|invalido|corta|corto|incorrecto/.test(normalized) ? "'123'" : 'user.password';
    lines.push(`  await fillPassword(page, ${value});`, '');
    return { lines, navigates: false };
  }

  const clickTarget = clickTargetFromStep(text);
  if (clickTarget) {
    lines.push(`  await clickByText(page, ${jsString(clickTarget)});`);
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  if (/submit|login|ingresar|enviar|continuar|iniciar sesion/.test(normalized)) {
    lines.push('  await clickSubmit(page);');
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  lines.push('  // TODO: ajustar este paso con selectores reales si hace falta.', '');
  return { lines, navigates: false };
}

function renderTypeScriptExpectation(expected) {
  const text = String(expected || '').trim();
  const normalized = text.toLowerCase();
  const lines = [`  // assert: ${tsComment(text)}`];
  const explicit = renderExplicitTextExpectation(text, '  ');
  if (explicit.length) return [...lines, ...explicit, ''];

  const notShowsMatch = text.match(/(?:page\s+does\s+not\s+show|does\s+not\s+show|not\s+visible|pagina\s+no\s+muestra|no\s+se\s+muestra)\s+(.+)/i);
  if (notShowsMatch) {
    lines.push(`  await expect(page.getByText(new RegExp(escapeRegExp(${jsString(notShowsMatch[1].trim())}), 'i'))).toHaveCount(0, { timeout: 10000 });`, '');
    return lines;
  }

  const containsMatch = normalized.match(/(?:url\s+contains|url\s+contiene|la\s+url\s+contiene)\s+(\S+)/);
  if (containsMatch) {
    lines.push(`  await expect(page).toHaveURL(new RegExp(${jsString(`.*${escapeRegex(containsMatch[1].trim())}.*`)}, 'i'), { timeout: 10000 });`, '');
    return lines;
  }

  const showsMatch = text.match(/(?:page\s+shows|shows|pagina\s+muestra|la\s+pagina\s+muestra|se\s+muestra|muestra|visible)\s+(.+)/i);
  if (showsMatch && showsMatch[1].trim().length > 1) {
    lines.push(`  await expect(textLocator(page, ${jsString(showsMatch[1].trim())})).toBeVisible({ timeout: 10000 });`, '');
    return lines;
  }

  const storageExistsMatch = text.match(/localStorage\s+key\s+["'](.+?)["']\s+exists/i);
  if (storageExistsMatch) {
    lines.push(`  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), ${jsString(storageExistsMatch[1].trim())})).not.toBeNull();`, '');
    return lines;
  }

  const storageMissingMatch = text.match(/localStorage\s+key\s+["'](.+?)["']\s+does\s+not\s+exist/i);
  if (storageMissingMatch) {
    lines.push(`  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), ${jsString(storageMissingMatch[1].trim())})).toBeNull();`, '');
    return lines;
  }

  if (normalized.includes('session email displayed correctly')) {
    lines.push('  await expect(textLocator(page, user.email)).toBeVisible({ timeout: 10000 });', '');
    return lines;
  }

  if (normalized.includes('login form is visible') || normalized.includes('login screen')) {
    lines.push('  await expect(page.locator("input").first()).toBeVisible({ timeout: 10000 });', '');
    return lines;
  }

  if (/redirect|home|dashboard|inicio/.test(normalized)) {
    lines.push("  await expect(page).toHaveURL(/.*(home|dashboard|app|inicio).*/i, { timeout: 10000 });", '');
    return lines;
  }

  if (/error|validation|invalid|invalido|incorrecto/.test(normalized)) {
    lines.push("  await expect(page.getByText(/error|required|invalid|incorrect|obligatorio|invalido|incorrecto|ingresa|email|contrasena/i).first()).toBeVisible({ timeout: 10000 });", '');
    return lines;
  }

  lines.push('  await expect(page.locator("body")).toBeVisible({ timeout: 10000 });', '');
  return lines;
}

function renderExplicitTextExpectation(text, indent) {
  const textMatch = text.match(/^\s*expect\s+text\s+["'](.+?)["']\s*$/i);
  if (textMatch) {
    return [`${indent}await expect(textLocator(page, ${jsString(textMatch[1].trim())})).toBeVisible({ timeout: 10000 });`];
  }
  const visibleMatch = text.match(/^\s*expect\s+\[([^\]]+)\]\s+(?:to\s+be\s+)?visible\s*$/i);
  if (visibleMatch) {
    return [`${indent}await expect(page.locator(${jsString(selectorFromBracket(visibleMatch[1]))}).first()).toBeVisible({ timeout: 10000 });`];
  }
  const containsMatch = text.match(/^\s*expect\s+\[([^\]]+)\]\s+to\s+contain\s+text\s+["'](.+?)["']\s*$/i);
  if (containsMatch) {
    return [`${indent}await expect(page.locator(${jsString(selectorFromBracket(containsMatch[1]))}).first()).toContainText(${jsString(containsMatch[2].trim())}, { timeout: 10000 });`];
  }
  return [];
}

function typeScriptHelperLines() {
  return [
    'async function goto(page: Page, baseUrl: string, route: string) {',
    "  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;",
    "  const normalizedRoute = route.startsWith('/') ? route.slice(1) : route;",
    '  await page.goto(new URL(normalizedRoute, base).toString());',
    "  await page.waitForLoadState('domcontentloaded');",
    '}',
    '',
    'async function fillEmail(page: Page, value: string) {',
    '  await fillFirst([',
    '    page.getByLabel(/email|e-mail|correo|usuario|user/i),',
    '    page.getByPlaceholder(/email|e-mail|correo|usuario|user/i),',
    '    page.locator("input[type=\'email\']"),',
    '    page.locator("input[name*=\'email\' i]"),',
    '    page.locator("input[name*=\'user\' i]"),',
    '    page.locator("input[autocomplete=\'username\']"),',
    '    page.locator("input").first(),',
    '  ], value);',
    '}',
    '',
    'async function fillPassword(page: Page, value: string) {',
    '  await fillFirst([',
    '    page.getByLabel(/password|pass|clave|contrasena/i),',
    '    page.getByPlaceholder(/password|pass|clave|contrasena/i),',
    '    page.locator("input[type=\'password\']"),',
    '    page.locator("input[name*=\'password\' i]"),',
    '    page.locator("input[autocomplete=\'current-password\']"),',
    '  ], value);',
    '}',
    '',
    'async function clickSubmit(page: Page) {',
    '  await clickFirst([',
    '    page.getByRole("button", { name: /submit|login|log in|sign in|ingresar|iniciar|entrar|acceder|continuar|enviar/i }),',
    '    page.locator("button[type=\'submit\']"),',
    '    page.locator("input[type=\'submit\']"),',
    '    page.locator("button").first(),',
    '  ]);',
    '}',
    '',
    'async function clickByText(page: Page, label: string) {',
    '  await clickFirst([',
    "    page.getByRole('button', { name: new RegExp(escapeRegExp(label), 'i') }),",
    "    page.getByText(new RegExp(escapeRegExp(label), 'i')),",
    '  ]);',
    '}',
    '',
    'async function fillFirst(locators: Locator[], value: string) {',
    '  for (const locator of locators) {',
    '    if (await hasVisible(locator)) {',
    '      await locator.first().fill(value, { timeout: 5000 });',
    '      return;',
    '    }',
    '  }',
    "  throw new Error('Could not find a visible input to fill.');",
    '}',
    '',
    'async function clickFirst(locators: Locator[]) {',
    '  for (const locator of locators) {',
    '    if (await hasVisible(locator)) {',
    '      await locator.first().click({ timeout: 5000 });',
    '      return;',
    '    }',
    '  }',
    "  throw new Error('Could not find a visible target to click.');",
    '}',
    '',
    'async function hasVisible(locator: Locator) {',
    '  try {',
    '    return await locator.first().isVisible({ timeout: 1000 });',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    'function textLocator(page: Page, value: string) {',
    "  return page.getByText(new RegExp(escapeRegExp(value), 'i')).first();",
    '}',
    '',
    'function escapeRegExp(value: string) {',
    "  return value.split('').map((char) => '\\\\^$.*+?()[]{}|'.includes(char) ? `\\\\${char}` : char).join('');",
    '}'
  ];
}

function routeFromStep(step) {
  const match = String(step || '').match(/(?:go to|open|navigate to|visitar|abrir|navegar(?:\s+a)?|ir\s+a)\s+(\S+)/i);
  if (!match) return '';
  const value = stripQuotes(match[1].trim().replace(/[.,;:]+$/, ''));
  if (['login', 'home', 'homepage', 'page', 'pagina'].includes(value.toLowerCase())) return '';
  return value;
}

function clickTargetFromStep(step) {
  const match = String(step || '').trim().match(/^click\s+(?:button\s+)?["']?([^"']+?)["']?$/i);
  if (!match) return '';
  const target = match[1].trim();
  if (!target || ['submit', 'form', 'button'].includes(target.toLowerCase())) return '';
  return target;
}

function selectorFromBracket(value) {
  const selector = String(value || '').trim();
  if (!selector) return '';
  if (/^(#|\.|\[|:|\*)/.test(selector) || /\s|>|\+|~/.test(selector)) return selector;
  if (/^[a-z][a-z0-9_-]*\[[^\]]+\]$/i.test(selector)) return selector;
  if (['a', 'button', 'form', 'input', 'select', 'textarea', 'div', 'span', 'label', 'main', 'section'].includes(selector.toLowerCase())) {
    return selector;
  }

  const attrMatch = selector.match(/^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(.+)$/);
  if (attrMatch) {
    return `[${attrMatch[1]}="${cssAttrValue(stripQuotes(attrMatch[2].trim()))}"]`;
  }

  return `[data-testid="${cssAttrValue(selector)}"]`;
}

function stripQuotes(value) {
  const text = String(value || '');
  if (text.length >= 2 && text[0] === text.at(-1) && ['"', "'"].includes(text[0])) {
    return text.slice(1, -1);
  }
  return text;
}

function cssAttrValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tsComment(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim();
}

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPriorityBadge(value) {
  const meta = priorityMeta(value);
  return `<span class="priority-pill priority-${escapeHtml(meta.key)}">${escapeHtml(meta.label)}</span>`;
}

function priorityMeta(value) {
  const normalized = String(value || 'media')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  const aliases = {
    low: 'baja',
    baja: 'baja',
    medium: 'media',
    media: 'media',
    high: 'alta',
    alta: 'alta',
    critical: 'critica',
    critica: 'critica',
    bloqueante: 'critica'
  };
  const key = aliases[normalized] || 'media';
  const labels = {
    baja: 'Baja',
    media: 'Media',
    alta: 'Alta',
    critica: 'Critica'
  };
  return { key, label: labels[key] || labels.media };
}

function renderList(items, emptyText) {
  const values = (items || []).filter((item) => String(item || '').trim());
  if (!values.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<ul class="detail-list">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderStepTimeline(testCase, result, stepLog) {
  const loggedSteps = (stepLog?.steps || []).filter((item) => item && item.step);
  if (loggedSteps.length) {
    return `<ol class="timeline">${loggedSteps.map((item) => `
      <li class="timeline-item ${escapeHtml(statusClass(item.status))}">
        <span class="timeline-status">${escapeHtml(item.status || 'step')}</span>
        <div>
          <p>${escapeHtml(item.step)}</p>
          ${item.message ? `<small>${escapeHtml(item.message)}</small>` : ''}
        </div>
      </li>`).join('')}</ol>`;
  }

  const resultSteps = (result?.steps || []).filter(Boolean);
  if (resultSteps.length) {
    return `<ol class="timeline">${resultSteps.map((step) => `
      <li class="timeline-item">
        <span class="timeline-status">step</span>
        <div><p>${escapeHtml(step)}</p></div>
      </li>`).join('')}</ol>`;
  }

  const plannedSteps = (testCase.executable_steps || []).map((step) => step.normalized_action || step.original_text).filter(Boolean);
  const fallbackSteps = plannedSteps.length ? plannedSteps : (testCase.original_steps || []);
  if (!fallbackSteps.length) return '<p class="muted">Sin pasos registrados.</p>';
  return `<ol class="timeline">${fallbackSteps.map((step) => `
    <li class="timeline-item pending">
      <span class="timeline-status">plan</span>
      <div><p>${escapeHtml(step)}</p></div>
    </li>`).join('')}</ol>`;
}

function formatSeconds(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

function formatTokens(value) {
  const number = Math.round(Number(value || 0));
  if (!Number.isFinite(number) || number <= 0) return '0';
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Sin estimar';
  const number = Number(value);
  const digits = number > 0 && number < 0.01 ? 6 : (number < 1 ? 4 : 2);
  return `USD ${number.toFixed(digits)}`;
}

function shortDate(value) {
  const text = String(value || '');
  if (!text) return '-';
  return text.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function codeTabsScript() {
  return `
      (() => {
        const tabs = document.querySelector('[data-code-tabs]');
        if (!tabs) return;
        const buttons = Array.from(tabs.querySelectorAll('[data-tab-target]'));
        const panels = Array.from(document.querySelectorAll('.code-panel'));
        const activate = (targetId, updateHash = false) => {
          const target = panels.find((panel) => panel.id === targetId) ? targetId : 'codigo-python';
          for (const button of buttons) {
            const selected = button.dataset.tabTarget === target;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
          }
          for (const panel of panels) {
            const selected = panel.id === target;
            panel.hidden = !selected;
            panel.classList.toggle('is-active', selected);
          }
          if (updateHash) history.replaceState(null, '', '#' + target);
        };
        for (const button of buttons) {
          button.addEventListener('click', () => activate(button.dataset.tabTarget, true));
        }
        activate(location.hash === '#codigo-typescript' ? 'codigo-typescript' : 'codigo-python', false);
        window.addEventListener('hashchange', () => {
          activate(location.hash === '#codigo-typescript' ? 'codigo-typescript' : 'codigo-python', false);
        });
      })();
    `;
}

function clientRunScript() {
  return `
      const pageLoadedAt = Date.now();
      const progressOrder = ['plan', 'dom', 'code', 'tests', 'report'];
      const terminalStatuses = new Set(['passed', 'failed', 'blocked', 'setup_failed', 'inconclusive', 'no_automatizable_aun']);
      const progressEvents = new Set([
        'plan_generated',
        'dom_context_started',
        'dom_context_collected',
        'dom_context_unavailable',
        'code_generation_started',
        'code_generation_progress',
        'tests_generated',
        'run_started',
        'case_started',
        'step_started',
        'case_finished',
        'error_global',
        'pdf_generated',
        'pdf_skipped',
        'run_finished'
      ]);
      let refreshTimer = null;
      bindCaseRows();
      const executeButton = document.getElementById('executeRunBtn');
      if (executeButton) {
        executeButton.addEventListener('click', async () => {
          executeButton.disabled = true;
          executeButton.classList.add('is-loading');
          executeButton.textContent = 'Ejecutando...';
          markRunnableRowsQueued('Esperando inicio de ejecucion...');
          const response = await fetch('/api/runs/' + encodeURIComponent(runId) + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          if (!response.ok) {
            executeButton.disabled = false;
            executeButton.textContent = 'Ejecutar';
            throw new Error(await response.text());
          }
        });
      }
      const source = new EventSource('/runs/' + encodeURIComponent(runId) + '/events');
      source.onmessage = (event) => {
        const item = JSON.parse(event.data);
        applyRunEvent(item);
        applyCaseEvent(item);
        if (progressEvents.has(item.type)) scheduleRefresh();
        const eventTime = Date.parse(item.timestamp || '');
        const isFreshTerminalEvent = Number.isFinite(eventTime) && eventTime >= pageLoadedAt - 1000;
        if (isFreshTerminalEvent && ['pdf_generated', 'pdf_skipped', 'run_finished'].includes(item.type)) {
          source.close();
          setTimeout(() => location.reload(), 900);
        }
      };
      function markRunnableRowsQueued(message) {
        document.querySelectorAll('#casesTable tbody tr[data-runnable="1"]').forEach((row) => {
          if (isRowTerminal(row)) return;
          setRowStatus(row, 'queued', message || 'Esperando worker disponible...');
        });
      }
      function bindCaseRows() {
        document.querySelectorAll('#casesTable tbody tr[data-href]').forEach((row) => {
          row.addEventListener('click', (event) => {
            if (event.target.closest('a, button, input, textarea, select')) return;
            window.location.href = row.dataset.href;
          });
          row.addEventListener('keydown', (event) => {
            if (!['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            window.location.href = row.dataset.href;
          });
        });
      }
      function applyRunEvent(item) {
        if (!item || !item.type) return;
        if (item.type === 'plan_generated') {
          setProgress('plan', item.status || 'generating', 'Plan ejecutable preparado', item.message || 'Casos listos para convertir en codigo.', 22, true);
        } else if (item.type === 'dom_context_started') {
          setProgress('dom', 'generating', 'Leyendo la app en browser', item.message || 'ProGuide esta tomando contexto visible antes de generar codigo.', 36, true);
        } else if (item.type === 'dom_context_collected') {
          setProgress('dom', 'generating', 'Contexto del browser listo', item.message || 'Se recolectaron roles, textos y selectores visibles.', 46, true);
        } else if (item.type === 'dom_context_unavailable') {
          setProgress('dom', 'generating', 'Contexto del browser no disponible', item.message || 'La generacion seguira con los casos normalizados.', 46, true, false, true);
        } else if (item.type === 'code_generation_started') {
          setProgress('code', item.status || 'generating', 'Agente generando codigo', item.message || 'Creando tests Python Playwright para este run.', 55, true);
        } else if (item.type === 'code_generation_progress') {
          setProgress('code', item.status || 'generating', 'Agente generando codigo', item.message || 'Codigo generado parcialmente.', progressFromPayload(item.payload, 55), true);
        } else if (item.type === 'tests_generated') {
          setProgress('tests', 'queued', 'Codigo generado', item.message || 'Preparando ejecucion de tests.', 68, true);
          markRunnableRowsQueued('Esperando inicio de ejecucion...');
        } else if (item.type === 'run_started') {
          setProgress('tests', item.status || 'running', 'Ejecutando tests en browser', item.message || 'Los casos listos se estan distribuyendo entre workers.', 78, true);
          markRunnableRowsQueued('Esperando worker disponible...');
        } else if (['case_started', 'step_started'].includes(item.type)) {
          setProgress('tests', 'running', 'Ejecutando tests en browser', item.message || 'Hay casos corriendo en paralelo.', 82, true);
        } else if (item.type === 'case_finished') {
          setProgress('tests', 'running', 'Ejecutando tests en browser', item.message || 'Un caso termino y se esperan los restantes.', 88, true);
        } else if (item.type === 'error_global') {
          setProgress('report', 'error', 'Run detenido', item.message || 'Se produjo un error durante la ejecucion.', 100, false, true);
        } else if (item.type === 'pdf_generated' || item.type === 'pdf_skipped') {
          setProgress('report', item.status || 'running', 'Armando evidencia', item.message || 'Preparando reporte del run.', 96, true);
        } else if (item.type === 'run_finished') {
          setProgress('report', item.status || 'finished', 'Run finalizado', item.message || 'Resultados y evidencia disponibles.', 100, false);
        }
      }
      function applyCaseEvent(item) {
        if (!item.case_id) return;
        const row = document.querySelector('[data-case-id="' + CSS.escape(item.case_id) + '"]');
        if (!row) return;
        if (['case_started', 'step_started'].includes(item.type)) {
          setRowStatus(row, 'running', item.message || 'Ejecutando...');
        } else if (item.type === 'step_failed') {
          setRowStatus(row, 'failed', item.message || 'Fallo durante la ejecucion.');
        } else if (item.type === 'case_finished') {
          setRowStatus(row, item.status || item.payload?.status || 'passed', item.message || '');
        }
      }
      function setRowStatus(row, status, message) {
        const statusCell = row.querySelector('.status-cell');
        const messageCell = row.querySelector('.message-cell');
        if (statusCell) statusCell.innerHTML = badgeMarkup(status);
        if (messageCell) messageCell.textContent = message || '';
        row.dataset.status = status || '';
        row.classList.toggle('is-live', isActiveStatus(status));
      }
      function badgeMarkup(status) {
        const label = String(status || '-').replace(/_/g, ' ');
        const indicator = isActiveStatus(status) ? '<i class="status-spinner"></i>' : '<i class="badge-dot"></i>';
        return '<span class="badge ' + statusClass(status) + '">' + indicator + escapeText(label) + '</span>';
      }
      function statusClass(status) {
        return String(status || 'pending').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'pending';
      }
      function isActiveStatus(status) {
        return ['running', 'executing', 'ejecutando', 'queued', 'started', 'generating', 'interpreting'].includes(statusClass(status));
      }
      function isRowTerminal(row) {
        const badge = row.querySelector('.badge');
        return terminalStatuses.has(statusClass(row.dataset.status || badge?.textContent || ''));
      }
      function setProgress(stage, status, title, message, percent, active, error, warning) {
        const container = document.getElementById('runProgress');
        if (!container) return;
        container.dataset.stage = stage;
        container.dataset.status = status || '';
        container.style.setProperty('--progress', Math.max(0, Math.min(100, Number(percent) || 0)) + '%');
        container.classList.toggle('is-active', Boolean(active));
        container.classList.toggle('is-error', Boolean(error));
        container.classList.toggle('is-warning', Boolean(warning));
        container.classList.toggle('is-done', stage === 'report' && !active && !error);
        const badge = document.getElementById('runProgressBadge');
        const titleNode = document.getElementById('runProgressTitle');
        const messageNode = document.getElementById('runProgressMessage');
        if (badge) badge.innerHTML = badgeMarkup(status || 'pending');
        if (titleNode) titleNode.textContent = title || '';
        if (messageNode) messageNode.textContent = message || '';
        updateProgressSteps(stage, active, error);
      }
      function updateProgressSteps(activeStage, active, error) {
        const activeIndex = progressOrder.indexOf(activeStage);
        document.querySelectorAll('[data-progress-step]').forEach((node) => {
          const index = progressOrder.indexOf(node.dataset.progressStep);
          const isActive = index === activeIndex && Boolean(active);
          node.classList.toggle('is-done', activeStage === 'report' || (activeIndex >= 0 && index < activeIndex));
          node.classList.toggle('is-active', isActive);
          node.classList.toggle('is-error', index === activeIndex && Boolean(error));
        });
      }
      function progressFromPayload(payload, fallback) {
        const current = Number(payload?.batch_index || payload?.index || 0);
        const total = Number(payload?.batch_count || payload?.total || 0);
        if (!current || !total) return fallback;
        return 55 + Math.round((current / total) * 10);
      }
      function escapeText(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
      function scheduleRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          refreshRun();
        }, 350);
      }
      async function refreshRun() {
        const response = await fetch('/api/runs/' + encodeURIComponent(runId));
        if (!response.ok) return;
        const payload = await response.json();
        applyRunPayload(payload);
        const results = payload.summary?.results || [];
        for (const result of results) {
          const row = document.querySelector('[data-case-id="' + CSS.escape(result.id) + '"]');
          if (!row) continue;
          setRowStatus(row, result.status || 'pending', result.message || '');
        }
      }
      function applyRunPayload(payload) {
        const events = Array.isArray(payload.events) ? payload.events : [];
        const lastProgressEvent = events.filter((item) => progressEvents.has(item.type)).at(-1);
        if (lastProgressEvent) {
          applyRunEvent(lastProgressEvent);
          return;
        }
        const status = statusClass(payload.run?.status || '');
        if (status === 'running') {
          setProgress('tests', 'running', 'Ejecutando tests en browser', 'Los casos listos se estan distribuyendo entre workers.', 78, true);
          markRunnableRowsQueued('Esperando worker disponible...');
        } else if (status === 'generating') {
          setProgress('code', 'generating', 'Preparando automatizacion', 'ProGuide esta recolectando contexto y generando codigo Playwright.', 48, true);
        } else if (['passed', 'failed', 'finished', 'inconclusive', 'setup_failed', 'blocked'].includes(status)) {
          setProgress('report', payload.run?.status || 'finished', 'Run finalizado', 'Resultados y evidencia disponibles.', 100, false);
        }
      }
      refreshRun();
      setInterval(refreshRun, 2500);
  `;
}

function layout(title, body) {
  return `<!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="dark">
      <title>${escapeHtml(title)} | ProGuide Test Cases</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
      <style>${styles()}</style>
    </head>
    <body>
      <div class="bg-aurora" aria-hidden="true"></div>
      <div class="bg-grid" aria-hidden="true"></div>
      <header class="appbar">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 12.5 10 17.5 19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <span class="brand-name">ProGuide<span class="brand-dim"> Test Cases</span></span>
        </a>
        <nav class="appnav" aria-label="Principal">
          <a href="/runs">Runs</a>
          <a href="/usage">Uso</a>
        </nav>
        <span class="appbar-tag mono">e2e · local</span>
      </header>
      <div class="shell">${body}</div>
    </body>
    </html>`;
}

function styles() {
  return `
    :root {
      --bg: #07090e;
      --bg-2: #0b0f17;
      --surface: rgba(255, 255, 255, 0.024);
      --surface-2: rgba(255, 255, 255, 0.045);
      --border: rgba(255, 255, 255, 0.085);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #e9eef5;
      --muted: #8793a6;
      --faint: #5d6878;
      --accent: #34e0b0;
      --accent-2: #2bd0d6;
      --accent-soft: rgba(52, 224, 176, 0.12);
      --radius: 16px;
      --radius-sm: 10px;
      --shadow: 0 24px 60px -28px rgba(0, 0, 0, 0.85);
      --font-display: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
      --font-body: "Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background: var(--bg);
      font-family: var(--font-body);
      font-size: 14.5px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    .bg-aurora, .bg-grid { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
    .bg-aurora {
      background:
        radial-gradient(820px 520px at 12% -8%, rgba(52, 224, 176, 0.16), transparent 60%),
        radial-gradient(720px 540px at 96% 4%, rgba(43, 208, 214, 0.13), transparent 58%),
        radial-gradient(900px 700px at 70% 110%, rgba(80, 110, 255, 0.10), transparent 60%);
      filter: saturate(115%);
    }
    .bg-grid {
      background-image:
        linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px);
      background-size: 46px 46px;
      mask-image: radial-gradient(circle at 50% 0%, #000 0%, transparent 78%);
    }
    h1, h2, h3 { margin: 0; font-family: var(--font-display); font-weight: 600; letter-spacing: -0.02em; line-height: 1.08; }
    h1 { font-size: clamp(28px, 4.6vw, 46px); }
    h2 { font-size: 17px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; }
    a { color: var(--accent); text-decoration: none; font-weight: 600; transition: color .15s ease; }
    a:hover { color: #6cf0cc; }
    code { font-family: var(--font-mono); font-size: 0.86em; background: var(--surface-2); padding: 2px 6px; border-radius: 6px; color: var(--accent); }
    .mono { font-family: var(--font-mono); }
    .muted { color: var(--muted); }
    .nowrap { white-space: nowrap; }

    /* App bar */
    .appbar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px;
      padding: 14px clamp(18px, 4vw, 40px);
      background: color-mix(in srgb, var(--bg) 72%, transparent);
      backdrop-filter: blur(14px) saturate(140%);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: inline-flex; align-items: center; gap: 11px; color: var(--text); font-weight: 700; }
    .brand:hover { color: var(--text); }
    .brand-mark {
      display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
      color: #04130d; background: linear-gradient(140deg, var(--accent), var(--accent-2));
      box-shadow: 0 6px 20px -6px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,0.4);
    }
    .brand-name { font-family: var(--font-display); font-size: 17px; letter-spacing: -0.01em; }
    .brand-dim { color: var(--faint); font-weight: 500; }
    .appnav { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .appnav a {
      display: inline-flex; align-items: center; min-height: 32px; padding: 5px 10px;
      border-radius: 999px; color: var(--muted); border: 1px solid transparent;
      font-size: 13px; font-weight: 700;
    }
    .appnav a:hover { color: var(--accent); border-color: var(--border-strong); background: var(--surface-2); }
    .appbar-tag { font-size: 11.5px; color: var(--faint); border: 1px solid var(--border); padding: 4px 10px; border-radius: 999px; letter-spacing: 0.04em; }

    .shell { position: relative; z-index: 1; max-width: 1520px; margin: 0 auto; padding: clamp(20px, 4vw, 44px) clamp(16px, 4vw, 40px) 80px; }

    /* Hero */
    .hero { padding: 28px 0 8px; max-width: 760px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--accent); padding: 6px 12px; border: 1px solid var(--border-strong); border-radius: 999px;
      background: var(--accent-soft);
    }
    .hero h1 { margin: 20px 0 0; }
    .dot-accent { color: var(--accent); }
    .lede { margin: 16px 0 0; font-size: 16.5px; color: var(--muted); max-width: 60ch; }

    /* Layout grids */
    .grid { display: grid; gap: 20px; margin-top: 28px; min-width: 0; }
    .two { grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr); align-items: start; }
    .detail { grid-template-columns: minmax(0, 1fr); align-items: start; }
    .case-detail-grid { grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr); align-items: start; }
    .case-detail-grid > *, .detail-side, .code-section, .code-panels, .code-panel { min-width: 0; }
    .detail-side { display: grid; gap: 20px; }

    /* Panels */
    .panel {
      position: relative;
      min-width: 0;
      background: linear-gradient(180deg, var(--surface-2), var(--surface));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 22px;
      box-shadow: var(--shadow);
    }
    .panel::before {
      content: ""; position: absolute; inset: 0 0 auto 0; height: 1px; border-radius: var(--radius) var(--radius) 0 0;
      background: linear-gradient(90deg, transparent, var(--border-strong), transparent);
    }
    .cases-panel { padding: 26px; }
    .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .panel-sub { margin: 0; color: var(--faint); font-size: 12.5px; }
    .step-chip {
      display: grid; place-items: center; min-width: 26px; height: 26px; padding: 0 7px; border-radius: 8px;
      font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--accent);
      background: var(--accent-soft); border: 1px solid var(--border-strong);
    }

    /* Forms */
    .form-grid { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field { display: grid; gap: 7px; }
    .field.span-2 { grid-column: 1 / -1; }
    .field-label { color: var(--muted); font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(0, 0, 0, 0.28);
      color: var(--text);
      padding: 11px 13px;
      font: inherit;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }
    input::placeholder { color: var(--faint); }
    input:hover, textarea:hover, select:hover { border-color: var(--border-strong); }
    input:focus, textarea:focus, select:focus {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
      background: rgba(0, 0, 0, 0.4);
    }
    textarea { min-height: 110px; resize: vertical; }
    .file-field input[type="file"] { padding: 9px 12px; cursor: pointer; color: var(--muted); }
    input[type="file"]::file-selector-button {
      margin-right: 12px; padding: 7px 13px; border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2); color: var(--text); font: inherit; font-weight: 600; cursor: pointer;
      transition: background .15s ease, border-color .15s ease;
    }
    input[type="file"]::file-selector-button:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    label.field { color: var(--text); }
    pre { white-space: pre-wrap; background: rgba(0,0,0,0.35); padding: 14px; border-radius: var(--radius-sm); overflow: auto; font-family: var(--font-mono); }

    /* Buttons */
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; grid-column: 1 / -1; margin-top: 4px; flex-wrap: wrap; }
    button, .button-link {
      display: inline-flex; align-items: center; justify-content: center; gap: 9px;
      border: 1px solid transparent;
      background: linear-gradient(140deg, var(--accent), var(--accent-2));
      color: #04130d;
      border-radius: var(--radius-sm);
      padding: 11px 18px;
      font: inherit; font-weight: 700; letter-spacing: -0.01em;
      cursor: pointer; min-height: 42px; text-decoration: none;
      box-shadow: 0 10px 26px -12px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,0.35);
      transition: transform .14s ease, box-shadow .18s ease, opacity .15s ease, filter .15s ease;
    }
    button:hover, .button-link:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 16px 32px -14px rgba(52,224,176,0.5); color: #04130d; }
    button:active, .button-link:active { transform: translateY(0); }
    button svg, .button-link svg { transition: transform .18s ease; }
    button:hover svg { transform: translateX(2px); }
    button:disabled { opacity: 0.7; cursor: progress; transform: none; }
    button.is-loading { background: var(--surface-2); color: var(--muted); box-shadow: none; }
    .button-link.ghost, .back-link {
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); box-shadow: none;
    }
    .button-link.ghost:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); filter: none; box-shadow: none; }
    .back-link { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
    .back-link:hover { color: var(--accent); border-color: var(--accent); }

    /* Tool band (detail header) */
    .tool-band { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; padding: 12px 0 4px; }
    .tool-band-main { display: flex; flex-direction: column; gap: 12px; }
    .tool-band h1 { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: clamp(26px, 4vw, 38px); }
    .run-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0; }
    .run-meta .mono { font-size: 13px; color: var(--muted); }
    .meta-sep { color: var(--faint); }

    .identity-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(255,255,255,0.026);
    }
    .identity-strip div { min-width: 0; display: grid; gap: 2px; }
    .identity-strip dt {
      color: var(--faint);
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .identity-strip dd {
      margin: 0;
      min-width: 0;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Live run progress */
    .run-progress {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 0.58fr);
      gap: 16px 22px;
      align-items: center;
      margin-top: 20px;
      padding: 18px 20px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.026)),
        rgba(0,0,0,0.16);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .run-progress-main { min-width: 0; display: grid; gap: 8px; }
    .run-progress-kicker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .run-progress h2 { font-size: clamp(18px, 2.2vw, 26px); display: block; letter-spacing: 0; }
    .run-progress p { margin: 0; max-width: 82ch; }
    .run-progress-track {
      grid-column: 1 / -1;
      height: 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.07);
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .run-progress-track span {
      display: block;
      width: var(--progress, 0%);
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width .35s ease;
    }
    .run-progress.is-active .run-progress-track span {
      background:
        linear-gradient(90deg, rgba(52,224,176,0.72), rgba(43,208,214,0.92), rgba(130,184,255,0.72));
      background-size: 180% 100%;
      animation: progressFlow 1.2s linear infinite;
    }
    .run-progress.is-error .run-progress-track span { background: linear-gradient(90deg, #ff637a, #c4a6ff); }
    .run-progress-steps {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .run-progress-step {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 4px 9px;
      border-radius: 999px;
      color: var(--faint);
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.025);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .run-progress-step i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.55;
    }
    .run-progress-step.is-done { color: var(--accent); border-color: rgba(52,224,176,0.28); background: var(--accent-soft); }
    .run-progress-step.is-active { color: #82b8ff; border-color: rgba(78,158,255,0.36); background: rgba(78,158,255,0.12); }
    .run-progress-step.is-active i {
      width: 11px;
      height: 11px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      background: transparent;
      opacity: 1;
      animation: spin .7s linear infinite;
    }
    .run-progress-step.is-error { color: #ff8298; border-color: rgba(255,99,122,0.34); background: rgba(255,99,122,0.1); }
    .run-progress-counts { justify-self: end; color: var(--faint); font-size: 11.5px; }
    @keyframes progressFlow { to { background-position: -180% 0; } }

    /* Usage dashboard */
    .usage-page { display: grid; gap: 20px; margin-top: 28px; min-width: 0; }
    .usage-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; min-width: 0; }
    .usage-strip {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 18px;
      margin-top: 20px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025));
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .usage-strip-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
    .usage-strip-main .eyebrow { padding: 4px 9px; font-size: 10px; }
    .usage-strip-main strong { font-family: var(--font-display); font-size: 22px; line-height: 1; }
    .usage-strip-kv { display: flex; align-items: center; gap: 14px; margin: 0; }
    .usage-strip-kv div { display: grid; gap: 2px; }
    .usage-strip-kv dt {
      color: var(--faint);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .usage-strip-kv dd { margin: 0; font-family: var(--font-mono); color: var(--text); font-size: 12px; }
    .usage-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; min-width: 0; }
    .usage-stat {
      min-width: 0;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, var(--surface-2), var(--surface));
      box-shadow: var(--shadow);
    }
    .usage-stat span {
      display: block;
      color: var(--faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .usage-stat strong {
      display: block;
      margin-top: 10px;
      font-family: var(--font-display);
      font-size: clamp(22px, 3vw, 34px);
      line-height: 1;
      overflow-wrap: anywhere;
    }
    .usage-stat small { display: block; margin-top: 9px; color: var(--muted); }
    .usage-table th, .usage-table td { white-space: nowrap; }
    .usage-table td:nth-child(4) { white-space: normal; min-width: 220px; }
    .usage-provider {
      display: block;
      color: var(--accent);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .usage-model { display: block; margin-top: 2px; color: var(--muted); font-size: 11.5px; }

    /* Tables */
    .table-wrap { overflow-x: auto; border-radius: var(--radius-sm); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 13px 12px; text-align: left; vertical-align: middle; }
    th {
      color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
      border-bottom: 1px solid var(--border-strong);
    }
    td { border-bottom: 1px solid var(--border); font-size: 13.5px; }
    tbody tr { transition: background .14s ease; }
    tbody tr:hover { background: var(--surface-2); }
    tbody tr:last-child td { border-bottom: none; }
    .case-row { cursor: pointer; outline: none; }
    .case-row.is-live { background: rgba(78, 158, 255, 0.055); box-shadow: inset 3px 0 0 rgba(78, 158, 255, 0.65); }
    .case-row.is-live:hover { background: rgba(78, 158, 255, 0.09); }
    .case-row:focus-visible { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .col-n { width: 46px; color: var(--faint); }
    .case-title { font-weight: 600; color: var(--text); }
    .case-title-link { color: var(--text); font-weight: 700; }
    .case-title-link:hover { color: var(--accent); }
    #casesTable .case-title { min-width: 320px; }
    #casesTable .message-cell { min-width: 280px; }
    #casesTable .evidence-cell { min-width: 150px; }
    #casesTable .code-cell { min-width: 124px; white-space: nowrap; }
    #casesTable .code-cell .chip-link + .chip-link { margin-left: 6px; }
    .truncate { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-link { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .row-link svg { opacity: 0; transform: translateX(-3px); transition: all .16s ease; }
    tr:hover .row-link svg { opacity: 1; transform: translateX(0); }

    /* Badges */
    .badge {
      display: inline-flex; align-items: center; gap: 7px; border-radius: 999px;
      padding: 4px 11px 4px 9px; font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
      text-transform: capitalize; background: var(--surface-2); color: var(--muted);
      border: 1px solid var(--border); white-space: nowrap;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 20%, transparent); }
    .status-spinner {
      width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid currentColor; border-right-color: transparent;
      animation: spin .7s linear infinite;
    }
    .passed, .listo { background: rgba(52, 224, 176, 0.13); color: #57e9bf; border-color: rgba(52, 224, 176, 0.3); }
    .failed { background: rgba(255, 99, 122, 0.13); color: #ff8298; border-color: rgba(255, 99, 122, 0.3); }
    .ready, .pending { background: rgba(255,255,255,0.045); color: var(--muted); border-color: var(--border); }
    .running, .queued, .started, .executing, .ejecutando, .generating, .interpreting { background: rgba(78, 158, 255, 0.14); color: #82b8ff; border-color: rgba(78, 158, 255, 0.32); }
    .inconclusive, .necesita_revision { background: rgba(255, 191, 73, 0.14); color: #ffce7a; border-color: rgba(255, 191, 73, 0.3); }
    .blocked, .no_automatizable_aun, .setup_failed, .error { background: rgba(178, 132, 255, 0.14); color: #c4a6ff; border-color: rgba(178, 132, 255, 0.32); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Evidence chips */
    .evidence-cell { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip-link {
      display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
      background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--muted);
      transition: all .14s ease;
    }
    .chip-link:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }

    /* Case detail */
    .case-detail-head { display: grid; gap: 14px; margin-bottom: 24px; }
    .case-detail-head h2 { font-size: clamp(24px, 3.4vw, 38px); line-height: 1.04; display: block; }
    .detail-lede { margin: 0; color: var(--muted); max-width: 78ch; font-size: 15.5px; }
    .result-note {
      margin: 0 0 24px; padding: 14px 16px; border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm); background: rgba(255,255,255,0.035);
    }
    .result-note strong { display: block; margin-bottom: 6px; color: var(--text); }
    .result-note p { margin: 0; color: var(--muted); }
    .result-note.failed { border-color: rgba(255, 99, 122, 0.35); background: rgba(255, 99, 122, 0.08); }
    .detail-section { display: grid; gap: 12px; margin-top: 24px; }
    .detail-section.compact { margin-top: 18px; }
    .detail-section h3 {
      margin: 0; color: var(--muted); font-family: var(--font-mono); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .detail-list { margin: 0; padding-left: 18px; color: var(--text); }
    .detail-list li + li { margin-top: 8px; }
    .code-section-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
    .code-tabs {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(0, 0, 0, 0.2);
    }
    .code-tab {
      min-height: 30px;
      padding: 5px 11px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      box-shadow: none;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .code-tab:hover {
      transform: none;
      filter: none;
      box-shadow: none;
      color: var(--accent);
      background: var(--surface-2);
    }
    .code-tab.is-active {
      color: var(--accent);
      border-color: var(--border-strong);
      background: var(--accent-soft);
    }
    .code-panel[hidden] { display: none; }
    .code-block {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background:
        linear-gradient(180deg, rgba(6, 10, 17, 0.98), rgba(8, 12, 20, 0.96)),
        rgba(0, 0, 0, 0.32);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
    }
    .code-block-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 13px 10px 14px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.025)),
        rgba(0, 0, 0, 0.18);
    }
    .code-block-head::before {
      content: "";
      width: 34px;
      height: 10px;
      border-radius: 999px;
      background:
        radial-gradient(circle at 5px 5px, #ff6a76 0 4px, transparent 4.5px),
        radial-gradient(circle at 17px 5px, #ffc35f 0 4px, transparent 4.5px),
        radial-gradient(circle at 29px 5px, #53df9d 0 4px, transparent 4.5px);
      flex: 0 0 auto;
    }
    .code-block-head .mono {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .code-lang {
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--accent);
      background: var(--accent-soft);
      font-family: var(--font-mono);
      font-size: 10.5px;
      font-weight: 700;
    }
    .code-block pre {
      margin: 0;
      max-height: 460px;
      border-radius: 0;
      background: transparent;
      padding: 0;
      font-size: 12.5px;
      line-height: 1.55;
    }
    .code-block code {
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: var(--text);
    }
    .code-editor {
      display: block;
      width: 100%;
      max-width: 100%;
      counter-reset: code-line;
      white-space: pre;
      overflow-x: auto;
      overflow-y: auto;
      font-family: var(--font-mono);
      tab-size: 2;
    }
    .code-line {
      counter-increment: code-line;
      display: table;
      min-width: 100%;
      min-height: 1.55em;
      padding: 0 16px 0 0;
    }
    .code-line::before {
      content: counter(code-line);
      display: inline-block;
      width: 46px;
      margin-right: 14px;
      padding: 0 10px 0 0;
      color: rgba(135, 147, 166, 0.54);
      text-align: right;
      border-right: 1px solid rgba(255, 255, 255, 0.07);
      background: rgba(255, 255, 255, 0.018);
      user-select: none;
    }
    .code-line:first-child { padding-top: 14px; }
    .code-line:first-child::before { padding-top: 14px; margin-top: -14px; }
    .code-line:last-child { padding-bottom: 14px; }
    .code-line:last-child::before { padding-bottom: 14px; margin-bottom: -14px; }
    .tok-keyword { color: #ff8fb3; font-weight: 700; }
    .tok-string { color: #f2ce6f; }
    .tok-number { color: #a7c7ff; }
    .tok-comment { color: #68778d; font-style: italic; }
    .tok-function { color: #6fe4ff; }
    .tok-punctuation { color: #9aa7ba; }
    .code-empty {
      padding: 14px 16px;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.025);
    }
    .code-empty p { margin: 0; }
    .timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .timeline-item {
      display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; align-items: start;
      padding: 12px 0; border-top: 1px solid var(--border);
    }
    .timeline-item:first-child { border-top: none; }
    .timeline-status {
      display: inline-flex; justify-content: center; border-radius: 999px; padding: 3px 8px;
      font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
      background: var(--surface-2); border: 1px solid var(--border);
    }
    .timeline-item.passed .timeline-status { color: #57e9bf; border-color: rgba(52, 224, 176, 0.3); background: rgba(52, 224, 176, 0.1); }
    .timeline-item.failed .timeline-status { color: #ff8298; border-color: rgba(255, 99, 122, 0.3); background: rgba(255, 99, 122, 0.1); }
    .timeline-item.started .timeline-status { color: #82b8ff; border-color: rgba(78, 158, 255, 0.32); background: rgba(78, 158, 255, 0.12); }
    .timeline-item p { margin: 0; color: var(--text); }
    .timeline-item small { display: block; margin-top: 5px; color: var(--muted); }
    .detail-kv { margin: 0; display: grid; gap: 0; }
    .detail-kv div { display: grid; grid-template-columns: 98px minmax(0, 1fr); gap: 12px; padding: 11px 0; border-top: 1px solid var(--border); }
    .detail-kv div:first-child { border-top: none; padding-top: 0; }
    .detail-kv dt { color: var(--faint); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .detail-kv dd { margin: 0; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
    .evidence-preview {
      display: block; overflow: hidden; border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
      background: rgba(0,0,0,0.28);
    }
    .evidence-preview img { display: block; width: 100%; max-height: 280px; object-fit: cover; }
    .evidence-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }

    /* Empty state */
    .empty { display: grid; place-items: center; gap: 4px; padding: 40px 16px; text-align: center; }
    .empty-mark { font-size: 34px; color: var(--border-strong); line-height: 1; margin-bottom: 8px; }
    .empty p { margin: 0; font-weight: 600; color: var(--text); }

    /* Reveal on load */
    .reveal { animation: reveal .55s cubic-bezier(.2,.7,.2,1) both; animation-delay: var(--delay, 0s); }
    @keyframes reveal { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } html { scroll-behavior: auto; } }

    @media (max-width: 900px) {
      .two, .detail, .case-detail-grid, .form-grid, .usage-grid, .usage-stats, .usage-strip, .run-progress, .identity-strip { grid-template-columns: 1fr; }
      .field.span-2 { grid-column: auto; }
      .tool-band { align-items: flex-start; }
      .actions { justify-content: flex-start; }
      .truncate { max-width: 220px; }
      .timeline-item { grid-template-columns: 1fr; gap: 7px; }
      .timeline-status { justify-content: flex-start; width: max-content; }
      .usage-strip { align-items: start; }
      .usage-strip-kv { flex-wrap: wrap; }
      .run-progress-steps { justify-content: flex-start; }
      .run-progress-counts { justify-self: start; }
    }
  `;
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

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function cleanCaseTitle(value) {
  return String(value ?? '').replace(/^\s*[•◦⁃∙·—–�-]\s+/, '').trim();
}

function rootIdentity(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function attr(value) {
  return escapeHtml(value);
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
