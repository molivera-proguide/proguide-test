import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewerCache = /** @type {Map<string, {baseUrl: string, port: number, started: boolean}>} */ (new Map());
const REQUIRED_VIEWER_CAPABILITIES = ['usage'];
const DEFAULT_VIEWER_START_TIMEOUT_MS = 15000;

export async function ensureViewer(root, options = {}) {
  const rootPath = normalizeRootPath(root);
  const host = options.host || process.env.PROGUIDE_VIEWER_HOST || process.env.PROGUIDE_UI_HOST || '127.0.0.1';
  const firstPort = positiveNumber(options.port, process.env.PROGUIDE_VIEWER_PORT, process.env.PROGUIDE_UI_PORT, 8787);
  const attempts = positiveNumber(options.attempts, process.env.PROGUIDE_VIEWER_PORT_ATTEMPTS, 20);
  const startTimeoutMs = positiveNumber(options.startTimeoutMs, process.env.PROGUIDE_VIEWER_START_TIMEOUT_MS, DEFAULT_VIEWER_START_TIMEOUT_MS);
  const requiredCapabilities = options.requiredCapabilities || REQUIRED_VIEWER_CAPABILITIES;
  const rootKey = `${rootIdentity(rootPath)}|${host}|${firstPort}`;
  const cached = viewerCache.get(rootKey);

  if (cached && await viewerMatchesRoot(cached.baseUrl, rootPath, { requiredCapabilities })) {
    await stopDuplicateViewers({ rootPath, host, firstPort, attempts, keepPort: cached.port });
    return { ...cached, started: false };
  }

  for (const port of viewerPortCandidates({ firstPort, attempts })) {
    const baseUrl = viewerBaseUrl(host, port);
    let health = await fetchViewerHealth(baseUrl);
    if (viewerHealthMatchesRoot(health, rootPath, { requiredCapabilities })) {
      const info = { baseUrl, port, started: false };
      viewerCache.set(rootKey, info);
      await stopDuplicateViewers({ rootPath, host, firstPort, attempts, keepPort: port });
      return info;
    }

    if (health?.service === 'proguide-test-viewer') {
      if (rootIdentity(health.root) === rootIdentity(rootPath) && !viewerHasCapabilities(health, requiredCapabilities)) {
        const stopped = await shutdownViewer(baseUrl, rootPath, health);
        if (!stopped.stopped) continue;
        health = await fetchViewerHealth(baseUrl);
        if (health?.service === 'proguide-test-viewer') continue;
      } else {
        continue;
      }
    }

    let child;
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PROGUIDE_UI_ROOT: rootPath,
          PROGUIDE_UI_HOST: host,
          PROGUIDE_UI_PORT: String(port)
        }
      });
      child.unref();
    } catch {
      continue;
    }

    if (await waitForViewer(baseUrl, rootPath, { requiredCapabilities, timeoutMs: startTimeoutMs })) {
      const info = { baseUrl, port, started: true };
      viewerCache.set(rootKey, info);
      await stopDuplicateViewers({ rootPath, host, firstPort, attempts, keepPort: port });
      return info;
    }

    await stopStartingChild(child, baseUrl, rootPath);
  }

  throw new Error(`No se pudo iniciar el visor Fastify desde el puerto ${firstPort}.`);
}

export async function stopViewer(root, options = {}) {
  const rootPath = normalizeRootPath(root);
  const host = options.host || process.env.PROGUIDE_VIEWER_HOST || process.env.PROGUIDE_UI_HOST || '127.0.0.1';
  const firstPort = positiveNumber(options.port, process.env.PROGUIDE_VIEWER_PORT, process.env.PROGUIDE_UI_PORT, 8787);
  const attempts = positiveNumber(options.attempts, process.env.PROGUIDE_VIEWER_PORT_ATTEMPTS, 20);
  const stopped = [];
  const skipped = [];

  for (const port of viewerPortCandidates({ firstPort, attempts })) {
    const baseUrl = viewerBaseUrl(host, port);
    const health = await fetchViewerHealth(baseUrl);
    if (health?.service !== 'proguide-test-viewer') continue;
    if (rootIdentity(health.root) !== rootIdentity(rootPath)) {
      skipped.push({ baseUrl, port, root: health.root || '', reason: 'different_root' });
      continue;
    }

    const result = await shutdownViewer(baseUrl, rootPath, health);
    stopped.push({
      baseUrl,
      port,
      root: health.root || rootPath,
      pid: Number(health.pid || 0) || null,
      stopped: result.stopped,
      message: result.message
    });
  }

  if (stopped.some((item) => item.stopped)) viewerCache.clear();
  return {
    root: rootPath,
    stopped_count: stopped.filter((item) => item.stopped).length,
    viewers: stopped,
    skipped
  };
}

