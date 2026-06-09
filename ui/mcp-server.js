import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  executePreparedRun,
  listRunRecords,
  loadGeneratedCaseCode,
  loadRunBundle,
  prepareCasesRun,
  prepareMarkdownRun
} from './proguide-service.js';
import { ensurePythonRuntime } from './python-runtime.js';
import { ensureViewer, stopViewer, viewerLinks } from './viewer.js';

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
const casesInputSchema = {
  type: 'array',
  description: 'Casos normalizados o semiestructurados. Si se pasa, no hace falta markdown/source_path.',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string' },
      route: { type: 'string' },
      preconditions: { type: 'array', items: { type: 'string' } },
      data_used: { type: 'array', items: { type: 'string' } },
      data: { type: 'object', additionalProperties: true },
      original_steps: { type: 'array', items: { type: 'string' } },
      executable_steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
      expected_results: { type: 'array', items: { type: 'string' } },
      automation_state: { type: 'string' }
    }
  }
};

const tools = [
  {
    name: 'run_cases',
    description: 'Crea y ejecuta un run ProGuide desde casos estructurados o Markdown. Alias recomendado para QA.',
    inputSchema: {
      type: 'object',
      properties: {
        cases: casesInputSchema,
        source_path: { type: 'string', description: 'Ruta del archivo Markdown con los casos QA. Debe estar dentro del root.' },
        markdown: { type: 'string', description: 'Contenido Markdown alternativo si no se pasa source_path/cases.' },
        base_url: { type: 'string', description: 'URL base de la app bajo prueba.' },
        root: { type: 'string', description: 'Root del workspace. Default: PROGUIDE_MCP_ROOT o cwd del proyecto.' },
        title: { type: 'string' },
        ticket: { type: 'string' },
        module: { type: 'string' },
        qa_owner: { type: 'string' },
        dev_owner: { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        open_browser: { type: 'boolean', description: 'Abre el run_url en el navegador local. Default: true.' }
      },
      required: ['base_url']
    }
  },
  {
    name: 'create_run',
    description: 'Crea un run local desde casos estructurados o Markdown sin ejecutar. Devuelve run_id para ejecutar despues.',
    inputSchema: {
      type: 'object',
      properties: {
        cases: casesInputSchema,
        source_path: { type: 'string' },
        markdown: { type: 'string' },
        base_url: { type: 'string' },
        root: { type: 'string' },
        title: { type: 'string' },
        ticket: { type: 'string' },
        module: { type: 'string' },
        qa_owner: { type: 'string' },
        dev_owner: { type: 'string' },
        open_browser: { type: 'boolean', description: 'Abre el run_url en el navegador local. Default: true.' }
      }
    }
  },
  {
    name: 'run_markdown_cases',
    description: 'Importa casos QA desde Markdown, genera codigo Python Playwright con el agente configurado y ejecuta pytest/Playwright.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Ruta del archivo Markdown con los casos QA. Debe estar dentro del root.' },
        markdown: { type: 'string', description: 'Contenido Markdown alternativo si no se pasa source_path.' },
        cases: casesInputSchema,
        base_url: { type: 'string', description: 'URL base de la app bajo prueba.' },
        root: { type: 'string', description: 'Root del workspace. Default: PROGUIDE_MCP_ROOT o cwd del proyecto.' },
        title: { type: 'string' },
        ticket: { type: 'string' },
        module: { type: 'string' },
        qa_owner: { type: 'string' },
        dev_owner: { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        open_browser: { type: 'boolean', description: 'Abre el run_url en el navegador local. Default: true.' }
      },
      required: ['base_url']
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
        cases: casesInputSchema,
        base_url: { type: 'string' },
        root: { type: 'string' },
        title: { type: 'string' },
        ticket: { type: 'string' },
        module: { type: 'string' },
        qa_owner: { type: 'string' },
        dev_owner: { type: 'string' },
        open_browser: { type: 'boolean', description: 'Abre el run_url en el navegador local. Default: true.' }
      }
    }
  },
  {
    name: 'execute_run',
    description: 'Genera codigo Python Playwright y ejecuta un run existente. Si no se pasa run_id, puede crear uno desde cases o Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        cases: casesInputSchema,
        source_path: { type: 'string' },
        markdown: { type: 'string' },
        base_url: { type: 'string' },
        from_plan: { type: 'boolean', description: 'Si true, respeta test_plan.json existente del run en vez de regenerarlo desde normalized_cases.json.' },
        root: { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        open_browser: { type: 'boolean', description: 'Abre el run_url en el navegador local. Default: true.' }
      }
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
  },
  {
    name: 'start_viewer',
    description: 'Levanta o reutiliza el visor local Fastify para ver ejecuciones ProGuide. Si se pasa run_id, devuelve tambien el link directo al run.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        run_id: { type: 'string' },
        open_browser: { type: 'boolean', description: 'Abre el run_url o viewer_url en el navegador local. Default: true.' }
      }
    }
  },
  {
    name: 'stop_viewer',
    description: 'Detiene el visor local ProGuide asociado al root indicado. No afecta viewers de otros workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        port: { type: 'number', description: 'Puerto inicial para buscar viewers. Default: 8787 o PROGUIDE_VIEWER_PORT.' }
      }
    }
  }
];

