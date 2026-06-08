import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  executePreparedRun,
  listRunRecords,
  loadGeneratedCaseCode,
  loadRunBundle,
  prepareMarkdownRun
} from './proguide-service.js';
import { ensurePythonRuntime } from './python-runtime.js';
import { ensureViewer, viewerLinks } from './viewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(
  process.env.PROGUIDE_MCP_ROOT ||
  process.env.PROGUIDE_UI_ROOT ||
  process.env.CLAUDE_PROJECT_DIR ||
  process.env.CURSOR_WORKSPACE_FOLDER ||
  process.env.WORKSPACE_FOLDER ||
  process.env.PROJECT_ROOT ||
  process.env.INIT_CWD ||
  process.cwd()
);
const PROTOCOL_VERSION = '2025-06-18';

const tools = [
  {
    name: 'run_markdown_cases',
    description: 'Importa casos QA desde Markdown, genera codigo Python Playwright con el agente configurado y ejecuta pytest/Playwright.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Ruta del archivo Markdown con los casos QA. Debe estar dentro del root.' },
        markdown: { type: 'string', description: 'Contenido Markdown alternativo si no se pasa source_path.' },
        base_url: { type: 'string', description: 'URL base de la app bajo prueba.' },
        root: { type: 'string', description: 'Root del workspace. Default: PROGUIDE_MCP_ROOT o cwd del proyecto.' },
        title: { type: 'string' },
        ticket: { type: 'string' },
        module: { type: 'string' },
        qa_owner: { type: 'string' },
        dev_owner: { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' }
      },
      required: ['base_url'],
      anyOf: [
        { required: ['source_path'] },
        { required: ['markdown'] }
      ]
    }
  },
  {
    name: 'create_run_from_markdown',
    description: 'Importa casos QA desde Markdown y crea un run local sin generar codigo ni ejecutar. Devuelve run_id para ejecutar despues.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string' },
        markdown: { type: 'string' },
        base_url: { type: 'string' },
        root: { type: 'string' },
        title: { type: 'string' },
        ticket: { type: 'string' },
        module: { type: 'string' },
        qa_owner: { type: 'string' },
        dev_owner: { type: 'string' }
      },
      anyOf: [
        { required: ['source_path'] },
        { required: ['markdown'] }
      ]
    }
  },
  {
    name: 'execute_run',
    description: 'Genera codigo Python Playwright con el agente configurado y ejecuta un run existente.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        base_url: { type: 'string' },
        root: { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' }
      },
      required: ['run_id']
    }
  },
  {
    name: 'get_run',
    description: 'Devuelve estado, casos, eventos y resumen de un run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        root: { type: 'string' }
      },
      required: ['run_id']
    }
  },
  {
    name: 'get_generated_code',
    description: 'Devuelve el codigo Python generado para un caso concreto.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        case_id: { type: 'string' },
        root: { type: 'string' }
      },
      required: ['run_id', 'case_id']
    }
  },
  {
    name: 'list_runs',
    description: 'Lista runs locales guardados por ProGuide.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  }
];

const prompts = [
  {
    name: 'run_markdown_cases',
    description: 'Create and execute a ProGuide run from QA Markdown cases against a base URL, then return run_url.',
    arguments: [
      { name: 'base_url', description: 'Base URL of the app under test.', required: true },
      { name: 'markdown', description: 'QA test cases in Markdown.', required: true }
    ]
  },
  {
    name: 'create_run_from_markdown',
    description: 'Create a ProGuide run from QA Markdown cases without executing browser tests.',
    arguments: [
      { name: 'base_url', description: 'Base URL of the app under test.', required: false },
      { name: 'markdown', description: 'QA test cases in Markdown.', required: true }
    ]
  }
];

process.stdin.setEncoding('utf8');

