// @ts-check
import { escapeHtml } from '../lib/shared/html.js';
import { cleanCaseTitle } from '../lib/shared/text.js';
import {
  renderBadge,
  statusClass,
  isActiveStatus,
  renderList,
  formatSeconds,
  formatTokens,
  formatUsd,
  shortDate
} from './format.js';
import { styles } from '../assets/styles.js';
import { codeTabsScript, clientRunScript } from '../assets/scripts.js';
import { highlightCode, buildTypeScriptCode } from './code.js';

// Server-rendered HTML pages for the viewer: runs index/history, usage dashboard,
// run detail (with live progress), case detail (evidence + code), and the page
// layout shell. Pure string rendering over the shared view primitives and assets.
// Extracted verbatim from server.js; the route handlers import the page entries
// (renderRunsIndex, renderUsageDashboard, renderRunDetail, renderCaseDetail, layout).

export function renderRunsIndex(runs, usage) {
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
        ${runs
          .map(
            (run) => `
          <tr>
            <td class="mono nowrap">${escapeHtml(run.created_at || '')}</td>
            <td class="truncate" title="${attr(run.project_name || run.app_name || '')}">${escapeHtml(run.project_name || run.app_name || '-')}</td>
            <td class="truncate" title="${attr(run.run_user_email || run.run_user_name || '')}">${escapeHtml(run.run_user_email || run.run_user_name || '-')}</td>
            <td>${renderBadge(run.status)}</td>
            <td class="truncate" title="${attr(run.base_url || '')}">${escapeHtml(run.base_url || '-')}</td>
            <td class="mono">${run.total_cases || 0}</td>
            <td><a class="row-link" href="/runs/${encodeURIComponent(run.id)}">Abrir<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a></td>
          </tr>
        `
          )
          .join('')}
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
      ${items
        .map(
          ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd title="${attr(value)}">${escapeHtml(value)}</dd>
        </div>`
        )
        .join('')}
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

export function renderUsageDashboard(usage, { runId = null } = {}) {
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
      ${
        usage.entries_count
          ? `
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
        </section>`
          : renderUsageEmpty()
      }
    </main>`;
}

function renderUsageStats(usage) {
  const stats = [
    [
      'Costo',
      formatUsd(usage.estimated_cost_usd),
      usage.unknown_cost_entries ? `${usage.unknown_cost_entries} sin estimar` : 'Estimacion local'
    ],
    ['Total tokens', formatTokens(usage.total_tokens), `${usage.entries_count} llamada(s)`],
    [
      'Input',
      formatTokens(usage.input_tokens),
      `Cache read ${formatTokens(usage.cache_read_input_tokens)}`
    ],
    [
      'Output',
      formatTokens(usage.output_tokens),
      `Cache write ${formatTokens(usage.cache_creation_input_tokens)}`
    ]
  ];
  return `
    <section class="usage-stats reveal" style="--delay:.04s">
      ${stats
        .map(
          ([label, value, hint]) => `
        <article class="usage-stat">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(hint)}</small>
        </article>`
        )
        .join('')}
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
          ${groups
            .map((group) => {
              const title =
                runLinks && group.key !== 'sin_run'
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
            })
            .join('')}
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
          ${entries
            .map(
              (entry) => `
            <tr>
              <td class="mono nowrap">${escapeHtml(shortDate(entry.timestamp))}</td>
              ${showRun ? `<td class="mono">${entry.run_id ? `<a href="/runs/${encodeURIComponent(entry.run_id)}/usage">${escapeHtml(entry.run_id)}</a>` : '<span class="muted">-</span>'}</td>` : ''}
              <td><span class="usage-provider">${escapeHtml(entry.provider || 'llm')}</span><span class="mono usage-model">${escapeHtml(entry.model || '-')}</span></td>
              <td>${escapeHtml(entry.purpose || '-')}</td>
              <td class="mono">${escapeHtml(formatTokens(entry.usage.input_tokens))}</td>
              <td class="mono">${escapeHtml(formatTokens(entry.usage.output_tokens))}</td>
              <td class="mono">${escapeHtml(formatTokens(entry.usage.cache_creation_input_tokens + entry.usage.cache_read_input_tokens))}</td>
              <td class="mono">${escapeHtml(formatUsd(entry.estimated_cost_usd))}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

export function renderRunDetail(run, cases, summary, usage) {
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
  if (isRunnableCase(testCase) && isExecutionActive(run.status))
    return 'Esperando worker disponible...';
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
  return apiOnlyRun ? PROGRESS_STEPS.filter(([key]) => key !== 'dom') : PROGRESS_STEPS;
}

function isApiOnlyRun(cases = []) {
  return (
    Array.isArray(cases) &&
    cases.length > 0 &&
    cases.every((testCase) => {
      const type = String(testCase?.type || '').toLowerCase();
      return type === 'api' || Boolean(testCase?.request?.method && testCase?.request?.path);
    })
  );
}

function initialRunProgress(
  run: ProGuide.Dict,
  summary: ProGuide.Dict | null,
  options: { apiOnlyRun?: boolean } = {}
) {
  const status = statusClass(run.status);
  const counts = countSummary(summary);
  const apiOnlyRun = Boolean(options.apiOnlyRun);
  if (
    ['passed', 'failed', 'finished', 'inconclusive', 'setup_failed', 'blocked'].includes(status)
  ) {
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
  return steps
    .map(([key, label], index) => {
      const className = [
        'run-progress-step',
        index < activeIndex || state.done ? 'is-done' : '',
        index === activeIndex && state.active ? 'is-active' : '',
        index === activeIndex && state.error ? 'is-error' : ''
      ]
        .filter(Boolean)
        .join(' ');
      return `<span class="${className}" data-progress-step="${attr(key)}"><i></i>${escapeHtml(label)}</span>`;
    })
    .join('');
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
  return (summary?.results || []).reduce(
    (acc, result) => {
      acc.total += 1;
      if (result.status === 'passed') acc.passed += 1;
      else if (result.status === 'failed') acc.failed += 1;
      else if (result.status === 'setup_failed') acc.setup_failed += 1;
      else acc.inconclusive += 1;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, inconclusive: 0, setup_failed: 0 }
  );
}

export function renderCaseDetail(run, testCase, summary, stepLog, generatedCode) {
  const result = findCaseResult(summary, testCase.id);
  const status = result?.status || testCase.automation_state || 'pending';
  const evidence = renderEvidenceLinks(result, run.id);
  const firstScreenshot = result?.screenshots?.[0] || '';
  const detailItems = [
    ['Estado', renderBadge(status)],
    ['Ruta', escapeHtml(testCase.route || '-')],
    ['Duracion', escapeHtml(formatSeconds(result?.duration_seconds))],
    ['ID', `<span class="mono">${escapeHtml(testCase.id)}</span>`]
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
    evidence.push(
      `<a class="chip-link" href="${attr(artifactHref(runId, screenshot))}">Screenshot</a>`
    );
  }
  for (const video of result.videos || []) {
    evidence.push(`<a class="chip-link" href="${attr(artifactHref(runId, video))}">Video</a>`);
  }
  for (const trace of result.traces || []) {
    evidence.push(`<a class="chip-link" href="${attr(artifactHref(runId, trace))}">Trace</a>`);
  }
  for (const apiEvidence of result.api_evidence || []) {
    if (apiEvidence?.path)
      evidence.push(
        `<a class="chip-link" href="${attr(artifactHref(runId, apiEvidence.path))}">API JSON</a>`
      );
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
    return `<ol class="timeline">${loggedSteps
      .map(
        (item) => `
      <li class="timeline-item ${escapeHtml(statusClass(item.status))}">
        <span class="timeline-status">${escapeHtml(item.status || 'step')}</span>
        <div>
          <p>${escapeHtml(item.step)}</p>
          ${item.message ? `<small>${escapeHtml(item.message)}</small>` : ''}
        </div>
      </li>`
      )
      .join('')}</ol>`;
  }

  const resultSteps = (result?.steps || []).filter(Boolean);
  if (resultSteps.length) {
    return `<ol class="timeline">${resultSteps
      .map(
        (step) => `
      <li class="timeline-item">
        <span class="timeline-status">step</span>
        <div><p>${escapeHtml(step)}</p></div>
      </li>`
      )
      .join('')}</ol>`;
  }

  const plannedSteps = (testCase.executable_steps || [])
    .map((step) => step.normalized_action || step.original_text)
    .filter(Boolean);
  const fallbackSteps = plannedSteps.length ? plannedSteps : testCase.original_steps || [];
  if (!fallbackSteps.length) return '<p class="muted">Sin pasos registrados.</p>';
  return `<ol class="timeline">${fallbackSteps
    .map(
      (step) => `
    <li class="timeline-item pending">
      <span class="timeline-status">plan</span>
      <div><p>${escapeHtml(step)}</p></div>
    </li>`
    )
    .join('')}</ol>`;
}

export function layout(title, body) {
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

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function attr(value) {
  return escapeHtml(value);
}
