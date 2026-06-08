import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadGeneratedCaseCode,
  listRunRecords,
  loadRunBundle
} from './proguide-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.PROGUIDE_UI_ROOT || path.join(__dirname, '..'));
const HOST = process.env.PROGUIDE_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.PROGUIDE_UI_PORT || 8787);

const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

app.get('/', async (_request, reply) => {
  return reply.redirect('/runs');
});

app.get('/runs', async (_request, reply) => {
  const runs = await listRunRecords(ROOT);
  return reply.header('Content-Type', 'text/html; charset=utf-8').send(layout('Ejecuciones', renderRunsIndex(runs)));
});

app.get('/preview', async (_request, reply) => {
  return reply.redirect('/runs');
});

app.post('/runs/prepare', async (_request, reply) => {
  return reply.code(410).send('La importacion de casos se realiza por MCP. Usa la herramienta run_markdown_cases o create_run_from_markdown.');
});

app.get('/runs/:runId/preview', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  return reply.redirect(`/runs/${encodeURIComponent(runId)}`);
});

app.get('/runs/:runId', async (request, reply) => {
  const runId = cleanRunId(request.params.runId);
  const payload = await loadRunBundle(ROOT, runId);
  return reply.header('Content-Type', 'text/html; charset=utf-8').send(layout('Ejecucion', renderRunDetail(payload.run, payload.cases || [], payload.summary)));
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

app.get('/api/health', async () => ({
  service: 'proguide-test-viewer',
  root: ROOT,
  host: HOST,
  port: PORT
}));

app.post('/api/runs/:runId/cases', async (request, reply) => {
  cleanRunId(request.params.runId);
  return reply.code(410).send({ error: 'La edicion de casos no esta disponible en el visor. Envia casos actualizados por MCP.' });
});

app.post('/api/runs/:runId/execute', async (request, reply) => {
  cleanRunId(request.params.runId);
  return reply.code(410).send({ error: 'La ejecucion se dispara por MCP. Usa run_markdown_cases o execute_run.' });
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
});

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

function renderRunsIndex(runs) {
  return `
    <section class="tool-band reveal">
      <div class="tool-band-main">
        <span class="eyebrow">Resultados</span>
        <h1>Ejecuciones de pruebas</h1>
        <p class="muted run-meta">Los runs se crean y ejecutan desde MCP. Este visor muestra estado, evidencia y codigo generado.</p>
      </div>
    </section>
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
        <div class="empty-mark" aria-hidden="true">○</div>
        <p>Aun no hay ejecuciones guardadas.</p>
        <span class="muted">Tu primera corrida aparecera aqui.</span>
      </div>`;
  }
  return `
    <div class="table-wrap">
    <table>
      <thead><tr><th>Fecha</th><th>Estado</th><th>URL</th><th>Casos</th><th></th></tr></thead>
      <tbody>
        ${runs.map((run) => `
          <tr>
            <td class="mono nowrap">${escapeHtml(run.created_at || '')}</td>
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

function renderRunDetail(run, cases, summary) {
  return `
    <section class="tool-band reveal">
      <div class="tool-band-main">
        <a class="back-link" href="/"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H4M7 4.5 3.5 8 7 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Inicio</a>
        <h1>Ejecucion ${renderBadge(run.status)}</h1>
        <p class="muted run-meta"><span class="mono">${escapeHtml(run.id)}</span>${run.base_url ? `<span class="meta-sep">·</span><a href="${attr(run.base_url)}" target="_blank" rel="noreferrer">${escapeHtml(run.base_url)}</a>` : ''}</p>
      </div>
      <div class="actions">
        ${run.html_path ? `<a class="button-link ghost" href="/artifacts/${encodeURIComponent(run.id)}/${encodeURIComponent(run.html_path)}">Reporte HTML</a>` : ''}
        ${run.pdf_path ? `<a class="button-link ghost" href="/artifacts/${encodeURIComponent(run.id)}/${encodeURIComponent(run.pdf_path)}">PDF</a>` : ''}
      </div>
    </section>
    <main class="grid detail">
      <section class="panel cases-panel reveal" style="--delay:.05s">
        <header class="panel-head"><h2>Casos</h2><p class="panel-sub">${cases.length} ${cases.length === 1 ? 'caso' : 'casos'}</p></header>
        <div class="table-wrap">
        <table id="casesTable">
          <thead><tr><th class="col-n">N</th><th>Test</th><th>Estado</th><th>Resultado</th><th>Evidencia</th><th>Codigo</th></tr></thead>
          <tbody>
            ${cases.map((testCase) => renderCaseRow(testCase, summary, run.id)).join('')}
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

function renderCaseRow(testCase, summary, runId) {
  const result = findCaseResult(summary, testCase.id);
  const status = result?.status || testCase.automation_state || 'pending';
  const detailHref = `/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(testCase.id)}`;
  const evidence = renderEvidenceLinks(result, runId);
  return `
    <tr class="case-row" data-case-id="${attr(testCase.id)}" data-href="${attr(detailHref)}" tabindex="0" aria-label="Abrir detalle de ${attr(cleanCaseTitle(testCase.title))}">
      <td class="col-n mono">${testCase.number}</td>
      <td class="case-title"><a class="case-title-link" href="${attr(detailHref)}">${escapeHtml(cleanCaseTitle(testCase.title))}</a></td>
      <td class="status-cell">${renderBadge(status)}</td>
      <td class="message-cell">${escapeHtml(result?.message || testCase.state_reason || '')}</td>
      <td class="evidence-cell">${evidence || '<span class="muted">-</span>'}</td>
      <td class="code-cell"><a class="chip-link" href="${attr(detailHref)}#codigo-python">Python</a></td>
    </tr>`;
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
        <section class="detail-section" id="codigo-python">
          <h3>Codigo Python</h3>
          ${renderGeneratedCode(generatedCode)}
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
    </main>`;
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

function renderGeneratedCode(generatedCode) {
  if (!generatedCode?.code) {
    return `
      <div class="code-empty">
        <p class="muted">El codigo Python se genera cuando ejecutas el run.</p>
      </div>`;
  }
  return `
    <div class="code-block">
      <div class="code-block-head">
        <span class="mono">${escapeHtml(generatedCode.path || 'generated/test_markdown_cases.py')}</span>
      </div>
      <pre><code>${escapeHtml(generatedCode.code)}</code></pre>
    </div>`;
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

function clientRunScript() {
  return `
      const pageLoadedAt = Date.now();
      bindCaseRows();
      const executeButton = document.getElementById('executeRunBtn');
      if (executeButton) {
        executeButton.addEventListener('click', async () => {
          executeButton.disabled = true;
          executeButton.classList.add('is-loading');
          executeButton.textContent = 'Ejecutando...';
          markRunnableRowsRunning();
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
        applyCaseEvent(item);
        refreshRun();
        const eventTime = Date.parse(item.timestamp || '');
        const isFreshTerminalEvent = Number.isFinite(eventTime) && eventTime >= pageLoadedAt - 1000;
        if (isFreshTerminalEvent && ['pdf_generated', 'pdf_skipped', 'run_finished'].includes(item.type)) {
          source.close();
          setTimeout(() => location.reload(), 900);
        }
      };
      function markRunnableRowsRunning() {
        document.querySelectorAll('#casesTable tbody tr').forEach((row) => {
          setRowStatus(row, 'running', 'Ejecutando...');
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
      function escapeText(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
      async function refreshRun() {
        const response = await fetch('/api/runs/' + encodeURIComponent(runId));
        if (!response.ok) return;
        const payload = await response.json();
        const results = payload.summary?.results || [];
        for (const result of results) {
          const row = document.querySelector('[data-case-id="' + CSS.escape(result.id) + '"]');
          if (!row) continue;
          setRowStatus(row, result.status || 'pending', result.message || '');
        }
      }
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
    .grid { display: grid; gap: 20px; margin-top: 28px; }
    .two { grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr); align-items: start; }
    .detail { grid-template-columns: minmax(0, 1fr); align-items: start; }
    .case-detail-grid { grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr); align-items: start; }
    .detail-side { display: grid; gap: 20px; }

    /* Panels */
    .panel {
      position: relative;
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
    .case-row:focus-visible { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .col-n { width: 46px; color: var(--faint); }
    .case-title { font-weight: 600; color: var(--text); }
    .case-title-link { color: var(--text); font-weight: 700; }
    .case-title-link:hover { color: var(--accent); }
    #casesTable .case-title { min-width: 320px; }
    #casesTable .message-cell { min-width: 280px; }
    #casesTable .evidence-cell { min-width: 150px; }
    #casesTable .code-cell { min-width: 92px; }
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
    .running, .queued, .started, .executing, .ejecutando, .generating, .interpreting { background: rgba(78, 158, 255, 0.14); color: #82b8ff; border-color: rgba(78, 158, 255, 0.32); }
    .inconclusive, .necesita_revision { background: rgba(255, 191, 73, 0.14); color: #ffce7a; border-color: rgba(255, 191, 73, 0.3); }
    .blocked, .no_automatizable_aun, .error { background: rgba(178, 132, 255, 0.14); color: #c4a6ff; border-color: rgba(178, 132, 255, 0.32); }
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
    .code-block {
      overflow: hidden;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: rgba(0, 0, 0, 0.32);
    }
    .code-block-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 13px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.035);
    }
    .code-block pre {
      margin: 0;
      max-height: 460px;
      border-radius: 0;
      background: transparent;
      padding: 16px;
      font-size: 12.5px;
      line-height: 1.55;
    }
    .code-block code {
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: var(--text);
    }
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
      .two, .detail, .case-detail-grid, .form-grid { grid-template-columns: 1fr; }
      .field.span-2 { grid-column: auto; }
      .tool-band { align-items: flex-start; }
      .actions { justify-content: flex-start; }
      .truncate { max-width: 220px; }
      .timeline-item { grid-template-columns: 1fr; gap: 7px; }
      .timeline-status { justify-content: flex-start; width: max-content; }
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
