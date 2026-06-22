// @ts-check

// Client-side browser scripts for the viewer, returned as strings and inlined
// in <script> tags. Pure (clientRunScript interpolates only a boolean flag).
// Extracted verbatim from server.js.

export function codeTabsScript() {
  return `
      (() => {
        const tabs = document.querySelector('[data-code-tabs]');
        if (!tabs) return;
        const buttons = Array.from(tabs.querySelectorAll('[data-tab-target]'));
        const panels = Array.from(document.querySelectorAll('.code-panel'));
        const activate = (targetId, updateHash = false) => {
          const target = panels.find((panel) => panel.id === targetId) ? targetId : 'codigo-typescript';
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
        activate('codigo-typescript', false);
        window.addEventListener('hashchange', () => {
          activate('codigo-typescript', false);
        });
      })();
    `;
}

export function clientRunScript({ apiOnlyRun = false } = {}) {
  return `
      const pageLoadedAt = Date.now();
      const apiOnlyRun = ${JSON.stringify(Boolean(apiOnlyRun))};
      const progressOrder = apiOnlyRun ? ['plan', 'code', 'tests', 'report'] : ['plan', 'dom', 'code', 'tests', 'report'];
      const testsTitle = apiOnlyRun ? 'Ejecutando tests REST API' : 'Ejecutando tests en browser';
      const testsRunningMessage = apiOnlyRun ? 'Los requests API se estan distribuyendo entre workers.' : 'Los casos listos se estan distribuyendo entre workers.';
      const generatingMessage = apiOnlyRun ? 'ProGuide esta generando codigo Playwright request para la API.' : 'ProGuide esta recolectando contexto y generando codigo Playwright.';
      const terminalStatuses = new Set(['passed', 'failed', 'blocked', 'setup_failed', 'inconclusive', 'no_automatizable_aun']);
      const progressEvents = new Set([
        'plan_generated',
        'dom_context_started',
        'dom_context_collected',
        'dom_context_unavailable',
        'dom_context_skipped',
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
          if (!apiOnlyRun) setProgress('dom', 'generating', 'Leyendo la app en browser', item.message || 'ProGuide esta tomando contexto visible antes de generar codigo.', 36, true);
        } else if (item.type === 'dom_context_collected') {
          if (!apiOnlyRun) setProgress('dom', 'generating', 'Contexto del browser listo', item.message || 'Se recolectaron roles, textos y selectores visibles.', 46, true);
        } else if (item.type === 'dom_context_unavailable') {
          if (!apiOnlyRun) setProgress('dom', 'generating', 'Contexto del browser no disponible', item.message || 'La generacion seguira con los casos normalizados.', 46, true, false, true);
        } else if (item.type === 'dom_context_skipped') {
          if (apiOnlyRun) setProgress('code', item.status || 'generating', 'Preparando tests REST API', item.message || generatingMessage, 42, true);
        } else if (item.type === 'code_generation_started') {
          setProgress('code', item.status || 'generating', 'Agente generando codigo', item.message || 'Creando tests TypeScript Playwright para este run.', 55, true);
        } else if (item.type === 'code_generation_progress') {
          setProgress('code', item.status || 'generating', 'Agente generando codigo', item.message || 'Codigo generado parcialmente.', progressFromPayload(item.payload, 55), true);
        } else if (item.type === 'tests_generated') {
          setProgress('tests', 'queued', 'Codigo generado', item.message || 'Preparando ejecucion de tests.', 68, true);
          markRunnableRowsQueued('Esperando inicio de ejecucion...');
        } else if (item.type === 'run_started') {
          setProgress('tests', item.status || 'running', testsTitle, item.message || testsRunningMessage, 78, true);
          markRunnableRowsQueued('Esperando worker disponible...');
        } else if (['case_started', 'step_started'].includes(item.type)) {
          setProgress('tests', 'running', testsTitle, item.message || (apiOnlyRun ? 'Hay requests API corriendo en paralelo.' : 'Hay casos corriendo en paralelo.'), 82, true);
        } else if (item.type === 'case_finished') {
          setProgress('tests', 'running', testsTitle, item.message || 'Un caso termino y se esperan los restantes.', 88, true);
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
          setProgress('tests', 'running', testsTitle, testsRunningMessage, 78, true);
          markRunnableRowsQueued('Esperando worker disponible...');
        } else if (status === 'generating') {
          setProgress('code', 'generating', 'Preparando automatizacion', generatingMessage, 48, true);
        } else if (['passed', 'failed', 'finished', 'inconclusive', 'setup_failed', 'blocked'].includes(status)) {
          setProgress('report', payload.run?.status || 'finished', 'Run finalizado', 'Resultados y evidencia disponibles.', 100, false);
        }
      }
      refreshRun();
      setInterval(refreshRun, 2500);
  `;
}