let buffer = '';
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    await handleLine(line);
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    writeResponse({ jsonrpc: '2.0', id: null, error: jsonRpcError(-32700, error.message) });
    return;
  }

  if (Array.isArray(message)) {
    const responses = (await Promise.all(message.map(handleMessage))).filter(Boolean);
    if (responses.length) writeResponse(responses);
    return;
  }

  const response = await handleMessage(message);
  if (response) writeResponse(response);
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: jsonRpcError(-32600, 'Invalid JSON-RPC request.') };
  }

  const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');
  try {
    if (message.method === 'initialize') {
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'proguide-test-e2e', version: '0.1.1' }
      });
    }
    if (message.method === 'notifications/initialized') return null;
    if (message.method === 'ping') return response(message.id, {});
    if (message.method === 'tools/list') {
      return response(message.id, { tools });
    }
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return response(message.id, result);
    }
    if (message.method === 'resources/list') {
      return response(message.id, { resources: [] });
    }
    if (message.method === 'prompts/list') {
      return response(message.id, { prompts });
    }
    if (message.method === 'prompts/get') {
      return response(message.id, getPrompt(message.params?.name, message.params?.arguments || {}));
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id: message.id, error: jsonRpcError(-32601, `Method not found: ${message.method}`) };
  } catch (error) {
    if (isNotification) {
      console.error(error);
      return null;
    }
    return response(message.id, toolError(error));
  }
}

async function callTool(name, args) {
  if (name === 'run_markdown_cases') {
    const root = resolveRoot(args.root);
    const sourceMd = await resolveMarkdownSource(root, args);
    const prepared = await prepareMarkdownRun({
      root,
      sourceMd,
      baseUrl: args.base_url || '',
      metadata: metadataFromArgs(args),
      useAgent: false
    });
    const viewer = await attachViewer(root, prepared.run.id);
    const runtime = await ensurePythonRuntime(root);
    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: args.base_url || prepared.run.base_url || '',
      credentials: credentialsFromArgs(args),
      python: runtime.python
    });
    const bundle = await loadRunBundle(root, prepared.run.id);
    return toolResult(`Run ${prepared.run.id} ejecutado.`, {
      run_id: prepared.run.id,
      run: bundle.run,
      cases: bundle.cases,
      summary,
      ...viewer,
      report_url_path: bundle.run.html_path ? `/artifacts/${prepared.run.id}/${bundle.run.html_path}` : ''
    });
  }

  if (name === 'create_run_from_markdown') {
    const root = resolveRoot(args.root);
    const sourceMd = await resolveMarkdownSource(root, args);
    const prepared = await prepareMarkdownRun({
      root,
      sourceMd,
      baseUrl: args.base_url || '',
      metadata: metadataFromArgs(args),
      useAgent: false
    });
    const viewer = await attachViewer(root, prepared.run.id);
    return toolResult(`Run ${prepared.run.id} creado desde Markdown.`, {
      run_id: prepared.run.id,
      run: prepared.run,
      cases: prepared.cases,
      ...viewer
    });
  }

  if (name === 'execute_run') {
    const root = resolveRoot(args.root);
    const runId = cleanHandle(args.run_id, 'run_id');
    const viewer = await attachViewer(root, runId);
    const runtime = await ensurePythonRuntime(root);
    const summary = await executePreparedRun({
      root,
      runId,
      baseUrl: args.base_url || '',
      credentials: credentialsFromArgs(args),
      python: runtime.python
    });
    const bundle = await loadRunBundle(root, runId);
    return toolResult(`Run ${runId} ejecutado.`, {
      run_id: runId,
      run: bundle.run,
      summary,
      ...viewer
    });
  }

  if (name === 'get_run') {
    const root = resolveRoot(args.root);
    const runId = cleanHandle(args.run_id, 'run_id');
    const bundle = await loadRunBundle(root, runId);
    return toolResult(`Run ${runId}: ${bundle.run.status}`, {
      run_id: runId,
      ...bundle
    });
  }

  if (name === 'get_generated_code') {
    const root = resolveRoot(args.root);
    const runId = cleanHandle(args.run_id, 'run_id');
    const caseId = cleanHandle(args.case_id, 'case_id');
    const generatedCode = await loadGeneratedCaseCode(root, runId, caseId);
    return toolResult(generatedCode?.code ? `Codigo generado para ${caseId}.` : `No hay codigo generado para ${caseId}.`, {
      run_id: runId,
      case_id: caseId,
      generated_code: generatedCode
    });
  }

  if (name === 'list_runs') {
    const root = resolveRoot(args.root);
    const runs = await listRunRecords(root);
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(0, Number(args.limit)) : runs.length;
    return toolResult(`${Math.min(limit, runs.length)} run(s).`, {
      runs: runs.slice(0, limit)
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

function getPrompt(name, args) {
  if (name === 'run_markdown_cases') {
    return {
      description: 'Create and execute a ProGuide run from Markdown QA cases.',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Use the ProGuide MCP tools to run QA Markdown cases.',
            'Call run_markdown_cases with markdown and base_url.',
            'Return run_id, run_url, viewer_url, status, and a concise result summary.',
            'Do not ask the user to set provider or model; ProGuide defaults to Anthropic Sonnet.',
            `base_url: ${args.base_url || '<base_url>'}`,
            'markdown:',
            args.markdown || '<markdown_cases>'
          ].join('\n')
        }
      }]
    };
  }
  if (name === 'create_run_from_markdown') {
    return {
      description: 'Create a ProGuide run from Markdown QA cases without execution.',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Use the ProGuide MCP tools to create a QA run without executing it.',
            'Call create_run_from_markdown with markdown and optional base_url.',
            'Then call get_run and return run_id, run_url if available, status, and parsed cases.',
            `base_url: ${args.base_url || '<optional_base_url>'}`,
            'markdown:',
            args.markdown || '<markdown_cases>'
          ].join('\n')
        }
      }]
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
}

