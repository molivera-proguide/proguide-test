import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCasesRun } from '../proguide-service.js';

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

    const runId = createPayload.run_id;
    const caseId = createPayload.cases[0].id;

    const getRun = runCli(['get-run', runId, '--json', '--root', root]);
    assert.equal(getRun.status, 0, getRun.stderr);
    const runPayload = parseJson(getRun.stdout);
    assert.equal(runPayload.status, 'ready');
    assert.equal(runPayload.summary.total, 1);
    assert.equal(runPayload.cases[0].id, caseId);

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
    assert.deepEqual(payload.cases[0].expected_results, ['La pagina muestra Dashboard']);
    assert.deepEqual(payload.cases[1].expected_results, ['La URL contiene /login']);
    assert.equal(payload.cases[0].executable_steps[1].normalized_action, 'enter valid email');
    assert.equal(payload.cases.flatMap((item) => item.original_steps).some((step) => step.includes('Esperado')), false);
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
      }]
    });

    assert.equal(prepared.run.status, 'ready');
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
    const runDir = path.join(root, 'proguide_tests', 'runs', prepared.run.id);
    assert.equal(fs.readFileSync(path.join(runDir, 'source_cases.json'), 'utf8').includes('secreto'), false);
    assert.equal(fs.readFileSync(path.join(runDir, 'normalized_cases.json'), 'utf8').includes('secreto'), false);
    assert.equal(fs.readFileSync(path.join(runDir, 'test_plan.json'), 'utf8').includes('secreto'), false);
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

test('new workspaces default to Anthropic Sonnet without QA configuration', () => {
  const root = makeTempRoot();
  try {
    const provider = runCli(['config', 'get', 'llm.provider', '--json', '--root', root]);
    assert.equal(provider.status, 0, provider.stderr);
    assert.deepEqual(parseJson(provider.stdout), { key: 'llm.provider', value: 'anthropic' });

    const model = runCli(['config', 'get', 'llm.model', '--json', '--root', root]);
    assert.equal(model.status, 0, model.stderr);
    assert.deepEqual(parseJson(model.stdout), { key: 'llm.model', value: 'claude-sonnet-4-6' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent-setup exposes Claude Code, Cursor, and generic MCP snippets', () => {
  const result = runCli(['agent-setup', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.command, 'proguide mcp');
  assert.equal(payload.clients.claude_code.install_command, 'claude mcp add proguide-test --env API_KEY=your_api_key -- proguide mcp');
  assert.match(payload.clients.claude_code.npx_command, /npx @proguide\/test@latest mcp/);
  assert.equal(payload.clients.cursor.config.mcpServers['proguide-test'].command, 'proguide');
  assert.equal(payload.clients.cursor.config.mcpServers['proguide-test'].env.API_KEY, 'your_api_key');
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
    'list_runs'
  ]);
  const executeRun = payload.result.tools.find((tool) => tool.name === 'execute_run');
  assert.equal(executeRun.inputSchema.properties.from_plan.type, 'boolean');
});

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: UI_ROOT,
    env: {
      ...process.env,
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
