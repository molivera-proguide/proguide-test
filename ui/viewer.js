import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewerCache = new Map();

export async function ensureViewer(root, options = {}) {
  const rootPath = path.resolve(root);
  const host = options.host || process.env.PROGUIDE_VIEWER_HOST || process.env.PROGUIDE_UI_HOST || '127.0.0.1';
  const firstPort = positiveNumber(options.port, process.env.PROGUIDE_VIEWER_PORT, process.env.PROGUIDE_UI_PORT, 8787);
  const attempts = positiveNumber(options.attempts, process.env.PROGUIDE_VIEWER_PORT_ATTEMPTS, 20);
  const rootKey = `${rootIdentity(rootPath)}|${host}|${firstPort}`;
  const cached = viewerCache.get(rootKey);

  if (cached && await viewerMatchesRoot(cached.baseUrl, rootPath)) {
    return { ...cached, started: false };
  }

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = firstPort + offset;
    const baseUrl = viewerBaseUrl(host, port);
    if (await viewerMatchesRoot(baseUrl, rootPath)) {
      const info = { baseUrl, port, started: false };
      viewerCache.set(rootKey, info);
      return info;
    }

    const health = await fetchViewerHealth(baseUrl);
    if (health?.service === 'proguide-test-viewer') {
      continue;
    }

    try {
      const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
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

    if (await waitForViewer(baseUrl, rootPath)) {
      const info = { baseUrl, port, started: true };
      viewerCache.set(rootKey, info);
      return info;
    }
  }

  throw new Error(`No se pudo iniciar el visor Fastify desde el puerto ${firstPort}.`);
}

export async function viewerMatchesRoot(baseUrl, root) {
  const health = await fetchViewerHealth(baseUrl);
  return health?.service === 'proguide-test-viewer' && rootIdentity(health.root) === rootIdentity(root);
}

export async function fetchViewerHealth(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
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

export function rootIdentity(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function waitForViewer(baseUrl, root) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await viewerMatchesRoot(baseUrl, root)) return true;
    await sleep(200);
  }
  return false;
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
