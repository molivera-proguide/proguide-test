import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv } from '../../playwright-runtime.js';
import { isApiPlanCase } from './api-spec.js';
import {
  positiveInteger,
  writeJson,
  exists,
  firstUsefulLogLine,
  readJson,
  PROGUIDE_DIR
} from '../run-store/io.js';
import { runProcess } from '../runner/playwright.js';
import { ensureSession } from '../auth/session.js';

// DOM-context probe: spawn a Playwright child that snapshots each UI case's
// page (controls/headings/visible text) to feed the codegen agent. The probe
// script runs in a separate process. Extracted verbatim from
// proguide-service.js; collectDomContext is imported back there.

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
  const contextOptions = {};
  if (payload.storage_state_path && fs.existsSync(payload.storage_state_path)) {
    contextOptions.storageState = payload.storage_state_path;
  }
  const context = await browser.newContext(contextOptions);
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

export async function collectDomContext({
  root,
  runDir,
  plan,
  baseUrl,
  config,
  credentials = {}
}: {
  root: string;
  runDir: string;
  plan: ProGuide.Dict;
  baseUrl: string;
  config: ProGuide.Dict;
  credentials?: ProGuide.Dict;
}) {
  const cases = (plan.cases || [])
    .filter((testCase) => !isApiPlanCase(testCase))
    .slice(0, positiveInteger(config.llm.dom_context_max_cases, 12));
  if (!cases.length) return { available: false, error: 'no_plan_cases', by_case_id: {} };

  let storageStatePath = '';
  const authConfig = config.auth || {};
  if (authConfig.login_route) {
    const session = await ensureSession({ root, baseUrl, config, credentials });
    if (session.available && session.storageStatePath) {
      storageStatePath = session.storageStatePath;
    }
  }

  const inputPath = path.join(runDir, 'dom_context_input.json');
  const outputPath = path.join(runDir, 'dom_context.json');
  const scriptPath = path.join(runDir, 'dom_context_probe.cjs');
  const logPath = path.join(runDir, 'dom_context.log');
  const payload = {
    base_url: baseUrl,
    browser: config.runner.browser || 'chromium',
    timeout_ms: positiveInteger(config.llm.dom_context_timeout_ms, 6000),
    max_controls: positiveInteger(config.llm.dom_context_max_controls, 80),
    storage_state_path: storageStatePath,
    cases: cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      route: testCase.route || '/'
    }))
  };

  await writeJson(inputPath, payload);
  await fs.writeFile(scriptPath, DOM_CONTEXT_PROBE_SCRIPT, 'utf8');
  await fs.writeFile(
    logPath,
    `$ ${process.execPath} ${scriptPath} ${inputPath} ${outputPath}\n`,
    'utf8'
  );

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
        error:
          firstUsefulLogLine(logText) || `dom context probe exited with code ${completed.code}`,
        by_case_id: {}
      };
    }
    const context = await readJson(outputPath, null);
    if (!context || !context.by_case_id) {
      return { available: false, error: 'dom context probe did not produce JSON', by_case_id: {} };
    }
    return context;
  } catch (error: any) {
    return { available: false, error: error.message || String(error), by_case_id: {} };
  }
}

const INSPECT_PROBE_SCRIPT = String.raw`
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
  const timeout = Number(payload.timeout_ms || 10000);
  const maxControls = Number(payload.max_controls || 150);
  const browserName = payload.browser || 'chromium';
  const browserType = playwright[browserName] || playwright.chromium;

  const browser = await browserType.launch({ headless: true });
  const contextOptions = {};
  if (payload.storage_state_path && fs.existsSync(payload.storage_state_path)) {
    contextOptions.storageState = payload.storage_state_path;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  let result = {};
  try {
    const url = targetUrl(payload.base_url || '', payload.route || '/');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    try {
      await page.waitForLoadState('networkidle', { timeout: 2000 });
    } catch {
      // ignore
    }
    const accessibility = await page.accessibility.snapshot();
    const snapshot = await page.evaluate(DOM_SNAPSHOT_JS, maxControls);
    result = {
      success: true,
      accessibility,
      snapshot
    };
  } catch (error) {
    result = {
      success: false,
      error: String(error.message || error).slice(0, 500)
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
`;

export async function inspectRoute({
  root,
  baseUrl,
  route,
  config,
  credentials
}: {
  root: string;
  baseUrl: string;
  route: string;
  config: ProGuide.Dict;
  credentials: ProGuide.Dict;
}) {
  let storageStatePath = '';
  let authenticated = false;
  let warning = '';
  const authConfig = config.auth || {};
  const isLoginRoute =
    Boolean(authConfig.login_route) &&
    (route === authConfig.login_route || route.endsWith(authConfig.login_route));
  const sessionExpected = Boolean(authConfig.login_route) && !isLoginRoute;

  if (sessionExpected) {
    const session = await ensureSession({ root, baseUrl, config, credentials });
    if (session.available && session.storageStatePath) {
      storageStatePath = session.storageStatePath;
      authenticated = true;
    } else {
      warning = `Se esperaba una sesion autenticada pero el login fallo${
        session.error ? `: ${session.error}` : ''
      }. El resultado puede corresponder a la pagina de login, no a la ruta protegida.`;
    }
  }

  const proguideDir = path.join(root, PROGUIDE_DIR);
  await fs.mkdir(proguideDir, { recursive: true });

  const inputPath = path.join(proguideDir, 'inspect_input.json');
  const outputPath = path.join(proguideDir, 'inspect_output.json');
  const scriptPath = path.join(proguideDir, 'inspect_probe.cjs');
  const logPath = path.join(proguideDir, 'inspect.log');

  const payload = {
    base_url: baseUrl,
    route,
    browser: config.runner.browser || 'chromium',
    timeout_ms: 10000,
    max_controls: 150,
    storage_state_path: storageStatePath
  };

  await writeJson(inputPath, payload);
  await fs.writeFile(scriptPath, INSPECT_PROBE_SCRIPT, 'utf8');
  await fs.writeFile(
    logPath,
    `$ ${process.execPath} ${scriptPath} ${inputPath} ${outputPath}\n`,
    'utf8'
  );

  try {
    const completed = await runProcess([process.execPath, scriptPath, inputPath, outputPath], {
      cwd: root,
      env: runtimeEnv(),
      logPath
    });
    if (completed.code !== 0 && !(await exists(outputPath))) {
      const logText = await fs.readFile(logPath, 'utf8').catch(() => '');
      return {
        success: false,
        error:
          firstUsefulLogLine(logText) || `inspect probe exited with code ${completed.code}`
      };
    }
    const result = await readJson(outputPath, null);
    if (!result || !result.success) {
      return { success: false, error: result?.error || 'inspect probe failed' };
    }
    return { ...result, authenticated, ...(warning ? { warning } : {}) };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}
