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
import { escapeHtml } from './lib/shared/html.js';
import { cleanCaseTitle } from './lib/shared/text.js';
import { styles } from './assets/styles.js';
import { codeTabsScript, clientRunScript } from './assets/scripts.js';
import { highlightCode, buildTypeScriptCode } from './views/code.js';
import {
  renderBadge,
  statusClass,
  isActiveStatus,
  renderList,
  formatSeconds,
  formatTokens,
  formatUsd,
  shortDate
} from './views/format.js';

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
      ${clientRunScript({ apiOnlyRun: isApiOnlyRun(cases) })}
    </script>`;
}

function renderRunProgress(run, cases, summary) {
  const apiOnlyRun = isApiOnlyRun(cases);
  const state = initialRunProgress(run, summary, { apiOnlyRun });
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
        ${progressStepsMarkup(state.stage, state, progressStepsForRun({ apiOnlyRun }))}
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
        <a class="chip-link" href="${attr(detailHref)}#codigo-playwright">TS</a>
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

function progressStepsForRun({ apiOnlyRun = false } = {}) {
  return apiOnlyRun
    ? PROGRESS_STEPS.filter(([key]) => key !== 'dom')
    : PROGRESS_STEPS;
}

function isApiOnlyRun(cases = []) {
  return Array.isArray(cases) && cases.length > 0 && cases.every((testCase) => {
    const type = String(testCase?.type || '').toLowerCase();
    return type === 'api' || Boolean(testCase?.request?.method && testCase?.request?.path);
  });
}

function initialRunProgress(run, summary, options = {}) {
  const status = statusClass(run.status);
  const counts = countSummary(summary);
  const apiOnlyRun = Boolean(options.apiOnlyRun);
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
      title: apiOnlyRun ? 'Ejecutando tests REST API' : 'Ejecutando tests en browser',
      message: apiOnlyRun
        ? 'Los requests API se estan distribuyendo entre workers.'
        : 'Los casos listos se estan distribuyendo entre workers.',
      percent: 78,
      active: true
    };
  }
  if (status === 'generating') {
    return {
      stage: 'code',
      status: 'generating',
      title: 'Preparando automatizacion',
      message: apiOnlyRun
        ? 'ProGuide esta generando codigo Playwright request para la API.'
        : 'ProGuide esta recolectando contexto y generando codigo Playwright.',
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

function progressStepsMarkup(activeStage, state, steps = PROGRESS_STEPS) {
  const activeIndex = steps.findIndex(([key]) => key === activeStage);
  return steps.map(([key, label], index) => {
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
        ${renderApiEvidence(result, run.id)}
        ${renderActualResponse(result)}
        ${renderErrorConsole(result)}
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

function renderActualResponse(result) {
  if (!result?.actual_response) return '';
  return `
    <section class="detail-section error-console-section">
      <h3>Actual response</h3>
      <pre class="error-console">${escapeHtml(JSON.stringify(result.actual_response, null, 2))}</pre>
    </section>`;
}

function renderApiEvidence(result, runId) {
  const entries = Array.isArray(result?.api_evidence) ? result.api_evidence : [];
  if (!entries.length) return '';
  return `
    <section class="detail-section api-evidence-section">
      <h3>API Evidence</h3>
      ${entries.map((entry, index) => renderApiEvidenceEntry(entry, runId, index)).join('')}
    </section>`;
}

function renderApiEvidenceEntry(entry, runId, index) {
  const method = entry?.request?.method || '';
  const url = entry?.request?.url || entry?.request?.path || '';
  const status = entry?.response?.status ?? 'error';
  const ok = entry?.response?.ok === true;
  const requestJson = {
    method: entry?.request?.method,
    url: entry?.request?.url,
    path: entry?.request?.path,
    headers: entry?.request?.headers || {},
    query: entry?.request?.query || {},
    body: entry?.request?.body ?? null
  };
  const responseJson = entry?.response || { error: entry?.error || 'No response captured' };
  return `
    <details class="api-evidence" ${index === 0 ? 'open' : ''}>
      <summary>
        <span class="api-method mono">${escapeHtml(method)}</span>
        <span class="api-url mono">${escapeHtml(url)}</span>
        <span class="api-status ${ok ? 'passed' : 'failed'}">${escapeHtml(String(status))}</span>
        ${entry?.path ? `<a class="chip-link" href="${attr(artifactHref(runId, entry.path))}">JSON</a>` : ''}
      </summary>
      ${entry?.redacted ? '<p class="muted api-redacted">Valores sensibles redactados. Usa debug:true solo en local si necesitas ver el request completo.</p>' : ''}
      <div class="api-evidence-grid">
        <div>
          <h4>Request</h4>
          <pre class="error-console">${escapeHtml(JSON.stringify(requestJson, null, 2))}</pre>
        </div>
        <div>
          <h4>Response</h4>
          <pre class="error-console">${escapeHtml(JSON.stringify(responseJson, null, 2))}</pre>
        </div>
      </div>
      ${renderApiEvidenceChecks(entry)}
    </details>`;
}

function renderApiEvidenceChecks(entry) {
  const assertions = Array.isArray(entry?.assertions) ? entry.assertions : [];
  const captures = Array.isArray(entry?.captures) ? entry.captures : [];
  if (!assertions.length && !captures.length) return '';
  return `
    <div class="api-evidence-checks">
      ${assertions.length ? `<div><h4>Assertions</h4><pre class="error-console">${escapeHtml(JSON.stringify(assertions, null, 2))}</pre></div>` : ''}
      ${captures.length ? `<div><h4>Captures</h4><pre class="error-console">${escapeHtml(JSON.stringify(captures, null, 2))}</pre></div>` : ''}
    </div>`;
}

function renderErrorConsole(result) {
  const details = String(result?.error_details || '').trim();
  if (!details) return '';
  return `
    <section class="detail-section error-console-section">
      <h3>Error Playwright completo</h3>
      <pre class="error-console">${escapeHtml(details)}</pre>
    </section>`;
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
  for (const apiEvidence of result.api_evidence || []) {
    if (apiEvidence?.path) evidence.push(`<a class="chip-link" href="${attr(artifactHref(runId, apiEvidence.path))}">API JSON</a>`);
  }
  return evidence.join('');
}

function renderCodeTabs(generatedCode, testCase, run) {
  const typeScriptCode = {
    code: buildTypeScriptCode(testCase, run),
    path: `generated/${safeName(testCase.id || 'case')}.spec.ts`
  };
  const codeData = generatedCode?.code ? generatedCode : typeScriptCode;
  return `
    <div class="code-section-head">
      <h3>Codigo Playwright</h3>
    </div>
    <div class="code-panels">
      <div class="code-panel is-active" id="codigo-typescript" role="tabpanel">
        ${renderCodeBlock(codeData, 'El codigo TypeScript se genera cuando ejecutas el run.', `generated/${safeName(testCase.id || 'case')}.spec.ts`, 'typescript')}
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
        <span class="code-lang">${escapeHtml(language === 'typescript' ? 'TypeScript' : 'Code')}</span>
      </div>
      <pre class="code-editor language-${escapeHtml(language)}"><code>${highlightCode(codeData.code, language)}</code></pre>
    </div>`;
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