async function resolveMarkdownSource(root, args) {
  if (args.source_path) {
    const rootPath = path.resolve(root);
    const source = path.resolve(rootPath, String(args.source_path));
    if (!isPathInside(rootPath, source)) {
      throw new Error(`source_path debe estar dentro del root: ${args.source_path}`);
    }
    return source;
  }
  if (!String(args.markdown || '').trim()) {
    throw new Error('Debes pasar source_path o markdown.');
  }
  const uploadDir = path.join(root, '.codex_tmp', 'mcp_markdown');
  await fs.mkdir(uploadDir, { recursive: true });
  const source = path.join(uploadDir, `cases_${Date.now()}.md`);
  await fs.writeFile(source, String(args.markdown), 'utf8');
  return source;
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRoot(value) {
  const root = path.resolve(value ? String(value) : DEFAULT_ROOT);
  return root;
}

function metadataFromArgs(args) {
  return {
    title: args.title || null,
    ticket: args.ticket || null,
    module: args.module || null,
    qa_owner: args.qa_owner || null,
    dev_owner: args.dev_owner || null
  };
}

function credentialsFromArgs(args) {
  return {
    email: args.email || '',
    username: args.username || '',
    password: args.password || ''
  };
}

function cleanHandle(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) throw new Error(`${label} invalido.`);
  return text;
}

async function attachViewer(root, runId) {
  try {
    const viewer = await ensureViewer(root);
    const links = viewerLinks(viewer.baseUrl, runId);
    console.error(`[ProGuide] Visor de resultados: ${links.run_url}`);
    return {
      ...links,
      viewer_started: viewer.started,
      viewer_port: viewer.port
    };
  } catch (error) {
    const message = error.message || String(error);
    console.error(`[ProGuide] No se pudo iniciar el visor: ${message}`);
    return { viewer_error: message };
  }
}

function toolResult(message, structuredContent) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent
  };
}

function toolError(error) {
  return {
    content: [{ type: 'text', text: error.message || String(error) }],
    structuredContent: { error: error.message || String(error) },
    isError: true
  };
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(code, message) {
  return { code, message };
}

function writeResponse(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
