import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CHECK_TIMEOUT_MS = positiveNumber(process.env.PROGUIDE_RUNTIME_CHECK_TIMEOUT_MS, 15000);
const INSTALL_TIMEOUT_MS = positiveNumber(process.env.PROGUIDE_RUNTIME_INSTALL_TIMEOUT_MS, 600000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

export async function ensurePlaywrightRuntime(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  loadDotEnvSync(resolvedRoot);

  const runtime = playwrightRuntime();
  const actions = [];

  if (!commandOk({ command: process.execPath, args: [], env: runtimeEnv() }, ['-e', playwrightImportProbe()])) {
    throw new Error('No se pudo importar @playwright/test desde el paquete ProGuide. Reinstala el paquete npm.');
  }

  if (!commandOk({ command: process.execPath, args: [], env: runtimeEnv() }, ['-e', playwrightBrowserProbe()])) {
    runChecked({ command: process.execPath, args: [runtime.cli], env: runtimeEnv() }, ['install', 'chromium'], {
      timeout: INSTALL_TIMEOUT_MS,
      label: 'instalar Chromium de Playwright'
    });
    actions.push('installed_chromium');
  }

  return {
    ...runtime,
    actions,
    message: actions.length
      ? `Runtime Playwright preparado: ${actions.join(', ')}.`
      : 'Runtime Playwright listo.'
  };
}

export function playwrightRuntime() {
  return {
    node: process.execPath,
    cli: playwrightCliPath(),
    require_anchor: proguideRequireAnchor(),
    managed: true,
    source: 'npm-package'
  };
}

export function playwrightCommand(args = []) {
  const runtime = playwrightRuntime();
  return [runtime.node, runtime.cli, ...args];
}

export function runtimeEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PROGUIDE_PLAYWRIGHT_REQUIRE: proguideRequireAnchor()
  };
}

export function proguideRequireAnchor() {
  return path.join(__dirname, 'package.json');
}

export function playwrightCliPath() {
  return requireFromHere.resolve('@playwright/test/cli');
}

export function playwrightImportProbe() {
  return [
    'const { createRequire } = require("node:module");',
    'const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || __filename);',
    'req("@playwright/test");',
    'console.log("installed");'
  ].join(' ');
}

export function playwrightBrowserProbe() {
  return [
    'const { createRequire } = require("node:module");',
    'const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || __filename);',
    'const { chromium } = req("playwright");',
    '(async () => {',
    '  const browser = await chromium.launch({ headless: true });',
    '  await browser.close();',
    '  console.log("chromium");',
    '})().catch((error) => { console.error(error.message || String(error)); process.exit(1); });'
  ].join(' ');
}

function commandOk(spec, args) {
  const result = spawnSync(spec.command, [...(spec.args || []), ...args], {
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
    env: spec.env || process.env
  });
  return result.status === 0;
}

function runChecked(spec, args, options = {}) {
  const result = spawnSync(spec.command, [...(spec.args || []), ...args], {
    encoding: 'utf8',
    timeout: options.timeout || INSTALL_TIMEOUT_MS,
    windowsHide: true,
    env: spec.env || process.env
  });
  if (result.status === 0) return result;

  const output = firstUsefulLine(result.stderr) || firstUsefulLine(result.stdout) || result.error?.message || 'sin salida';
  throw new Error(`No se pudo ${options.label || 'ejecutar comando'}: ${commandText(spec, args)} (${output})`);
}

function commandText(spec, args) {
  return [spec.command, ...(spec.args || []), ...args].map((part) => {
    const text = String(part);
    return /\s/.test(text) ? `"${text}"` : text;
  }).join(' ');
}

function firstUsefulLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadDotEnvSync(root) {
  for (const envPath of envFileCandidates(root)) {
    if (!existsSync(envPath)) continue;
    let text = '';
    try {
      text = readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

function envFileCandidates(root) {
  return [
    process.env.PROGUIDE_ENV_FILE,
    path.join(os.homedir(), '.proguide', '.env'),
    path.join(root, '.env')
  ].filter(Boolean).map((item) => path.resolve(String(item)));
}
