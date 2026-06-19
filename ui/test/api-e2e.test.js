import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  executePreparedRun,
  loadGeneratedCaseCode,
  prepareMarkdownRun,
  prepareCasesRun,
  recordLlmUsage
} from '../proguide-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(UI_ROOT, 'server.js');

test('prepareMarkdownRun normalizes REST API Markdown cases', async () => {
  const root = makeTempRoot();
  try {
    const source = path.join(root, 'api-cases.md');
    fs.writeFileSync(source, `## TC-API-001 Crear usuario

Tipo: API
Metodo: POST
Endpoint: /users
Headers:
- content-type: application/json
Body:
- name: Mario

Resultado esperado:
- Status 201
- body.name = Mario
- body.id existe
`, 'utf8');

    const prepared = await prepareMarkdownRun({
      root,
      sourceMd: source,
      baseUrl: 'http://api.test'
    });

    assert.equal(prepared.cases[0].type, 'api');
    assert.equal(prepared.cases[0].request.method, 'POST');
    assert.equal(prepared.cases[0].request.path, '/users');
    assert.deepEqual(prepared.cases[0].request.body, { name: 'Mario' });
    assert.equal(prepared.cases[0].assertions.some((item) => item.type === 'status' && item.expected === 201), true);
    assert.equal(prepared.cases[0].assertions.some((item) => item.path === 'id' && item.operator === 'exists'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareMarkdownRun accepts multiple REST API Markdown sources', async () => {
  const root = makeTempRoot();
  try {
    const first = path.join(root, 'auth.md');
    const second = path.join(root, 'items.md');
    fs.writeFileSync(first, `## TC-API-LOGIN Login invalido

Tipo: API
Metodo: POST
Endpoint: /login
Body:
- email: qa@example.test
- password: wrong-password
Resultado esperado:
- Status 401
`, 'utf8');
    fs.writeFileSync(second, `## TC-API-ITEMS Listar items

Tipo: API
Metodo: GET
Endpoint: /items
Resultado esperado:
- Status 200
- body.items isArray
`, 'utf8');

    const prepared = await prepareMarkdownRun({
      root,
      sourceMd: [first, second],
      baseUrl: 'http://api.test'
    });

    assert.equal(prepared.cases.length, 2);
    assert.equal(prepared.run.source_filename, 'auth.md, items.md');
    assert.deepEqual(prepared.cases.map((item) => item.request.path), ['/login', '/items']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executePreparedRun runs REST API cases through Playwright request', async () => {
  const root = makeTempRoot();
  const api = await startSampleApi();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: api.baseUrl,
      cases: [{
        id: 'api_health',
        type: 'api',
        title: 'Health devuelve estado operativo',
        request: {
          method: 'GET',
          path: '/health'
        },
        expected: [
          'Status 200',
          'body.service = sample-api',
          'body.ok = true'
        ]
      }, {
        id: 'api_create_user',
        type: 'api',
        title: 'Crear usuario',
        request: {
          method: 'POST',
          path: '/users',
          headers: { 'content-type': 'application/json' },
          body: { name: 'Mario' },
          expected_status: 201
        },
        assertions: [
          { path: 'name', equals: 'Mario' },
          { path: 'id', exists: true },
          { header: 'content-type', contains: 'application/json' }
        ]
      }]
    });

    assert.deepEqual(prepared.cases.map((item) => item.type), ['api', 'api']);
    const planPath = path.join(root, 'proguide_tests', 'runs', prepared.run.id, 'test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(plan.cases[1].request.method, 'POST');
    assert.deepEqual(plan.cases[1].request.body, { name: 'Mario' });

    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: api.baseUrl
    });

    assert.deepEqual(summary.results.map((item) => item.status), ['passed', 'passed']);
    assert.match(summary.results[0].steps.join('\n'), /GET \/health/);
    assert.match(summary.results[1].steps.join('\n'), /POST \/users/);
    assert.equal(summary.results[0].api_evidence.length, 1);
    assert.equal(summary.results[1].api_evidence.length, 1);
    assert.equal(summary.results[0].api_evidence[0].request.method, 'GET');
    assert.equal(summary.results[0].api_evidence[0].response.status, 200);
    assert.equal(summary.results[0].api_evidence[0].response.body.service, 'sample-api');
    assert.equal(summary.results[1].api_evidence[0].request.body.name, 'Mario');
    assert.match(summary.results[0].api_evidence[0].path, /^api_evidence\/api_health\/.+\.json$/);
    const evidencePath = path.join(root, 'proguide_tests', 'runs', prepared.run.id, summary.results[0].api_evidence[0].path);
    const evidenceFile = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(evidenceFile.kind, 'api_evidence');
    assert.equal(evidenceFile.response.status, 200);
    const evidenceHtml = fs.readFileSync(path.join(root, 'proguide_tests', 'runs', prepared.run.id, 'evidence.html'), 'utf8');
    assert.match(evidenceHtml, /API evidence/);
    assert.match(evidenceHtml, /sample-api/);

    const generated = await loadGeneratedCaseCode(root, prepared.run.id, 'api_create_user');
    assert.equal(generated.path, 'generated/test_api_cases.spec.ts');
    assert.match(generated.code, /\[api_create_user]/);
    assert.match(generated.code, /"name": "Mario"/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API cases keep assertions unique and preserve request secrets for execution', async () => {
  const root = makeTempRoot();
  const api = await startSampleApi();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: api.baseUrl,
      cases: [{
        id: 'api_login',
        type: 'api',
        title: 'Login API',
        request: {
          method: 'POST',
          path: '/login',
          body: {
            email: 'qa@example.test',
            password: 'secret-test-password'
          },
          expected_status: 200
        },
        assertions: [
          { status: 200 },
          { path: 'access_token', exists: true }
        ],
        expected: ['Status 200']
      }]
    });

    assert.deepEqual(
      prepared.cases[0].assertions.filter((item) => item.type === 'status'),
      [{ type: 'status', expected: 200 }]
    );
    assert.deepEqual(prepared.cases[0].request.body, {
      email: 'qa@example.test',
      password: 'secret-test-password'
    });

    const planPath = path.join(root, 'proguide_tests', 'runs', prepared.run.id, 'test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.deepEqual(
      plan.cases[0].assertions.filter((item) => item.type === 'status'),
      [{ type: 'status', expected: 200 }]
    );
    assert.deepEqual(plan.cases[0].request.body, {
      email: 'qa@example.test',
      password: 'secret-test-password'
    });

    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: api.baseUrl
    });

    assert.equal(summary.results[0].status, 'passed');
    const generated = await loadGeneratedCaseCode(root, prepared.run.id, 'api_login');
    assert.equal((generated.code.match(/"type": "status"/g) || []).length, 1);
    assert.match(generated.code, /secret-test-password/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API flows capture variables and reuse them in later requests', async () => {
  const root = makeTempRoot();
  const api = await startSampleApi();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: api.baseUrl,
      cases: [{
        id: 'api_auth_flow',
        type: 'api',
        title: 'Login y perfil autenticado',
        requests: [
          {
            id: 'login',
            method: 'POST',
            path: '/login',
            body: {
              email: 'qa@example.test',
              password: 'secret-test-password'
            },
            expected_status: 200,
            assertions: [{ path: 'access_token', exists: true }],
            save: { access_token: 'access_token' }
          },
          {
            id: 'profile',
            method: 'GET',
            path: '/profile',
            headers: { authorization: 'Bearer {{access_token}}' },
            expected_status: 200,
            assertions: [
              { path: 'email', equals: 'qa@example.test' },
              { path: 'roles', isArray: true }
            ]
          }
        ]
      }]
    });

    assert.equal(prepared.cases[0].requests.length, 2);
    assert.deepEqual(prepared.cases[0].requests[0].captures, [{
      name: 'access_token',
      source: 'body',
      path: 'access_token'
    }]);
    const planPath = path.join(root, 'proguide_tests', 'runs', prepared.run.id, 'test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(plan.cases[0].requests[1].request.headers.authorization, 'Bearer {{access_token}}');

    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: api.baseUrl
    });

    assert.equal(summary.results[0].status, 'passed');
    assert.match(summary.results[0].steps.join('\n'), /POST \/login/);
    assert.match(summary.results[0].steps.join('\n'), /GET \/profile/);
    const generated = await loadGeneratedCaseCode(root, prepared.run.id, 'api_auth_flow');
    assert.match(generated.code, /resolveVariable/);
    assert.match(generated.code, /applyCapture/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API failures expose actual response body and optional debug request', async () => {
  const root = makeTempRoot();
  const api = await startSampleApi();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: api.baseUrl,
      cases: [{
        id: 'api_debug_failure',
        type: 'api',
        title: 'Login falla con respuesta visible',
        debug: true,
        request: {
          method: 'POST',
          path: '/login',
          body: {
            email: 'qa@example.test',
            password: 'wrong-password'
          },
          expected_status: 200
        },
        assertions: [{ path: 'access_token', exists: true }]
      }]
    });

    assert.equal(prepared.cases[0].executable_steps[0].normalized_action, 'api POST /login');
    assert.deepEqual(prepared.cases[0].executable_steps[0].request, {
      method: 'POST',
      path: '/login',
      headers: '{}',
      query: '{}',
      body: '{ email, password }'
    });

    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: api.baseUrl
    });

    const [result] = summary.results;
    assert.equal(result.status, 'failed');
    assert.equal(result.actual_response.status, 401);
    assert.deepEqual(result.actual_response.body, { error: 'invalid_credentials' });
    assert.equal(result.actual_response.request.body.password, 'wrong-password');
    assert.match(result.error_details, /ProGuide API debug/);
    assert.match(result.error_details, /invalid_credentials/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API assertions support arrays and reject unsupported operators during create', async () => {
  const root = makeTempRoot();
  const api = await startSampleApi();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: api.baseUrl,
      cases: [{
        id: 'api_items_array',
        type: 'api',
        title: 'Items es arreglo',
        request: {
          method: 'GET',
          path: '/items',
          expected_status: 200
        },
        assertions: [
          { path: 'items', isArray: true }
        ]
      }, {
        id: 'api_root_array',
        type: 'api',
        title: 'Body raiz es arreglo',
        request: {
          method: 'GET',
          path: '/items-root',
          expected_status: 200
        },
        assertions: [
          { path: '$', isArray: true },
          { path: '$[0].id', equals: 'item_001' }
        ]
      }]
    });

    assert.equal(prepared.cases[0].assertions.some((item) => item.operator === 'is_array'), true);
    assert.equal(prepared.cases[1].assertions.some((item) => item.path === '' && item.operator === 'is_array'), true);

    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: api.baseUrl
    });

    assert.deepEqual(summary.results.map((item) => item.status), ['passed', 'passed']);

    await assert.rejects(
      () => prepareCasesRun({
        root,
        baseUrl: api.baseUrl,
        cases: [{
          id: 'api_unsupported_assertion',
          type: 'api',
          title: 'Asercion no soportada',
          request: {
            method: 'GET',
            path: '/health',
            expected_status: 200
          },
          assertions: [
            { path: 'ok', greaterThan: 0 }
          ]
        }]
      }),
      /Asercion API no soportada/
    );
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API natural-language steps do not normalize to UI selectors', async () => {
  const root = makeTempRoot();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: 'http://api.test',
      cases: [{
        id: 'api_step_normalization',
        type: 'api',
        title: 'Token exists',
        request: {
          method: 'POST',
          path: '/login',
          expected_status: 200
        },
        steps: ['expect response body field access_token exists'],
        assertions: [{ path: 'access_token', exists: true }]
      }]
    });

    const normalized = prepared.cases[0].executable_steps[0].normalized_action;
    assert.equal(normalized, 'api assert body.access_token exists');
    assert.equal(normalized.includes('data-testid'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('viewer exposes run and usage data through REST API endpoints', async () => {
  const root = makeTempRoot();
  const port = await freePort();
  const viewer = startViewer(root, port);
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: 'http://example.test',
      cases: [{
        id: 'api_seed',
        type: 'api',
        title: 'Seed',
        request: { method: 'GET', path: '/health', expected_status: 200 }
      }]
    });
    const runDir = path.join(root, 'proguide_tests', 'runs', prepared.run.id);
    await recordLlmUsage({
      root,
      runId: prepared.run.id,
      runDir,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      purpose: 'api e2e seed',
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${baseUrl}/api/health`, viewer);
    assert.equal(health.service, 'proguide-test-viewer');
    assert.equal(path.resolve(health.root), path.resolve(root));
    assert.equal(health.port, port);

    const runResponse = await fetchJson(`${baseUrl}/api/runs/${prepared.run.id}`);
    assert.equal(runResponse.run.id, prepared.run.id);
    assert.equal(runResponse.cases[0].request.method, 'GET');
    assert.equal(runResponse.events.some((event) => event.type === 'run_created'), true);

    const runHtml = await fetchText(`${baseUrl}/runs/${prepared.run.id}`);
    assert.doesNotMatch(runHtml, /data-progress-step="dom"/);
    assert.doesNotMatch(runHtml, />Browser<\/span>/);
    assert.match(runHtml, /data-progress-step="code"/);

    const workspaceUsage = await fetchJson(`${baseUrl}/api/usage`);
    assert.equal(workspaceUsage.scope, 'workspace');
    assert.equal(workspaceUsage.entries_count, 1);
    assert.equal(workspaceUsage.by_run[0].key, prepared.run.id);

    const runUsage = await fetchJson(`${baseUrl}/api/runs/${prepared.run.id}/usage`);
    assert.equal(runUsage.scope, 'run');
    assert.equal(runUsage.run_id, prepared.run.id);
    assert.equal(runUsage.entries_count, 1);

    const editResponse = await fetch(`${baseUrl}/api/runs/${prepared.run.id}/cases`, { method: 'POST' });
    assert.equal(editResponse.status, 410);
  } finally {
    await stopViewer(viewer, `http://127.0.0.1:${port}`, root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proguide-api-e2e-'));
}

function startSampleApi() {
  const server = http.createServer((request, response) => {
    void handleSampleApiRequest(request, response);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

async function handleSampleApiRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    return sendJson(response, 200, { service: 'sample-api', ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/users') {
    const payload = await readJsonBody(request);
    return sendJson(response, 201, { id: 'usr_001', name: payload.name || '' });
  }
  if (request.method === 'POST' && url.pathname === '/login') {
    const payload = await readJsonBody(request);
    if (payload.email === 'qa@example.test' && payload.password === 'secret-test-password') {
      return sendJson(response, 200, { access_token: 'token_123', token_type: 'Bearer' });
    }
    return sendJson(response, 401, { error: 'invalid_credentials' });
  }
  if (request.method === 'GET' && url.pathname === '/profile') {
    if (request.headers.authorization === 'Bearer token_123') {
      return sendJson(response, 200, { email: 'qa@example.test', roles: ['qa'] });
    }
    return sendJson(response, 401, { error: 'missing_or_invalid_token' });
  }
  if (request.method === 'GET' && url.pathname === '/items') {
    return sendJson(response, 200, { items: [{ id: 'item_001' }] });
  }
  if (request.method === 'GET' && url.pathname === '/items-root') {
    return sendJson(response, 200, [{ id: 'item_001' }, { id: 'item_002' }]);
  }
  return sendJson(response, 404, { error: 'not_found' });
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function startViewer(root, port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: UI_ROOT,
    env: {
      ...process.env,
      PROGUIDE_UI_ROOT: root,
      PROGUIDE_UI_HOST: '127.0.0.1',
      PROGUIDE_UI_PORT: String(port),
      PROGUIDE_VIEWER_IDLE_TIMEOUT_MS: '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  return { child, output };
}

async function waitForJson(url, viewer) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (viewer.child.exitCode !== null) {
      throw new Error(`Viewer exited early: ${viewer.output.join('')}`);
    }
    try {
      return await fetchJson(url);
    } catch {
      await sleep(120);
    }
  }
  throw new Error(`Viewer did not become ready: ${viewer.output.join('')}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.text();
}

async function stopViewer(viewer, baseUrl, root) {
  try {
    await fetch(`${baseUrl}/api/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root })
    });
  } catch {
    // Fall back to killing the process below.
  }
  await sleep(300);
  if (viewer.child.exitCode === null) viewer.child.kill();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
