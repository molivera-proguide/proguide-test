import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadUsageSummary, parsePlaywrightResults, prepareCasesRun, playwrightWorkerArgs, recordLlmUsage } from '../proguide-service.js';
import { rootIdentity, viewerHasCapabilities, viewerHealthMatchesRoot, viewerPortCandidates } from '../viewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(UI_ROOT, 'cli.js');

const SAMPLE_MARKDOWN = `## Caso 1 - Login exitoso

Criticidad: alta
Descripcion: Valida que un usuario pueda iniciar sesion.

Pasos:
- Abrir /login
- Completar usuario y password validos
- Enviar el formulario

Resultado esperado:
- Se muestra el dashboard
`;

const SECTIONED_MARKDOWN = `# E2E

## 0. Entorno
- Base URL: http://localhost:3000

## 1. Autenticacion

### TC-001 Login valido
Pasos:
1. Ir a /login
2. Ingresar usuario valido
Esperado:
- La pagina muestra Dashboard
---

### TC-002 Logout
Pasos:
- Abrir /home
- Hacer clic en Salir
**Esperado:** La URL contiene /login
`;

test('create/get-run/get-code/list-runs expose stable JSON', () => {
  const root = makeTempRoot();
  try {
    const created = runCli(['create', '--stdin', '--base-url', 'http://localhost:3000', '--json', '--root', root, '--no-viewer'], {
      input: SAMPLE_MARKDOWN
    });

    assert.equal(created.status, 0, created.stderr);
    const createPayload = parseJson(created.stdout);
    assert.equal(createPayload.status, 'ready');
    assert.match(createPayload.run_id, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
    assert.equal(createPayload.viewer_url, '');
    assert.equal(createPayload.summary.total, 1);
    assert.equal(createPayload.cases.length, 1);
    assert.equal(createPayload.cases[0].route, '/login');

    const runId = createPayload.run_id;
    const caseId = createPayload.cases[0].id;

    const getRun = runCli(['get-run', runId, '--json', '--root', root]);
    assert.equal(getRun.status, 0, getRun.stderr);
    const runPayload = parseJson(getRun.stdout);
    assert.equal(runPayload.status, 'ready');
    assert.equal(runPayload.summary.total, 1);
    assert.equal(runPayload.cases[0].id, caseId);
    assert.equal(runPayload.cases[0].route, '/login');
    const planPath = path.join(root, 'proguide_tests', 'runs', runId, 'test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(plan.cases[0].route, '/login');

    const code = runCli(['get-code', runId, caseId, '--json', '--root', root]);
    assert.equal(code.status, 0, code.stderr);
    assert.equal(parseJson(code.stdout).generated_code, null);

    const list = runCli(['list-runs', '--json', '--root', root, '--limit', '1']);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(parseJson(list.stdout).runs.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source paths outside root are rejected', () => {
  const root = makeTempRoot();
  const outside = path.join(os.tmpdir(), `proguide_outside_${process.pid}.md`);
  fs.writeFileSync(outside, SAMPLE_MARKDOWN, 'utf8');
  try {
    const result = runCli(['create', outside, '--base-url', 'http://localhost:3000', '--json', '--root', root, '--no-viewer']);
    assert.equal(result.status, 5);
    assert.match(parseJson(result.stdout).error, /source_path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('markdown parser ignores sections and keeps TC cases', () => {
  const root = makeTempRoot();
  try {
    const created = runCli(['create', '--stdin', '--base-url', 'http://localhost:3000', '--json', '--root', root, '--no-viewer'], {
      input: SECTIONED_MARKDOWN
    });

    assert.equal(created.status, 0, created.stderr);
    const payload = parseJson(created.stdout);
    assert.equal(payload.cases.length, 2);
    assert.deepEqual(payload.cases.map((item) => item.title), ['Login valido', 'Logout']);
    assert.deepEqual(payload.cases.map((item) => item.route), ['/login', '/home']);
    assert.deepEqual(payload.cases[0].expected_results, ['La pagina muestra Dashboard']);
    assert.deepEqual(payload.cases[1].expected_results, ['La URL contiene /login']);
    assert.equal(payload.cases[0].executable_steps[1].normalized_action, 'enter valid email');
    assert.equal(payload.cases.flatMap((item) => item.original_steps).some((step) => step.includes('Esperado')), false);
    const planPath = path.join(root, 'proguide_tests', 'runs', payload.run_id, 'test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.deepEqual(plan.cases.map((item) => item.route), ['/login', '/home']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create dry-run previews normalization without creating a run', () => {
  const root = makeTempRoot();
  try {
    const preview = runCli(['create', '--stdin', '--dry-run', '--json', '--root', root, '--no-viewer'], {
      input: SAMPLE_MARKDOWN
    });

    assert.equal(preview.status, 0, preview.stderr);
    const payload = parseJson(preview.stdout);
    assert.equal(payload.status, 'dry_run');
    assert.equal(payload.summary.total, 1);
    assert.equal(payload.summary.ready, 1);
    assert.equal(payload.cases.length, 1);
    assert.equal(fs.readdirSync(path.join(root, 'proguide_tests', 'runs')).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create dry-run human output marks fallback warnings', () => {
  const root = makeTempRoot();
  try {
    const preview = runCli(['create', '--stdin', '--dry-run', '--root', root, '--no-viewer'], {
      input: `## Caso 1: Ambiguo

Pasos:
- Revisar visualmente la pantalla

Resultado esperado:
- La pagina muestra Home
`
    });

    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /warning:/);
    assert.match(preview.stdout, /unchanged_step|step_confidence/);
    assert.equal(fs.readdirSync(path.join(root, 'proguide_tests', 'runs')).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('markdown data supports explicit test password only', () => {
  const root = makeTempRoot();
  try {
    const created = runCli(['create', '--stdin', '--base-url', 'http://localhost:3000', '--json', '--root', root, '--no-viewer'], {
      input: `## Caso 1: Password corto

Datos utilizados:
- Email: qa@example.com
- Password de prueba: 12345
- Password: secreto-real

Pasos:
- Ir a /login
- Completar password corto

Resultado esperado:
- La pagina muestra error
`
    });

    assert.equal(created.status, 0, created.stderr);
    const payload = parseJson(created.stdout);
    assert.equal(payload.cases[0].route, '/login');
    assert.deepEqual(payload.cases[0].data.user, { email: 'qa@example.com', password: '12345' });
    const runDir = path.join(root, 'proguide_tests', 'runs', payload.run_id);
    assert.equal(fs.readFileSync(path.join(runDir, 'normalized_cases.json'), 'utf8').includes('secreto-real'), false);
    assert.equal(fs.readFileSync(path.join(runDir, 'test_plan.json'), 'utf8').includes('secreto-real'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareCasesRun creates a run from structured cases with data', async () => {
  const root = makeTempRoot();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: 'http://localhost:3000',
      cases: [{
        title: 'Login estructurado',
        priority: 'alta',
        route: '/login',
        data: { user: { email: 'qa@example.com', password: 'secreto' } },
        data_used: ['Password: secreto'],
        steps: ['fill [data-testid=email] with qa@example.com', 'click [data-testid=submit]'],
        expected: ['expect text "Dashboard"']
      }, {
        title: 'Checkout estructurado',
        priority: 'alta',
        steps: ['go to /checkout', 'fill [data-testid=zipCode] with 1000', 'Verificar que [data-testid="cart-badge-count"] muestra 1'],
        expected: ['expect text "Resumen"']
      }]
    });

    assert.equal(prepared.run.status, 'ready');
    assert.equal(prepared.cases[1].route, '/checkout');
    assert.equal(prepared.cases[1].executable_steps[2].normalized_action, 'expect [data-testid="cart-badge-count"] to contain text "1"');
    assert.equal(prepared.cases[0].data.user.email, 'qa@example.com');
    assert.equal(Object.hasOwn(prepared.cases[0].data.user, 'password'), false);
    const planPath = path.join(root, 'proguide_tests', 'runs', prepared.run.id, 'test_plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(plan.cases[0].data.user.email, 'qa@example.com');
    assert.equal(Object.hasOwn(plan.cases[0].data.user, 'password'), false);
    assert.deepEqual(plan.cases[0].steps, [
      'fill [data-testid=email] with qa@example.com',
      'click [data-testid=submit]'
    ]);
    assert.equal(plan.cases[1].route, '/checkout');
    assert.equal(plan.cases[1].steps[2], 'expect [data-testid="cart-badge-count"] to contain text "1"');
    const runDir = path.join(root, 'proguide_tests', 'runs', prepared.run.id);
    assert.equal(fs.readFileSync(path.join(runDir, 'source_cases.json'), 'utf8').includes('secreto'), false);
    assert.equal(fs.readFileSync(path.join(runDir, 'normalized_cases.json'), 'utf8').includes('secreto'), false);
    assert.equal(fs.readFileSync(path.join(runDir, 'test_plan.json'), 'utf8').includes('secreto'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareCasesRun normalizes natural data-testid references from structured cases', async () => {
  const root = makeTempRoot();
  try {
    const prepared = await prepareCasesRun({
      root,
      baseUrl: 'http://localhost:3000',
      cases: [{
        id: 'tc_001',
        title: 'Login estructurado',
        priority: 'alta',
        route: '/login',
        steps: [
          'Navegar a /login',
          "Ingresar el email 'customer@devshop.com' en el campo login-email",
          "Ingresar la contrasena 'password' en el campo login-password",
          'Hacer clic en el boton login-submit-btn',
          'Verificar que el elemento login-error-msg es visible',
          "Verificar que el badge cart-badge-count muestra '1'",
          'Hacer clic en el boton cart-btn para ir al carrito',
          'Verificar que el atributo data-theme cambio al tema opuesto',
          'Verificar que el dashboard de administracion es visible'
        ],
        expected: ['Se muestra el mensaje de error']
      }]
    });

    const steps = prepared.cases[0].executable_steps.map((step) => step.normalized_action);
    assert.deepEqual(steps, [
      'go to /login',
      'fill [data-testid="login-email"] with customer@devshop.com',
      'fill [data-testid="login-password"] with password',
      'click [data-testid="login-submit-btn"]',
      'expect [data-testid="login-error-msg"] to be visible',
      'expect [data-testid="cart-badge-count"] to contain text "1"',
      'click [data-testid="cart-btn"]',
      'Verificar que el atributo data-theme cambio al tema opuesto',
      'expect text "Dashboard"'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareCasesRun records project and run user identity', async () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@proguide/shop-front' }), 'utf8');
    assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8', windowsHide: true }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'molivera@proguidemc.com'], { cwd: root, encoding: 'utf8', windowsHide: true }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Mario Olivera'], { cwd: root, encoding: 'utf8', windowsHide: true }).status, 0);

    const prepared = await prepareCasesRun({
      root,
      baseUrl: 'http://localhost:3000',
      cases: [{
        id: 'tc_001',
        title: 'Login estructurado',
        steps: ['go to /login'],
        expected: ['expect text "Login"']
      }]
    });

    assert.equal(prepared.run.run_user_email, 'molivera@proguidemc.com');
    assert.equal(prepared.run.run_user_name, 'Mario Olivera');
    assert.equal(prepared.run.company_domain, 'proguidemc.com');
    assert.equal(prepared.run.project_name, 'shop-front');
    assert.equal(prepared.run.project_key, 'shop-front');
    assert.equal(prepared.run.workspace_root, path.resolve(root));
    assert.equal(prepared.run.identity_source.run_user_email, 'git');
    assert.equal(prepared.run.identity_source.project_name, 'package_json');

    const runPath = path.join(root, 'proguide_tests', 'runs', prepared.run.id, 'run.json');
    const stored = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    assert.equal(stored.run_user_email, 'molivera@proguidemc.com');
    assert.equal(stored.project_name, 'shop-front');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parsePlaywrightResults keeps spec results aligned by case id prefix', async () => {
  const root = makeTempRoot();
  try {
    const runDir = path.join(root, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'playwright-report.json'), JSON.stringify({
      suites: [{
        specs: [{
          title: '[tc_003] Agregar producto al carrito',
          tests: [{
            results: [{
              status: 'passed',
              duration: 4578,
              steps: [{ title: 'go to /' }],
              attachments: []
            }]
          }]
        }, {
          title: '[tc_004] Login admin',
          tests: [{
            results: [{
              status: 'failed',
              duration: 11648,
              error: { message: 'expected admin dashboard' },
              steps: [{ title: 'dashboard visible' }],
              attachments: []
            }]
          }]
        }]
      }]
    }), 'utf8');

    const results = await parsePlaywrightResults({
      runDir,
      reportPath: path.join(runDir, 'playwright-report.json'),
      plan: {
        cases: [{
          id: 'tc_003',
          title: 'Agregar producto al carrito',
          steps: ['go to /'],
          expected: ['cart updated']
        }, {
          id: 'tc_004',
          title: 'Login admin',
          steps: ['go to /login'],
          expected: ['dashboard visible']
        }]
      }
    });

    assert.deepEqual(results.map((item) => [item.id, item.status, item.message]), [
      ['tc_003', 'passed', ''],
      ['tc_004', 'failed', 'expected admin dashboard']
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('playwright worker args enable parallel run execution by default', () => {
  assert.deepEqual(playwrightWorkerArgs({ runner: { parallel_workers: 'auto' } }), []);
  assert.deepEqual(playwrightWorkerArgs({ runner: { parallel_workers: 3 } }), ['--workers=3']);
  assert.deepEqual(playwrightWorkerArgs({ runner: { parallel_workers: '1' } }), ['--workers=1']);
  assert.throws(
    () => playwrightWorkerArgs({ runner: { parallel_workers: 'many' } }),
    /parallel_workers invalido/
  );
});

test('generated ESM runtime shim works in type module workspaces', () => {
  const root = makeTempRoot();
  try {
    const generatedDir = path.join(root, 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    fs.writeFileSync(path.join(generatedDir, 'proguide-test-runtime.mjs'), [
      "import { createRequire } from 'node:module';",
      `const req = createRequire(${JSON.stringify(path.join(UI_ROOT, 'package.json'))});`,
      "const runtime = req('@playwright/test');",
      'export const test = runtime.test;',
      'export const expect = runtime.expect;',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(generatedDir, 'test_markdown_cases.spec.ts'), [
      "import { test, expect } from './proguide-test-runtime.mjs';",
      "test('[tc_001] smoke', async () => {",
      '  expect(1 + 1).toBe(2);',
      '});',
      ''
    ].join('\n'), 'utf8');
    const reportPath = path.join(root, 'playwright-report.json');
    fs.writeFileSync(path.join(root, 'playwright.config.cjs'), [
      'module.exports = {',
      `  testDir: ${JSON.stringify(generatedDir)},`,
      `  reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],`,
      '  use: { browserName: "chromium" }',
      '};',
      ''
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(UI_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--config',
      path.join(root, 'playwright.config.cjs'),
      '--workers=1'
    ], {
      cwd: root,
      env: {
        ...process.env,
        PROGUIDE_PLAYWRIGHT_REQUIRE: path.join(UI_ROOT, 'package.json')
      },
      encoding: 'utf8',
      windowsHide: true
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.stats.expected, 1);
    assert.equal(report.stats.unexpected, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('viewer discovery includes the default port range for reuse', () => {
  assert.deepEqual(viewerPortCandidates({ firstPort: 8789, attempts: 3 }), [
    8789,
    8790,
    8791,
    8787,
    8788
  ]);
});

test('viewer health requires usage capability before reuse', () => {
  const root = makeTempRoot();
  try {
    assert.equal(viewerHealthMatchesRoot({
      service: 'proguide-test-viewer',
      root,
      capabilities: ['usage']
    }, root), true);
    assert.equal(viewerHealthMatchesRoot({
      service: 'proguide-test-viewer',
      root
    }, root), false);
    assert.equal(viewerHasCapabilities({ capabilities: ['runs'] }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stop-viewer reports no active viewer for an empty workspace', () => {
  const root = makeTempRoot();
  try {
    const result = runCli(['stop-viewer', '--json', '--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const payload = parseJson(result.stdout);
    assert.equal(rootIdentity(payload.root), rootIdentity(root));
    assert.equal(payload.stopped_count, 0);
    assert.equal(payload.stopped, 0);
    assert.deepEqual(payload.viewers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config get/set reads and writes proguide_tests/config.yaml', () => {
  const root = makeTempRoot();
  try {
    const set = runCli(['config', 'set', 'llm.provider', 'anthropic', '--json', '--root', root]);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(parseJson(set.stdout).value, 'anthropic');

    const get = runCli(['config', 'get', 'llm.provider', '--json', '--root', root]);
    assert.equal(get.status, 0, get.stderr);
    assert.deepEqual(parseJson(get.stdout), { key: 'llm.provider', value: 'anthropic' });

    const text = fs.readFileSync(path.join(root, 'proguide_tests', 'config.yaml'), 'utf8');
    assert.match(text, /llm:/);
    assert.match(text, /provider: anthropic/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new workspaces default to Anthropic Haiku and screenshot evidence', () => {
  const root = makeTempRoot();
  try {
    const provider = runCli(['config', 'get', 'llm.provider', '--json', '--root', root]);
    assert.equal(provider.status, 0, provider.stderr);
    assert.deepEqual(parseJson(provider.stdout), { key: 'llm.provider', value: 'anthropic' });

    const model = runCli(['config', 'get', 'llm.model', '--json', '--root', root]);
    assert.equal(model.status, 0, model.stderr);
    assert.deepEqual(parseJson(model.stdout), { key: 'llm.model', value: 'claude-haiku-4-5-20251001' });

    const screenshots = runCli(['config', 'get', 'runner.screenshots', '--json', '--root', root]);
    assert.equal(screenshots.status, 0, screenshots.stderr);
    assert.deepEqual(parseJson(screenshots.stdout), { key: 'runner.screenshots', value: 'on' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor does not require an API key in the shell', () => {
  const root = makeTempRoot();
  try {
    const result = runCli(['doctor', '--json', '--root', root], {
      env: {
        API_KEY: '',
        ANTHROPIC_API_KEY: '',
        PROGUIDE_LLM_API_KEY: ''
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = parseJson(result.stdout);
    assert.equal(payload.status, 'ok');
    const llm = payload.checks.find((check) => check.name === 'llm');
    assert.equal(llm, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Anthropic SDK dependency is available', async () => {
  const module = await import('@anthropic-ai/sdk');
  assert.equal(typeof module.default, 'function');
});

test('LLM usage is recorded with Anthropic cost estimate and exposed by CLI', async () => {
  const root = makeTempRoot();
  try {
    const runId = 'usage_run_001';
    const runDir = path.join(root, 'proguide_tests', 'runs', runId);
    await recordLlmUsage({
      root,
      runId,
      runDir,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      purpose: 'generar codigo TypeScript Playwright',
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 500,
        cache_creation: {
          ephemeral_5m_input_tokens: 100,
          ephemeral_1h_input_tokens: 50
        }
      }
    });

    const summary = await loadUsageSummary(root, { runId });
    assert.equal(summary.entries_count, 1);
    assert.equal(summary.input_tokens, 1000);
    assert.equal(summary.output_tokens, 2000);
    assert.equal(summary.cache_read_input_tokens, 500);
    assert.equal(summary.cache_creation_input_tokens, 150);
    assert.equal(summary.estimated_cost_usd, 0.011275);

    const workspaceUsage = runCli(['usage', '--json', '--root', root]);
    assert.equal(workspaceUsage.status, 0, workspaceUsage.stderr);
    const workspacePayload = parseJson(workspaceUsage.stdout);
    assert.equal(workspacePayload.entries_count, 1);
    assert.equal(workspacePayload.by_run[0].key, runId);
    assert.equal(workspacePayload.estimated_cost_usd, 0.011275);

    const runUsage = runCli(['usage', '--run', runId, '--json', '--root', root]);
    assert.equal(runUsage.status, 0, runUsage.stderr);
    const runPayload = parseJson(runUsage.stdout);
    assert.equal(runPayload.scope, 'run');
    assert.equal(runPayload.run_id, runId);
    assert.equal(runPayload.entries[0].model, 'claude-haiku-4-5-20251001');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent-setup exposes Claude Code, Cursor, and generic MCP snippets', () => {
  const result = runCli(['agent-setup', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.command, 'proguide mcp');
  assert.equal(payload.clients.claude_code.install_command, 'claude mcp add proguide-test --env ANTHROPIC_API_KEY=your_api_key -- proguide mcp');
  assert.match(payload.clients.claude_code.npx_command, /npx @proguide\/test@latest mcp/);
  assert.equal(payload.clients.cursor.config.mcpServers['proguide-test'].command, 'proguide');
  assert.equal(payload.clients.cursor.config.mcpServers['proguide-test'].env.ANTHROPIC_API_KEY, 'your_api_key');
  assert.deepEqual(payload.clients.generic.args, ['mcp']);
});

test('mcp exposes prompts with agent instructions', () => {
  const listed = runCli(['mcp'], {
    input: '{"jsonrpc":"2.0","id":1,"method":"prompts/list"}\n'
  });
  assert.equal(listed.status, 0, listed.stderr);
  const listPayload = parseJson(lastJsonLine(listed.stdout));
  assert.deepEqual(listPayload.result.prompts.map((prompt) => prompt.name), [
    'run_cases',
    'create_run',
    'run_markdown_cases',
    'create_run_from_markdown'
  ]);

  const fetched = runCli(['mcp'], {
    input: '{"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"run_markdown_cases","arguments":{"base_url":"http://localhost:3000","markdown":"## Caso 1"}}}\n'
  });
  assert.equal(fetched.status, 0, fetched.stderr);
  const promptPayload = parseJson(lastJsonLine(fetched.stdout));
  assert.match(promptPayload.result.messages[0].content.text, /run_markdown_cases/);
});

test('mcp exposes the full tool surface', () => {
  const listed = runCli(['mcp'], {
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'
  });
  assert.equal(listed.status, 0, listed.stderr);
  const payload = parseJson(lastJsonLine(listed.stdout));
  assert.deepEqual(payload.result.tools.map((tool) => tool.name), [
    'run_cases',
    'create_run',
    'run_markdown_cases',
    'create_run_from_markdown',
    'execute_run',
    'get_run',
    'get_generated_code',
    'list_runs',
    'start_viewer',
    'stop_viewer'
  ]);
  const executeRun = payload.result.tools.find((tool) => tool.name === 'execute_run');
  assert.equal(executeRun.inputSchema.properties.from_plan.type, 'boolean');
});

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env || {})
  };
  for (const [key, value] of Object.entries(options.env || {})) {
    if (value === '') delete env[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: UI_ROOT,
    env: {
      ...env,
      PROGUIDE_VIEWER_PORT: '18787'
    },
    input: options.input || '',
    encoding: 'utf8',
    windowsHide: true
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function lastJsonLine(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).at(-1);
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proguide-cli-'));
}
