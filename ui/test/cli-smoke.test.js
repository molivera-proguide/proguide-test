import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  assert.match(payload.clients.claude_code.install_command, /claude mcp add/);
  assert.equal(payload.clients.cursor.config.mcpServers['proguide-test'].command, 'proguide');
  assert.deepEqual(payload.clients.generic.args, ['mcp']);
});

test('mcp exposes prompts with agent instructions', () => {
  const listed = runCli(['mcp'], {
    input: '{"jsonrpc":"2.0","id":1,"method":"prompts/list"}\n'
  });
  assert.equal(listed.status, 0, listed.stderr);
  const listPayload = parseJson(lastJsonLine(listed.stdout));
  assert.deepEqual(listPayload.result.prompts.map((prompt) => prompt.name), ['run_markdown_cases', 'create_run_from_markdown']);

  const fetched = runCli(['mcp'], {
    input: '{"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"run_markdown_cases","arguments":{"base_url":"http://localhost:3000","markdown":"## Caso 1"}}}\n'
  });
  assert.equal(fetched.status, 0, fetched.stderr);
  const promptPayload = parseJson(lastJsonLine(fetched.stdout));
  assert.match(promptPayload.result.messages[0].content.text, /run_markdown_cases/);
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
