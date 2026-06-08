import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CHECK_TIMEOUT_MS = positiveNumber(process.env.PROGUIDE_RUNTIME_CHECK_TIMEOUT_MS, 15000);
const INSTALL_TIMEOUT_MS = positiveNumber(process.env.PROGUIDE_RUNTIME_INSTALL_TIMEOUT_MS, 600000);
const RUNTIME_DIR = process.env.PROGUIDE_RUNTIME_DIR || path.join(os.homedir(), '.proguide', 'runtime');
const MANAGED_VENV_DIR = path.join(RUNTIME_DIR, 'python');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_PYTHON_ROOT = path.join(__dirname, 'python');

const PLAYWRIGHT_BROWSER_PROBE = [
  'from pathlib import Path',
  'from playwright.sync_api import sync_playwright',
  'with sync_playwright() as p:',
  '    executable = Path(p.chromium.executable_path)',
  '    print(executable)',
  '    raise SystemExit(0 if executable.exists() else 1)'
].join('\n');

export async function ensurePythonRuntime(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  loadDotEnvSync(resolvedRoot);
  if (process.env.PROGUIDE_PYTHON) {
    const runtime = {
      python: process.env.PROGUIDE_PYTHON,
      source: 'env',
      managed: false,
      runtime_dir: '',
      actions: [],
      message: 'Usando PROGUIDE_PYTHON.'
    };
    validatePythonRuntime(runtime, resolvedRoot, options);
    return runtime;
  }

  const workspacePythonPath = workspacePython(resolvedRoot);
  if (workspacePythonPath) {
    const runtime = {
      python: workspacePythonPath,
      source: 'workspace',
      managed: false,
      runtime_dir: path.dirname(path.dirname(workspacePythonPath)),
      actions: [],
      message: 'Usando .venv del workspace.'
    };
    validatePythonRuntime(runtime, resolvedRoot, options);
    return runtime;
  }

  const actions = [];
  const python = managedPythonPath();
  if (!existsSync(python)) {
    const basePython = resolveBasePython();
    await fs.mkdir(RUNTIME_DIR, { recursive: true });
    runChecked(basePython, ['-m', 'venv', MANAGED_VENV_DIR], {
      timeout: INSTALL_TIMEOUT_MS,
      label: 'crear runtime Python de ProGuide'
    });
    actions.push('created_venv');
  }

  if (!commandOk({ command: python, args: [] }, ['-m', 'pytest', '--version']) ||
      !commandOk({ command: python, args: [] }, ['-c', 'import playwright; print("installed")']) ||
      !commandOk({ command: python, args: [] }, ['-c', 'import pydantic; print("installed")'])) {
    runChecked({ command: python, args: [] }, ['-m', 'pip', 'install', 'pytest', 'playwright', 'pydantic'], {
      timeout: INSTALL_TIMEOUT_MS,
      label: 'instalar pytest/playwright/pydantic en runtime ProGuide'
    });
    actions.push('installed_python_packages');
  }

  if (!commandOk({ command: python, args: [] }, ['-c', PLAYWRIGHT_BROWSER_PROBE])) {
    runChecked({ command: python, args: [] }, ['-m', 'playwright', 'install', 'chromium'], {
      timeout: INSTALL_TIMEOUT_MS,
      label: 'instalar Chromium de Playwright'
    });
    actions.push('installed_chromium');
  }

  const runtime = {
    python,
    source: 'managed',
    managed: true,
    runtime_dir: MANAGED_VENV_DIR,
    actions,
    message: actions.length
      ? `Runtime ProGuide preparado: ${actions.join(', ')}.`
      : 'Runtime ProGuide listo.'
  };
  validatePythonRuntime(runtime, resolvedRoot, options);
  return runtime;
}

export function pythonCommand(root) {
  loadDotEnvSync(path.resolve(root));
  if (process.env.PROGUIDE_PYTHON) return process.env.PROGUIDE_PYTHON;
  return workspacePython(path.resolve(root)) || managedPythonPath();
}

export function playwrightBrowserProbe() {
  return PLAYWRIGHT_BROWSER_PROBE;
}

function workspacePython(root) {
  const candidates = process.platform === 'win32'
    ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv', 'bin', 'python')];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function managedPythonPath() {
  return process.platform === 'win32'
    ? path.join(MANAGED_VENV_DIR, 'Scripts', 'python.exe')
    : path.join(MANAGED_VENV_DIR, 'bin', 'python');
}

function resolveBasePython() {
  const candidates = process.env.PROGUIDE_BOOTSTRAP_PYTHON
    ? [{ command: process.env.PROGUIDE_BOOTSTRAP_PYTHON, args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

  for (const candidate of candidates) {
    if (commandOk(candidate, ['--version'])) return candidate;
  }

  throw new Error('No se encontro Python base para crear el runtime de ProGuide. Instala Python 3.12+ o define PROGUIDE_BOOTSTRAP_PYTHON.');
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

function validatePythonRuntime(runtime, root, options = {}) {
  const env = runnerEnv(root);
  const checks = [
    { name: 'pytest', args: ['-c', 'import pytest; print("pytest")'] },
    { name: 'playwright', args: ['-c', 'import playwright; print("playwright")'] },
    { name: 'pydantic', args: ['-c', 'import pydantic; print("pydantic")'] },
    { name: 'proguide.pytest_plugin', args: ['-c', 'import proguide.pytest_plugin; print("proguide")'] }
  ];
  let missing = checks
    .filter((check) => !commandOk({ command: runtime.python, args: [], env }, check.args))
    .map((check) => check.name);
  if (!missing.length) return;

  const installable = missing.filter((name) => ['pytest', 'playwright', 'pydantic'].includes(name));
  if (options.fix && installable.length) {
    runChecked({ command: runtime.python, args: [], env }, ['-m', 'pip', 'install', ...installable], {
      timeout: INSTALL_TIMEOUT_MS,
      label: `instalar dependencias faltantes (${installable.join(', ')})`
    });
    missing = checks
      .filter((check) => !commandOk({ command: runtime.python, args: [], env }, check.args))
      .map((check) => check.name);
    if (!missing.length) return;
  }

  const envPath = path.join(root, '.env');
  const userEnvPath = path.join(os.homedir(), '.proguide', '.env');
  const installCommand = `${quote(runtime.python)} -m pip install pytest playwright pydantic`;
  const browserCommand = `${quote(runtime.python)} -m playwright install chromium`;
  throw new Error(
    [
      `Runtime Python invalido (${runtime.source}): ${runtime.python}.`,
      `Root efectivo: ${root}.`,
      `No se pudieron importar: ${missing.join(', ')}.`,
      `Instala dependencias con: ${installCommand} && ${browserCommand}.`,
      `O define PROGUIDE_PYTHON en ${userEnvPath} apuntando a un entorno valido.`,
      `Compatibilidad: tambien se lee ${envPath}, pero no es recomendado para secretos de herramienta.`,
      missing.includes('proguide.pytest_plugin') ? `El paquete debe incluir ${path.join(PACKAGED_PYTHON_ROOT, 'proguide')} o ejecutarse desde un repo fuente ProGuide.` : ''
    ].filter(Boolean).join(' ')
  );
}

function runnerEnv(root) {
  return {
    ...process.env,
    PYTHONPATH: [
      PACKAGED_PYTHON_ROOT,
      root,
      process.env.PYTHONPATH || ''
    ].filter(Boolean).join(path.delimiter)
  };
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

function quote(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text}"` : text;
}