const prompts = [
  {
    name: 'run_cases',
    description: 'Create and execute a ProGuide run from QA cases against a base URL, then return run_url.',
    arguments: [
      { name: 'base_url', description: 'Base URL of the app under test.', required: true },
      { name: 'markdown', description: 'QA test cases in Markdown.', required: false }
    ]
  },
  {
    name: 'create_run',
    description: 'Create a ProGuide run from QA cases without executing browser tests.',
    arguments: [
      { name: 'base_url', description: 'Base URL of the app under test.', required: false },
      { name: 'markdown', description: 'QA test cases in Markdown.', required: false }
    ]
  },
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
        serverInfo: { name: 'proguide-test-e2e', version: '0.1.8' }
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
  if (name === 'run_markdown_cases' || name === 'run_cases') {
    const root = resolveRoot(args.root);
    const prepared = await prepareRunFromArgs(root, args);
    const viewer = await attachViewer(root, prepared.run.id, args);
    const runtime = await ensurePythonRuntime(root);
    const summary = await executePreparedRun({
      root,
      runId: prepared.run.id,
      baseUrl: args.base_url || prepared.run.base_url || '',
      credentials: credentialsFromArgs(args),
      python: runtime.python,
      fromPlan: Boolean(args.from_plan)
    });
    const bundle = await loadRunBundle(root, prepared.run.id);
    const payload = {
      run_id: prepared.run.id,
      run: bundle.run,
      cases: bundle.cases,
      summary,
      ...viewer,
      report_url_path: bundle.run.html_path ? `/artifacts/${prepared.run.id}/${bundle.run.html_path}` : ''
    };
    return toolResult(runMessage('ejecutado', payload), payload);
  }

  if (name === 'create_run_from_markdown' || name === 'create_run') {
    const root = resolveRoot(args.root);
    const prepared = await prepareRunFromArgs(root, args);
    const viewer = await attachViewer(root, prepared.run.id, args);
    const payload = {
      run_id: prepared.run.id,
      run: prepared.run,
      cases: prepared.cases,
      ...viewer
    };
    return toolResult(runMessage('creado desde Markdown', payload), payload);
  }

  if (name === 'execute_run') {
    const root = resolveRoot(args.root);
    let runId = args.run_id ? cleanHandle(args.run_id, 'run_id') : '';
    if (!runId) {
      const prepared = await prepareRunFromArgs(root, args);
      runId = prepared.run.id;
    }
    const viewer = await attachViewer(root, runId, args);
    const runtime = await ensurePythonRuntime(root);
    const summary = await executePreparedRun({
      root,
      runId,
      baseUrl: args.base_url || '',
      credentials: credentialsFromArgs(args),
      python: runtime.python,
      fromPlan: Boolean(args.from_plan)
    });
    const bundle = await loadRunBundle(root, runId);
    const payload = {
      run_id: runId,
      run: bundle.run,
      summary,
      ...viewer
    };
    return toolResult(runMessage('ejecutado', payload), payload);
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

  if (name === 'start_viewer') {
    const root = resolveRoot(args.root);
    const runId = args.run_id ? cleanHandle(args.run_id, 'run_id') : '';
    const viewer = await startViewer(root, runId, args);
    return toolResult(viewerMessage(viewer), viewer);
  }

  if (name === 'stop_viewer') {
    const root = resolveRoot(args.root);
    const stopped = await stopViewer(root, {
      port: Number.isFinite(Number(args.port)) ? Number(args.port) : undefined
    });
    return toolResult(stopViewerMessage(stopped), stopped);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function getPrompt(name, args) {
  if (name === 'run_markdown_cases' || name === 'run_cases') {
    const toolName = name === 'run_markdown_cases' ? 'run_markdown_cases' : 'run_cases';
    return {
      description: 'Create and execute a ProGuide run from Markdown QA cases.',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Use the ProGuide MCP tools to run QA Markdown cases.',
            `Call ${toolName} with cases or markdown and base_url.`,
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
  if (name === 'create_run_from_markdown' || name === 'create_run') {
    const toolName = name === 'create_run_from_markdown' ? 'create_run_from_markdown' : 'create_run';
    return {
      description: 'Create a ProGuide run from Markdown QA cases without execution.',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Use the ProGuide MCP tools to create a QA run without executing it.',
            `Call ${toolName} with cases or markdown and optional base_url.`,
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

async function prepareRunFromArgs(root, args) {
  if (Array.isArray(args.cases) && args.cases.length) {
    return prepareCasesRun({
      root,
      cases: args.cases,
      baseUrl: args.base_url || '',
      metadata: metadataFromArgs(args)
    });
  }
  const sourceMd = await resolveMarkdownSource(root, args);
  return prepareMarkdownRun({
    root,
    sourceMd,
    baseUrl: args.base_url || '',
    metadata: metadataFromArgs(args),
    useAgent: false
  });
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

async function attachViewer(root, runId, options = {}) {
  try {
    const viewer = await startViewer(root, runId, options);
    console.error(`[ProGuide] Visor de resultados: ${viewer.run_url || viewer.viewer_url}`);
    return viewer;
  } catch (error) {
    const message = error.message || String(error);
    console.error(`[ProGuide] No se pudo iniciar el visor: ${message}`);
    return { viewer_error: message };
  }
}

async function startViewer(root, runId = '', options = {}) {
  const viewer = await ensureViewer(root);
  const links = runId ? viewerLinks(viewer.baseUrl, runId) : { viewer_url: `${viewer.baseUrl}/runs` };
  const browser = await openViewerInBrowser(links.run_url || links.viewer_url, options);
  return {
    ...links,
    viewer_started: viewer.started,
    viewer_port: viewer.port,
    ...browser
  };
}

async function openViewerInBrowser(url, options = {}) {
  if (!shouldOpenBrowser(options)) {
    return { browser_opened: false, browser_url: '', browser_disabled: true };
  }
  try {
    openExternalUrl(url);
    return { browser_opened: true, browser_url: url };
  } catch (error) {
    return {
      browser_opened: false,
      browser_url: url,
      browser_error: error.message || String(error)
    };
  }
}

function shouldOpenBrowser(options = {}) {
  if (options.open_browser === false) return false;
  if (String(process.env.PROGUIDE_OPEN_BROWSER || '').trim() === '0') return false;
  return true;
}

function openExternalUrl(url) {
  if (!url) throw new Error('No hay URL de visor para abrir.');
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function runMessage(action, payload) {
  const lines = [`Run ${payload.run_id} ${action}.`];
  if (payload.run_url) lines.push(`Ejecucion en visor: ${payload.run_url}`);
  if (payload.viewer_url) lines.push(`Servidor del visor: ${payload.viewer_url}`);
  if (payload.viewer_port) {
    lines.push(payload.viewer_started
      ? `Fastify viewer iniciado en puerto ${payload.viewer_port}.`
      : `Fastify viewer reutilizado en puerto ${payload.viewer_port}.`);
  }
  if (payload.browser_opened) lines.push(`Navegador abierto: ${payload.browser_url}`);
  if (payload.browser_disabled) lines.push('Apertura de navegador deshabilitada.');
  if (payload.browser_error) lines.push(`No se pudo abrir el navegador: ${payload.browser_error}`);
  if (payload.run?.status) lines.push(`Estado: ${payload.run.status}`);
  const summary = summaryLine(payload.summary, payload.run);
  if (summary) lines.push(summary);
  if (payload.report_url_path && payload.viewer_url) {
    lines.push(`Reporte HTML: ${payload.viewer_url.replace(/\/runs$/, payload.report_url_path)}`);
  }
  if (payload.viewer_error) lines.push(`No se pudo iniciar el visor: ${payload.viewer_error}`);
  return lines.join('\n');
}

function viewerMessage(payload) {
  const lines = [];
  if (payload.run_url) lines.push(`Ejecucion en visor: ${payload.run_url}`);
  if (payload.viewer_url) lines.push(`Servidor del visor: ${payload.viewer_url}`);
  if (payload.viewer_port) {
    lines.push(payload.viewer_started
      ? `Fastify viewer iniciado en puerto ${payload.viewer_port}.`
      : `Fastify viewer reutilizado en puerto ${payload.viewer_port}.`);
  }
  if (payload.browser_opened) lines.push(`Navegador abierto: ${payload.browser_url}`);
  if (payload.browser_disabled) lines.push('Apertura de navegador deshabilitada.');
  if (payload.browser_error) lines.push(`No se pudo abrir el navegador: ${payload.browser_error}`);
  return lines.join('\n') || 'Visor no disponible.';
}

function stopViewerMessage(payload) {
  if (!payload.viewers?.length) {
    return `No habia visor ProGuide activo para ${payload.root}.`;
  }
  const stopped = payload.viewers.filter((item) => item.stopped);
  const failed = payload.viewers.filter((item) => !item.stopped);
  const lines = [
    `Visores detenidos: ${stopped.length}/${payload.viewers.length}.`
  ];
  for (const item of stopped) {
    lines.push(`Detenido: ${item.baseUrl}${item.pid ? ` pid=${item.pid}` : ''}`);
  }
  for (const item of failed) {
    lines.push(`No detenido: ${item.baseUrl} (${item.message || 'sin detalle'})`);
  }
  return lines.join('\n');
}

function summaryLine(summary, run) {
  const counts = summaryCounts(summary, run);
  if (!counts) return '';
  return `Resumen: total=${counts.total}, passed=${counts.passed}, failed=${counts.failed}, blocked=${counts.blocked}, inconclusive=${counts.inconclusive}, setup_failed=${counts.setup_failed}.`;
}

function summaryCounts(summary, run) {
  const total = Number(run?.total_cases || summary?.results?.length || 0);
  if (!total && !summary?.results?.length) return null;
  const counted = (summary?.results || []).reduce((acc, result) => {
    if (result.status === 'passed') acc.passed += 1;
    else if (result.status === 'failed') acc.failed += 1;
    else if (result.status === 'blocked') acc.blocked += 1;
    else if (result.status === 'setup_failed') acc.setup_failed += 1;
    else acc.inconclusive += 1;
    return acc;
  }, { passed: 0, failed: 0, blocked: 0, inconclusive: 0, setup_failed: 0 });
  return {
    total,
    passed: Number(run?.passed ?? counted.passed),
    failed: Number(run?.failed ?? counted.failed),
    blocked: Number(run?.blocked ?? counted.blocked),
    inconclusive: Number(run?.inconclusive ?? counted.inconclusive),
    setup_failed: Number(run?.setup_failed ?? counted.setup_failed)
  };
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