export async function viewerMatchesRoot(baseUrl, root, options = {}) {
  const health = await fetchViewerHealth(baseUrl);
  return viewerHealthMatchesRoot(health, root, options);
}

export function viewerHealthMatchesRoot(health, root, options = {}) {
  const requiredCapabilities = options.requiredCapabilities || REQUIRED_VIEWER_CAPABILITIES;
  return health?.service === 'proguide-test-viewer' &&
    rootIdentity(health.root) === rootIdentity(root) &&
    viewerHasCapabilities(health, requiredCapabilities);
}

export function viewerHasCapabilities(health, requiredCapabilities = REQUIRED_VIEWER_CAPABILITIES) {
  const capabilities = Array.isArray(health?.capabilities) ? health.capabilities : [];
  return requiredCapabilities.every((capability) => capabilities.includes(capability));
}

/**
 * @param {string} baseUrl
 * @returns {Promise<ProGuide.ViewerHealth|null>}
 */
export async function fetchViewerHealth(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return /** @type {ProGuide.ViewerHealth} */ (await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function viewerLinks(baseUrl, runId) {
  const encodedRun = encodeURIComponent(runId);
  return {
    viewer_url: `${baseUrl}/runs`,
    run_url: `${baseUrl}/runs/${encodedRun}`,
    events_url: `${baseUrl}/runs/${encodedRun}/events`
  };
}

export function viewerBaseUrl(host, port) {
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const formattedHost = browserHost.includes(':') && !browserHost.startsWith('[') ? `[${browserHost}]` : browserHost;
  return `http://${formattedHost}:${port}`;
}

export function viewerPortCandidates({ firstPort, attempts }) {
  const ports = [];
  const appendRange = (start, count) => {
    const base = positiveNumber(start, 8787);
    const limit = positiveNumber(count, 20);
    for (let offset = 0; offset < limit; offset += 1) ports.push(base + offset);
  };
  appendRange(firstPort, attempts);
  if (Number(firstPort) !== 8787) appendRange(8787, attempts);
  return [...new Set(ports)];
}

export function rootIdentity(value) {
  const resolved = normalizeRootPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function stopDuplicateViewers({ rootPath, host, firstPort, attempts, keepPort }) {
  for (const port of viewerPortCandidates({ firstPort, attempts })) {
    if (port === keepPort) continue;
    const baseUrl = viewerBaseUrl(host, port);
    const health = await fetchViewerHealth(baseUrl);
    if (health?.service !== 'proguide-test-viewer') continue;
    if (rootIdentity(health.root) !== rootIdentity(rootPath)) continue;
    await shutdownViewer(baseUrl, rootPath, health);
  }
}

async function shutdownViewer(baseUrl, root, health) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${baseUrl}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
      signal: controller.signal
    });
    if (response.ok) {
      await sleep(300);
      return { stopped: !(await fetchViewerHealth(baseUrl)), message: 'shutdown_requested' };
    }
  } catch {
    // Older viewers do not expose /api/shutdown; fall back to pid when health reports it.
  } finally {
    clearTimeout(timer);
  }

  const pid = Number(health?.pid || 0);
  if (!pid || pid === process.pid) {
    return { stopped: false, message: 'shutdown_endpoint_unavailable' };
  }
  try {
    process.kill(pid);
    await sleep(500);
    return { stopped: !(await fetchViewerHealth(baseUrl)), message: 'pid_terminated' };
  } catch (error) {
    return { stopped: false, message: error.message || String(error) };
  }
}

async function stopStartingChild(child, baseUrl, root) {
  if (!child?.pid) return;
  const health = await fetchViewerHealth(baseUrl);
  if (health?.service === 'proguide-test-viewer' && rootIdentity(health.root) === rootIdentity(root)) {
    await shutdownViewer(baseUrl, root, health);
    return;
  }
  try {
    child.kill();
    await sleep(300);
  } catch {
    // The process may have already exited after a failed bind.
  }
}

async function waitForViewer(baseUrl, root, options = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, process.env.PROGUIDE_VIEWER_START_TIMEOUT_MS, DEFAULT_VIEWER_START_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await viewerMatchesRoot(baseUrl, root, options)) return true;
    await sleep(200);
  }
  return false;
}

function normalizeRootPath(value) {
  const resolved = path.resolve(String(value || ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function positiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
