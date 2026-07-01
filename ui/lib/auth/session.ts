import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv } from '../../playwright-runtime.js';
import { writeJson, exists, firstUsefulLogLine, PROGUIDE_DIR, readJson } from '../run-store/io.js';
import { runProcess } from '../runner/playwright.js';

// Standalone probe emitted as a .cjs and run in a child process (same isolation
// pattern as codegen/dom-context.ts). Two modes:
//   - login:    perform user/pass login and persist storageState.
//   - validate: load an existing storageState and confirm the session is alive.
// Credentials are passed via env (PROGUIDE_SESSION_*), never written to disk.
const SESSION_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { URL } = require('node:url');

const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || __filename);
const playwright = req('playwright');

function targetUrl(baseUrl, route) {
  const value = String(route || '/');
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(baseUrl || '').replace(/\/+$/, '') + '/';
  return new URL(value.replace(/^\/+/, ''), base).href;
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const mode = payload.mode || 'login';

  const browserName = payload.browser || 'chromium';
  const browserType = playwright[browserName] || playwright.chromium;
  const browser = await browserType.launch({ headless: true });

  let success = false;
  let errorMsg = '';
  let context;
  let page;

  try {
    if (mode === 'validate') {
      context = await browser.newContext({ storageState: payload.storage_state_path });
      // storageState does not carry sessionStorage; re-inject it so a session
      // whose token lives there is recognized on validation too.
      if (payload.session_storage_path && fs.existsSync(payload.session_storage_path)) {
        const sessionData = fs.readFileSync(payload.session_storage_path, 'utf8');
        await context.addInitScript((data) => {
          try {
            const store = JSON.parse(data);
            for (const key of Object.keys(store)) window.sessionStorage.setItem(key, store[key]);
          } catch (e) { /* ignore malformed */ }
        }, sessionData);
      }
      page = await context.newPage();
      const url = targetUrl(payload.base_url, payload.validate_route || payload.login_route || '/');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (payload.success_check) {
        await page.waitForSelector(payload.success_check, { state: 'visible', timeout: 10000 });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      }
      success = true;
    } else {
      context = await browser.newContext();
      page = await context.newPage();
      const loginUrl = targetUrl(payload.base_url, payload.login_route);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      const email = process.env.PROGUIDE_SESSION_EMAIL || '';
      const username = process.env.PROGUIDE_SESSION_USERNAME || '';
      const password = process.env.PROGUIDE_SESSION_PASSWORD || '';

      if (payload.user_selector && email) {
        await page.fill(payload.user_selector, email);
      } else if (payload.user_selector && username) {
        await page.fill(payload.user_selector, username);
      }

      if (payload.pass_selector && password) {
        await page.fill(payload.pass_selector, password);
      }

      if (payload.submit_selector) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
          page.click(payload.submit_selector)
        ]);
      }

      if (payload.success_check) {
        await page.waitForSelector(payload.success_check, { state: 'visible', timeout: 15000 });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      }

      await context.storageState({ path: payload.storage_state_path });
      // Persist sessionStorage separately (storageState omits it). Many SPAs keep
      // the auth token here; the walk/validate re-inject it to stay logged in.
      if (payload.session_storage_path) {
        try {
          const sessionData = await page.evaluate(() => JSON.stringify(window.sessionStorage));
          fs.writeFileSync(payload.session_storage_path, sessionData || '{}', 'utf8');
        } catch (e) { /* best effort */ }
      }
      success = true;
    }
  } catch (err) {
    errorMsg = err.message || String(err);
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(outputPath, JSON.stringify({ success, error: errorMsg }, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
`;

type SessionArgs = {
  root: string;
  baseUrl: string;
  config: ProGuide.Dict;
  credentials: ProGuide.Dict;
};

type SessionResult = {
  available: boolean;
  storageStatePath?: string;
  sessionStoragePath?: string;
  error?: string;
};

// Runs the probe in 'login' or 'validate' mode. Credentials go through env, not
// the input file, so no secret is ever persisted to disk.
async function runProbe(
  { root, baseUrl, config, credentials }: SessionArgs,
  mode: 'login' | 'validate'
): Promise<SessionResult> {
  const authConfig = config.auth || {};
  if (!authConfig.login_route) {
    return { available: false, error: 'auth.login_route no está configurado' };
  }

  const proguideDir = path.join(root, PROGUIDE_DIR);
  await fs.mkdir(proguideDir, { recursive: true });

  const inputPath = path.join(proguideDir, 'session_input.json');
  const outputPath = path.join(proguideDir, 'session_output.json');
  const scriptPath = path.join(proguideDir, 'session_probe.cjs');
  const logPath = path.join(proguideDir, 'session.log');
  const storageStatePath = path.join(proguideDir, 'storage-state.json');
  const sessionStoragePath = path.join(proguideDir, 'session-storage.json');

  const payload = {
    mode,
    base_url: baseUrl,
    browser: config.runner?.browser || 'chromium',
    login_route: authConfig.login_route,
    validate_route: authConfig.validate_route || '',
    user_selector: authConfig.user_selector,
    pass_selector: authConfig.pass_selector,
    submit_selector: authConfig.submit_selector,
    success_check: authConfig.success_check,
    storage_state_path: storageStatePath,
    session_storage_path: sessionStoragePath
  };

  await writeJson(inputPath, payload);
  await fs.writeFile(scriptPath, SESSION_PROBE_SCRIPT, 'utf8');
  await fs.writeFile(
    logPath,
    `$ ${process.execPath} ${scriptPath} ${inputPath} ${outputPath}\n`,
    'utf8'
  );

  const env = runtimeEnv({
    PROGUIDE_SESSION_EMAIL: String(credentials.email || credentials.run_user_email || ''),
    PROGUIDE_SESSION_USERNAME: String(credentials.username || credentials.run_user_name || ''),
    PROGUIDE_SESSION_PASSWORD: String(credentials.password || '')
  });

  try {
    const completed = await runProcess([process.execPath, scriptPath, inputPath, outputPath], {
      cwd: root,
      env,
      logPath
    });

    if (completed.code !== 0 && !(await exists(outputPath))) {
      const logText = await fs.readFile(logPath, 'utf8').catch(() => '');
      return {
        available: false,
        error: firstUsefulLogLine(logText) || `session probe exited with code ${completed.code}`
      };
    }

    const result = await readJson(outputPath, { success: false, error: 'invalid json output' });
    if (!result.success) {
      return { available: false, error: result.error || 'Login falló sin error detallado' };
    }

    return { available: true, storageStatePath, sessionStoragePath };
  } catch (error: any) {
    return { available: false, error: error.message || String(error) };
  } finally {
    // input/output no longer hold secrets, but clean them up to keep the dir tidy.
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

export async function bootstrapSession(args: SessionArgs): Promise<SessionResult> {
  return runProbe(args, 'login');
}

// Returns a valid storageState, re-logging in transparently when none exists or
// the cached session has expired (validate probe fails -> drop and re-bootstrap).
export async function ensureSession(args: SessionArgs): Promise<SessionResult> {
  const { root, config } = args;
  const storageStatePath = path.join(root, PROGUIDE_DIR, 'storage-state.json');
  const sessionStoragePath = path.join(root, PROGUIDE_DIR, 'session-storage.json');

  if (await exists(storageStatePath)) {
    const validation = await runProbe(args, 'validate');
    if (validation.available) {
      return { available: true, storageStatePath, sessionStoragePath };
    }
    await fs.rm(storageStatePath, { force: true }).catch(() => {});
  }

  if (!config.auth || !config.auth.login_route) {
    return {
      available: false,
      error: 'auth.login_route no está configurado, no se puede hacer login'
    };
  }

  return bootstrapSession(args);
}
