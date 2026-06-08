import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CHECK_TIMEOUT_MS = positiveNumber(process.env.PROGUIDE_RUNTIME_CHECK_TIMEOUT_MS, 15000);
const INSTALL_TIMEOUT_MS = positiveNumber(process.env.PROGUIDE_RUNTIME_INSTALL_TIMEOUT_MS, 600000);
const RUNTIME_DIR = process.env.PROGUIDE_RUNTIME_DIR || path.join(os.homedir(), '.proguide', 'runtime');
const MANAGED_VENV_DIR = path.join(RUNTIME_DIR, 'python');

const PLAYWRIGHT_BROWSER_PROBE = [
  'from pathlib import Path',
  'from playwright.sync_api import sync_playwright',
  'with sync_playwright() as p:',
  '    executable = Path(p.chromium.executable_path)',
  '    print(executable)',
  '    raise SystemExit(0 if executable.exists() else 1)'
].join('\n');

export async function ensurePythonRuntime(root) {
  const resolvedRoot = path.resolve(root);
  if (process.env.PROGUIDE_PYTHON) {
    return {
      python: process.env.PROGUIDE_PYTHON,
      source: 'env',
      managed: false,
      runtime_dir: '',
      actions: [],
      message: 'Usando PROGUIDE_PYTHON.'
    };
  }

  const workspacePythonPath = workspacePython(resolvedRoot);
  if (workspacePythonPath) {
    return {
      python: workspacePythonPath,
      source: 'workspace',
      managed: false,
      runtime_dir: path.dirname(path.dirname(workspacePythonPath)),
      actions: [],
      message: 'Usando .venv del workspace.'
    };
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
      !commandOk({ command: python, args: [] }, ['-c', 'import playwright; print("installed")'])) {
    runChecked({ command: python, args: [] }, ['-m', 'pip', 'install', 'pytest', 'playwright'], {
      timeout: INSTALL_TIMEOUT_MS,
      label: 'instalar pytest/playwright en runtime ProGuide'
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

  return {
    python,
    source: 'managed',
    managed: true,
    runtime_dir: MANAGED_VENV_DIR,
    actions,
    message: actions.length
      ? `Runtime ProGuide preparado: ${actions.join(', ')}.`
      : 'Runtime ProGuide listo.'
  };
}

export function pythonCommand(root) {
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
    windowsHide: true
  });
  return result.status === 0;
}

function runChecked(spec, args, options = {}) {
  const result = spawnSync(spec.command, [...(spec.args || []), ...args], {
    encoding: 'utf8',
    timeout: options.timeout || INSTALL_TIMEOUT_MS,
    windowsHide: true
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
