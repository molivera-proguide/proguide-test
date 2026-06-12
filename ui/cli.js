#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  executePreparedRun,
  listRunRecords,
  loadGeneratedCaseCode,
  loadRunBundle,
  loadUsageSummary,
  prepareMarkdownRun,
  previewMarkdownRun
} from './proguide-service.js';
import { ensurePythonRuntime, playwrightBrowserProbe, pythonCommand } from './python-runtime.js';
import { ensureViewer, fetchViewerHealth, rootIdentity, stopViewer, viewerBaseUrl, viewerLinks } from './viewer.js';

const DEFAULT_VIEWER_HOST = process.env.PROGUIDE_VIEWER_HOST || process.env.PROGUIDE_UI_HOST || '127.0.0.1';
const DEFAULT_VIEWER_PORT = Number(process.env.PROGUIDE_VIEWER_PORT || process.env.PROGUIDE_UI_PORT || 8787);
const DEFAULT_VIEWER_PORT_ATTEMPTS = Number(process.env.PROGUIDE_VIEWER_PORT_ATTEMPTS || 20);
const DEFAULT_CONFIG = {
  runner: {
    browser: 'chromium',
    parallel_workers: 'auto',
    video: 'on',
    screenshots: 'on_failure',
    traces: 'retain_on_failure'
  },
  llm: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.2,
    max_cases: 12,
    max_context_chars: 50000,
    max_output_tokens: 8000
  }
};

const EXIT = {
  ok: 0,
  testsFailed: 1,
  config: 2,
  generation: 3,
  execution: 4,
  invalidInput: 5
};

async function main(argv) {
  const parsed = parseArgv(argv);

  if (parsed.options.version || parsed.command === 'version') {
    await commandVersion(parsed);
    return;
  }

  if (parsed.options.help || !parsed.command || parsed.command === 'help') {
    commandHelp();
    return;
  }

  if (parsed.command === 'mcp') {
    await import('./mcp-server.js');
    return;
  }

  try {
    const exitCode = await dispatch(parsed);
    process.exitCode = exitCode;
  } catch (error) {
    const exitCode = error.exitCode || classifyError(error);
    const payload = {
      status: 'error',
      error: error.message || String(error),
      exit_code: exitCode
    };
    if (parsed.options.json) {
      writeJson(payload);
    } else {
      console.error(`Error: ${payload.error}`);
    }
    process.exitCode = exitCode;
  }
}

async function dispatch(parsed) {
  switch (parsed.command) {
    case 'create':
      return commandCreate(parsed);
    case 'run':
      return commandRun(parsed);
    case 'execute':
      return commandExecute(parsed);
    case 'get-run':
      return commandGetRun(parsed);
    case 'get-code':
      return commandGetCode(parsed);
    case 'list-runs':
      return commandListRuns(parsed);
    case 'usage':
      return commandUsage(parsed);
    case 'viewer':
      return commandViewer(parsed);
    case 'stop-viewer':
      return commandStopViewer(parsed);
    case 'doctor':
      return commandDoctor(parsed);
    case 'config':
      return commandConfig(parsed);
    case 'agent-setup':
    case 'agents':
      return commandAgentSetup(parsed);
    default:
      throw cliError(`Comando desconocido: ${parsed.command}`, EXIT.invalidInput);
  }
}

async function commandCreate(parsed) {
  const root = resolveRoot(parsed.options);
  const source = await resolveMarkdownSource(root, parsed);
  if (parsed.options['dry-run']) {
    let preview;
    try {
      preview = await previewMarkdownRun({
        root,
        sourceMd: source.path,
        metadata: metadataFromOptions(parsed.options),
        useAgent: false
      });
    } finally {
      await cleanupTemporarySource(source);
    }
    const ready = preview.cases.filter((item) => item.automation_state === 'listo' && !item.excluded).length;
    const payload = {
      status: 'dry_run',
      summary: {
        total: preview.cases.length,
        ready,
        needs_review: preview.cases.filter((item) => item.automation_state === 'necesita_revision').length,
        not_automatable: preview.cases.filter((item) => item.automation_state === 'no_automatizable_aun').length,
        warnings: preview.warnings.length
      },
      cases: preview.cases,
      warnings: preview.warnings
    };
    emit(payload, parsed.options, renderDryRunPreview(payload));
    return EXIT.ok;
  }

  let prepared;
  try {
    prepared = await prepareMarkdownRun({
      root,
      sourceMd: source.path,
      baseUrl: option(parsed.options, 'base-url') || '',
      metadata: metadataFromOptions(parsed.options),
      useAgent: false
    });
  } finally {
    await cleanupTemporarySource(source);
  }

  const viewer = await attachViewer(root, prepared.run.id, parsed.options);
  const payload = {
    run_id: prepared.run.id,
    status: prepared.run.status,
    ...viewer,
    summary: summaryCounts(prepared.run, null, prepared.cases),
    cases: prepared.cases
  };
  emit(payload, parsed.options, `Run ${prepared.run.id} creado: ${payload.run_url || '(visor deshabilitado)'}`);
  return EXIT.ok;
}

async function commandRun(parsed) {
  const root = resolveRoot(parsed.options);
  const baseUrl = requireBaseUrl(parsed.options);
  const source = await resolveMarkdownSource(root, parsed);
  let prepared;
  try {
    prepared = await prepareMarkdownRun({
      root,
      sourceMd: source.path,
      baseUrl,
      metadata: metadataFromOptions(parsed.options),
      useAgent: false
    });
  } finally {
    await cleanupTemporarySource(source);
  }

  const viewer = await attachViewer(root, prepared.run.id, parsed.options);
  const runtime = await ensurePythonRuntime(root);
  await executePreparedRun({
    root,
    runId: prepared.run.id,
    baseUrl,
    credentials: credentialsFromOptions(parsed.options),
    python: runtime.python,
    fromPlan: Boolean(parsed.options['from-plan'])
  });
  const bundle = await loadRunBundle(root, prepared.run.id);
  const payload = runPayload(bundle.run, bundle.summary, bundle.cases, viewer);
  emit(payload, parsed.options, `Run ${payload.run_id} finalizado: ${payload.status}`);
  return exitCodeForRun(bundle.run);
}

async function commandExecute(parsed) {
  const root = resolveRoot(parsed.options);
  const runId = requiredHandle(parsed.positionals[0], 'run_id');
  const viewer = await attachViewer(root, runId, parsed.options);
  const runtime = await ensurePythonRuntime(root);
  await executePreparedRun({
    root,
    runId,
    baseUrl: option(parsed.options, 'base-url') || '',
    credentials: credentialsFromOptions(parsed.options),
    python: runtime.python,
    fromPlan: Boolean(parsed.options['from-plan'])
  });
  const bundle = await loadRunBundle(root, runId);
  const payload = runPayload(bundle.run, bundle.summary, bundle.cases, viewer);
  emit(payload, parsed.options, `Run ${payload.run_id} finalizado: ${payload.status}`);
  return exitCodeForRun(bundle.run);
}

async function commandGetRun(parsed) {
  const root = resolveRoot(parsed.options);
  const runId = requiredHandle(parsed.positionals[0], 'run_id');
  const bundle = await loadRunBundle(root, runId);
  const payload = {
    run_id: runId,
    status: bundle.run.status,
    run: bundle.run,
    cases: bundle.cases,
    summary: summaryCounts(bundle.run, bundle.summary, bundle.cases),
    results: bundle.summary,
    events: bundle.events
  };
  emit(payload, parsed.options, `Run ${runId}: ${bundle.run.status}`);
  return EXIT.ok;
}

async function commandGetCode(parsed) {
  const root = resolveRoot(parsed.options);
  const runId = requiredHandle(parsed.positionals[0], 'run_id');
  const caseId = requiredHandle(parsed.positionals[1], 'case_id');
  const generatedCode = await loadGeneratedCaseCode(root, runId, caseId);
  const payload = {
    run_id: runId,
    case_id: caseId,
    generated_code: generatedCode
  };
  emit(payload, parsed.options, generatedCode?.code || `No hay codigo generado para ${caseId}.`);
  return EXIT.ok;
}

async function commandListRuns(parsed) {
  const root = resolveRoot(parsed.options);
  const runs = await listRunRecords(root);
  const limit = numberOption(parsed.options, 'limit', runs.length);
  const payload = {
    runs: runs.slice(0, Math.max(0, limit))
  };
  emit(payload, parsed.options, payload.runs.map((run) => `${run.id}\t${run.status}\t${run.base_url || ''}`).join('\n'));
  return EXIT.ok;
}

async function commandUsage(parsed) {
  const root = resolveRoot(parsed.options);
  const runId = option(parsed.options, 'run') || parsed.positionals[0] || '';
  const usage = await loadUsageSummary(root, runId ? { runId } : {});
  emit(usage, parsed.options, renderUsage(usage));
  return EXIT.ok;
}

async function commandViewer(parsed) {
  const root = resolveRoot(parsed.options);
  const host = option(parsed.options, 'host') || DEFAULT_VIEWER_HOST;
  const port = numberOption(parsed.options, 'port', DEFAULT_VIEWER_PORT);
  const viewer = await ensureViewer(root, { host, port });
  const payload = {
    viewer_url: `${viewer.baseUrl}/runs`,
    port: viewer.port,
    started: viewer.started,
    root
  };
  emit(payload, parsed.options, payload.viewer_url);
  return EXIT.ok;
}

async function commandStopViewer(parsed) {
  const root = resolveRoot(parsed.options);
  const host = option(parsed.options, 'host') || DEFAULT_VIEWER_HOST;
  const port = numberOption(parsed.options, 'port', DEFAULT_VIEWER_PORT);
  const stopped = await stopViewer(root, { host, port });
  const payload = {
    ...stopped,
    stopped: stopped.stopped_count
  };
  emit(payload, parsed.options, renderStopViewer(payload));
  return EXIT.ok;
}

async function commandDoctor(parsed) {
  const root = resolveRoot(parsed.options);
  const fix = Boolean(parsed.options.fix);
  await loadDotEnv(root);
  const config = await readConfig(root);
  const checks = [];

  checks.push({
    name: 'node',
    ok: true,
    version: process.version,
    message: 'Node disponible.'
  });
  let python = process.env.PROGUIDE_PYTHON || 'python';
  try {
    const runtime = await ensurePythonRuntime(root, { fix });
    python = runtime.python;
    checks.push({
      name: 'python_runtime',
      ok: true,
      path: runtime.python,
      source: runtime.source,
      managed: runtime.managed,
      runtime_dir: runtime.runtime_dir,
      actions: runtime.actions,
      message: runtime.message
    });
  } catch (error) {
    python = pythonCommand(root);
    checks.push({
      name: 'python_runtime',
      ok: false,
      path: python,
      message: error.message || String(error),
      suggestion: fix
        ? 'No se pudo reparar automaticamente. Instala Python 3.12+ o define PROGUIDE_BOOTSTRAP_PYTHON/PROGUIDE_PYTHON.'
        : 'Ejecuta proguide doctor --fix, instala Python 3.12+ o define PROGUIDE_BOOTSTRAP_PYTHON/PROGUIDE_PYTHON.'
    });
  }
  checks.push(checkCommand('python', python, ['--version'], 'Instala Python 3.12+; ProGuide lo usa para crear su runtime administrado.'));
  checks.push(checkCommand('pytest', python, ['-m', 'pytest', '--version'], 'ProGuide instala pytest automaticamente; revisa permisos, red o PROGUIDE_RUNTIME_DIR si falla.'));
  checks.push(checkCommand(
    'pytest_xdist',
    python,
    ['-c', 'import xdist; print("installed")'],
    'ProGuide instala pytest-xdist automaticamente; ejecuta proguide doctor --fix o revisa PROGUIDE_RUNTIME_DIR si falla.'
  ));
  checks.push(checkCommand(
    'pydantic',
    python,
    ['-c', 'import pydantic; print(pydantic.__version__)'],
    'Ejecuta proguide doctor --fix o instala pydantic en el runtime Python usado por ProGuide.'
  ));
  checks.push(checkCommand(
    'playwright_python',
    python,
    ['-c', 'import playwright; print("installed")'],
    'ProGuide instala Playwright automaticamente; revisa permisos, red o PROGUIDE_RUNTIME_DIR si falla.'
  ));
  checks.push(checkCommand(
    'playwright_browsers',
    python,
    ['-c', playwrightBrowserProbe()],
    'ProGuide instala Chromium automaticamente; revisa permisos, red o PROGUIDE_RUNTIME_DIR si falla.'
  ));
  checks.push(await checkRunsWritable(root));
  checks.push(await checkViewerPort(root));
  checks.push(checkLlm(config));

  const ok = checks.every((check) => check.ok || check.required === false);
  const payload = {
    status: ok ? 'ok' : 'error',
    root,
    checks
  };
  emit(payload, parsed.options, renderDoctor(payload));
  return ok ? EXIT.ok : EXIT.config;
}

async function commandConfig(parsed) {
  const root = resolveRoot(parsed.options);
  const subcommand = parsed.positionals[0] || 'get';
  if (subcommand === 'get') {
    const config = await readConfig(root);
    const key = parsed.positionals[1] || '';
    const value = key ? readDotted(config, key) : config;
    const payload = key ? { key, value } : { config };
    emit(payload, parsed.options, key ? `${key}: ${formatYamlScalar(value)}` : toYaml(config));
    return EXIT.ok;
  }

  if (subcommand === 'set') {
    const key = parsed.positionals[1];
    const rawValue = parsed.positionals.slice(2).join(' ');
    if (!key || !rawValue) throw cliError('Uso: proguide config set <clave> <valor>', EXIT.invalidInput);
    if (/(api[_-]?key|password|secret|token)/i.test(key)) {
      throw cliError('No se guardan secretos con config set. Usa variables de entorno.', EXIT.invalidInput);
    }
    const config = await readConfig(root);
    writeDotted(config, key, parseCliScalar(rawValue));
    await writeConfig(root, config);
    const payload = {
      key,
      value: readDotted(config, key),
      config_path: path.join(root, 'proguide_tests', 'config.yaml')
    };
    emit(payload, parsed.options, `${key} = ${formatYamlScalar(payload.value)}`);
    return EXIT.ok;
  }

  throw cliError(`Subcomando config desconocido: ${subcommand}`, EXIT.invalidInput);
}

async function commandAgentSetup(parsed) {
  const client = String(option(parsed.options, 'client') || parsed.positionals[0] || 'all').toLowerCase();
  const payload = agentSetupPayload();
  const selected = client === 'all' ? payload : {
    ...payload,
    clients: Object.fromEntries(Object.entries(payload.clients).filter(([key]) => key === normalizeClientKey(client)))
  };
  if (client !== 'all' && !Object.keys(selected.clients).length) {
    throw cliError(`Cliente no soportado: ${client}. Usa claude-code, cursor, generic o all.`, EXIT.invalidInput);
  }
  emit(selected, parsed.options, renderAgentSetup(selected));
  return EXIT.ok;
}

async function commandVersion(parsed) {
  try {
    const packagePath = new URL('./package.json', import.meta.url);
    const data = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    const payload = { name: data.name, version: data.version };
    emit(payload, parsed.options, `${data.name} ${data.version}`);
  } catch {
    emit({ version: '0.1.12' }, parsed.options, '0.1.12');
  }
}

function commandHelp() {
  console.log(`ProGuide Test

Uso:
  proguide create [casos.md] --base-url <url> [--json|--stdin|--dry-run]
  proguide run [casos.md] --base-url <url> [--json|--stdin]
  proguide execute <run_id> [--base-url <url>] [--from-plan] [--json]
  proguide get-run <run_id> [--json]
  proguide get-code <run_id> <case_id> [--json]
  proguide list-runs [--limit 20] [--json]
  proguide usage [--run <run_id>] [--json]
  proguide viewer [--port 8787] [--json]
  proguide stop-viewer [--port 8787] [--json]
  proguide mcp
  proguide doctor [--json] [--fix]
  proguide config get|set ...
  proguide agent-setup [--client claude-code|cursor|generic] [--json]

Opciones comunes:
  --root <path>       workspace root
  --stdin             leer Markdown desde stdin
  --json              salida JSON estable
  --no-viewer         no levantar visor automaticamente
  --email <value>     credencial opcional
  --username <value>  credencial opcional
  --password <value>  credencial opcional`);
}

async function resolveMarkdownSource(root, parsed) {
  if (parsed.options.stdin) {
    const markdown = await readStdin();
    if (!markdown.trim()) throw cliError('stdin no contiene Markdown.', EXIT.invalidInput);
    const uploadDir = path.join(root, '.codex_tmp', 'cli_markdown');
    await fs.mkdir(uploadDir, { recursive: true });
    const sourcePath = path.join(uploadDir, `cases_${Date.now()}_${process.pid}.md`);
    await fs.writeFile(sourcePath, markdown, 'utf8');
    return { path: sourcePath, temporary: true };
  }

  const sourceArg = parsed.positionals[0];
  if (!sourceArg) {
    throw cliError('Debes pasar un archivo Markdown o usar --stdin.', EXIT.invalidInput);
  }
  const sourcePath = path.isAbsolute(sourceArg)
    ? path.resolve(sourceArg)
    : path.resolve(root, sourceArg);
  if (!isPathInside(root, sourcePath)) {
    throw cliError(`source_path debe estar dentro del root: ${sourceArg}`, EXIT.invalidInput);
  }
  return { path: sourcePath, temporary: false };
}

async function cleanupTemporarySource(source) {
  if (!source?.temporary) return;
  await fs.rm(source.path, { force: true }).catch(() => {});
}

async function attachViewer(root, runId, options) {
  if (options['no-viewer']) {
    return {
      viewer_url: '',
      run_url: '',
      events_url: '',
      viewer_started: false,
      viewer_port: null
    };
  }

  try {
    const viewer = await ensureViewer(root, {
      host: option(options, 'host') || DEFAULT_VIEWER_HOST,
      port: numberOption(options, 'port', DEFAULT_VIEWER_PORT)
    });
    return {
      ...viewerLinks(viewer.baseUrl, runId),
      viewer_started: viewer.started,
      viewer_port: viewer.port
    };
  } catch (error) {
    return {
      viewer_url: '',
      run_url: '',
      events_url: '',
      viewer_error: error.message || String(error)
    };
  }
}

function runPayload(run, summary, cases, viewer) {
  return {
    run_id: run.id,
    status: run.status,
    ...viewer,
    summary: summaryCounts(run, summary, cases)
  };
}

function summaryCounts(run, summary, cases = []) {
  const results = summary?.results || [];
  const counted = results.reduce((acc, result) => {
    if (result.status === 'passed') acc.passed += 1;
    else if (result.status === 'failed') acc.failed += 1;
    else if (result.status === 'blocked') acc.blocked += 1;
    else if (result.status === 'setup_failed') acc.setup_failed += 1;
    else acc.inconclusive += 1;
    return acc;
  }, { passed: 0, failed: 0, blocked: 0, inconclusive: 0, setup_failed: 0 });
  return {
    total: Number(run?.total_cases || cases.length || results.length || 0),
    passed: Number(run?.passed ?? counted.passed),
    failed: Number(run?.failed ?? counted.failed),
    blocked: Number(run?.blocked ?? counted.blocked),
    inconclusive: Number(run?.inconclusive ?? counted.inconclusive),
    setup_failed: Number(run?.setup_failed ?? counted.setup_failed)
  };
}

function exitCodeForRun(run) {
  if (run.status === 'passed') return EXIT.ok;
  if (['failed', 'blocked', 'inconclusive', 'finished'].includes(run.status)) return EXIT.testsFailed;
  if (['error', 'setup_failed'].includes(run.status)) return EXIT.execution;
  return EXIT.ok;
}

function checkCommand(name, command, args, suggestion) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  });
  const output = firstLine(result.stdout) || firstLine(result.stderr);
  return {
    name,
    ok: result.status === 0,
    command: [command, ...args].join(' '),
    version: result.status === 0 ? output : '',
    message: result.status === 0 ? output : (output || result.error?.message || 'No disponible.'),
    suggestion
  };
}

async function checkRunsWritable(root) {
  const runsDir = path.join(root, 'proguide_tests', 'runs');
  const probe = path.join(runsDir, `.doctor_${process.pid}.tmp`);
  try {
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return {
      name: 'runs_writable',
      ok: true,
      path: runsDir,
      message: 'Directorio de runs escribible.'
    };
  } catch (error) {
    return {
      name: 'runs_writable',
      ok: false,
      path: runsDir,
      message: error.message,
      suggestion: 'Revisa permisos de escritura en proguide_tests/runs.'
    };
  }
}

async function checkViewerPort(root) {
  const host = DEFAULT_VIEWER_HOST;
  const firstPort = Number.isFinite(DEFAULT_VIEWER_PORT) && DEFAULT_VIEWER_PORT > 0 ? DEFAULT_VIEWER_PORT : 8787;
  const attempts = Number.isFinite(DEFAULT_VIEWER_PORT_ATTEMPTS) && DEFAULT_VIEWER_PORT_ATTEMPTS > 0
    ? DEFAULT_VIEWER_PORT_ATTEMPTS
    : 20;
  const skipped = [];

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = firstPort + offset;
    const baseUrl = viewerBaseUrl(host, port);
    const health = await fetchViewerHealth(baseUrl);
    if (health?.service === 'proguide-test-viewer') {
      const sameRoot = rootIdentity(health.root) === rootIdentity(root);
      if (sameRoot) {
        return {
          name: 'viewer_port',
          ok: true,
          port,
          message: `Visor reutilizable en ${baseUrl}.`
        };
      }
      skipped.push({ port, reason: `otro root ProGuide: ${health.root}` });
      continue;
    }

    if (await tcpOpen(host, port)) {
      skipped.push({ port, reason: 'ocupado' });
      continue;
    }

    return {
      name: 'viewer_port',
      ok: true,
      port,
      message: port === firstPort
        ? `Puerto ${port} disponible.`
        : `Puerto ${port} disponible; se omitieron puertos ocupados desde ${firstPort}.`,
      skipped_ports: skipped
    };
  }

  return {
    name: 'viewer_port',
    ok: false,
    port: firstPort,
    attempts,
    skipped_ports: skipped,
    message: `No hay puertos libres para el visor entre ${firstPort} y ${firstPort + attempts - 1}.`,
    suggestion: 'Define PROGUIDE_VIEWER_PORT con otro puerto o cierra un visor existente.'
  };
}

function checkLlm(config) {
  const provider = String(config.llm?.provider || 'disabled').toLowerCase();
  if (provider === 'openai') {
    const apiKey = providerApiKey(provider);
    return {
      name: 'llm',
      ok: Boolean(apiKey.value),
      provider,
      model: config.llm?.model || '',
      env_var: apiKey.name,
      message: apiKey.value ? `${apiKey.name} configurada.` : 'Falta OPENAI_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY.',
      suggestion: 'Configura OPENAI_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY, o cambia llm.provider.'
    };
  }
  if (provider === 'anthropic') {
    const apiKey = providerApiKey(provider);
    return {
      name: 'llm',
      ok: Boolean(apiKey.value),
      provider,
      model: config.llm?.model || '',
      env_var: apiKey.name,
      message: apiKey.value ? `${apiKey.name} configurada.` : 'Falta ANTHROPIC_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY.',
      suggestion: 'Configura API_KEY o ANTHROPIC_API_KEY.'
    };
  }
  if (provider === 'disabled') {
    return {
      name: 'llm',
      ok: false,
      provider,
      model: config.llm?.model || '',
      message: 'El proveedor LLM esta deshabilitado; run/execute no pueden generar codigo.',
      suggestion: 'Usa proguide config set llm.provider anthropic y configura ANTHROPIC_API_KEY o API_KEY.'
    };
  }
  return {
    name: 'llm',
    ok: false,
    provider,
    model: config.llm?.model || '',
    message: `Proveedor LLM no soportado: ${provider}`,
    suggestion: 'Usa openai, anthropic o disabled.'
  };
}

function providerApiKey(provider) {
  const names = provider === 'anthropic'
    ? ['ANTHROPIC_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY']
    : ['OPENAI_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY'];
  const name = names.find((item) => process.env[item]);
  return { name: name || names[0], value: name ? process.env[name] : '' };
}

function tcpOpen(host, port) {
  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.replace(/^\[(.*)]$/, '$1');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: connectHost, port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function readConfig(root) {
  const configPath = path.join(root, 'proguide_tests', 'config.yaml');
  let parsed = {};
  try {
    parsed = parseSimpleYaml(await fs.readFile(configPath, 'utf8'));
  } catch {
    parsed = {};
  }
  return {
    ...parsed,
    runner: { ...DEFAULT_CONFIG.runner, ...(parsed.runner || {}) },
    llm: { ...DEFAULT_CONFIG.llm, ...(parsed.llm || {}) }
  };
}

async function writeConfig(root, config) {
  const configPath = path.join(root, 'proguide_tests', 'config.yaml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, toYaml(config), 'utf8');
}

function parseSimpleYaml(text) {
  const data = {};
  let section = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sectionMatch = line.match(/^([A-Za-z_][\w-]*):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      data[section] = data[section] || {};
      continue;
    }
    const nestedMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (nestedMatch && section) {
      data[section][nestedMatch[1]] = parseCliScalar(nestedMatch[2]);
      continue;
    }
    const flatMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (flatMatch) {
      data[flatMatch[1]] = parseCliScalar(flatMatch[2]);
    }
  }
  return data;
}

function toYaml(config) {
  const lines = [];
  for (const [section, value] of Object.entries(config)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${section}:`);
      for (const [key, nestedValue] of Object.entries(value)) {
        lines.push(`  ${key}: ${formatYamlScalar(nestedValue)}`);
      }
    } else {
      lines.push(`${section}: ${formatYamlScalar(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseCliScalar(value) {
  const trimmed = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function formatYamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value ?? '');
  if (!text || /[:#\n\r]|^\s|\s$/.test(text)) return `'${text.replace(/'/g, "''")}'`;
  return text;
}

async function loadDotEnv(root) {
  for (const envPath of envFileCandidates(root)) {
    let text = '';
    try {
      text = await fs.readFile(envPath, 'utf8');
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
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.proguide', '.env'),
    path.join(root, '.env')
  ].filter(Boolean).map((item) => path.resolve(String(item)));
}

function readDotted(config, key) {
  return String(key).split('.').reduce((value, part) => value?.[part], config);
}

function writeDotted(config, key, value) {
  const parts = String(key).split('.').filter(Boolean);
  if (parts.length < 2) throw cliError('La clave debe usar formato seccion.campo.', EXIT.invalidInput);
  let target = config;
  for (const part of parts.slice(0, -1)) {
    target[part] = target[part] && typeof target[part] === 'object' ? target[part] : {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

function parseArgv(argv) {
  const options = {};
  const positionals = [];
  let command = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const parsed = parseLongOption(token, argv, index);
      options[parsed.key] = parsed.value;
      index = parsed.index;
      continue;
    }
    if (!command) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, options, positionals };
}

function parseLongOption(token, argv, index) {
  const raw = token.slice(2);
  const equalIndex = raw.indexOf('=');
  if (equalIndex >= 0) {
    return {
      key: raw.slice(0, equalIndex),
      value: raw.slice(equalIndex + 1),
      index
    };
  }
  if (['json', 'stdin', 'no-viewer', 'help', 'version', 'fix', 'dry-run', 'from-plan'].includes(raw)) {
    return { key: raw, value: true, index };
  }
  const next = argv[index + 1];
  if (next && !next.startsWith('-')) {
    return { key: raw, value: next, index: index + 1 };
  }
  return { key: raw, value: true, index };
}

function resolveRoot(options) {
  return path.resolve(
    option(options, 'root') ||
    process.env.PROGUIDE_CLI_ROOT ||
    process.env.PROGUIDE_MCP_ROOT ||
    process.env.PROGUIDE_UI_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CURSOR_WORKSPACE_FOLDER ||
    process.env.WORKSPACE_FOLDER ||
    process.env.PROJECT_ROOT ||
    process.env.INIT_CWD ||
    process.cwd()
  );
}

function requireBaseUrl(options) {
  const value = option(options, 'base-url');
  if (!value) throw cliError('--base-url es obligatorio.', EXIT.invalidInput);
  return String(value).replace(/\/+$/, '');
}

function metadataFromOptions(options) {
  return {
    title: option(options, 'title') || null,
    ticket: option(options, 'ticket') || null,
    module: option(options, 'module') || null,
    qa_owner: option(options, 'qa-owner', 'qa_owner') || null,
    dev_owner: option(options, 'dev-owner', 'dev_owner') || null
  };
}

function credentialsFromOptions(options) {
  return {
    email: option(options, 'email') || '',
    username: option(options, 'username') || '',
    password: option(options, 'password') || ''
  };
}

function requiredHandle(value, label) {
  const text = String(value || '');
  if (!text) throw cliError(`${label} es obligatorio.`, EXIT.invalidInput);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) throw cliError(`${label} invalido.`, EXIT.invalidInput);
  return text;
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function option(options, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(options, name)) return options[name];
  }
  return undefined;
}

function numberOption(options, name, fallback) {
  const value = Number(option(options, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function emit(payload, options, humanText) {
  if (options.json) {
    writeJson(payload);
  } else if (humanText) {
    console.log(humanText);
  } else {
    writeJson(payload);
  }
}

function agentSetupPayload() {
  const cursorConfig = {
    mcpServers: {
      'proguide-test': {
        command: 'proguide',
        args: ['mcp'],
        env: {
          API_KEY: 'your_api_key'
        }
      }
    }
  };
  return {
    name: 'proguide-test',
    transport: 'stdio',
    command: 'proguide mcp',
    qa_required_configuration: {
      required: ['API_KEY passed with claude mcp add --env API_KEY=...'],
      optional: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PROGUIDE_LLM_API_KEY', 'PROGUIDE_ENV_FILE'],
      managed_by_proguide: ['llm.provider', 'llm.model', 'python_runtime', 'viewer_port']
    },
    root_resolution_order: [
      'tool argument root',
      'CLI --root',
      'PROGUIDE_CLI_ROOT',
      'PROGUIDE_MCP_ROOT',
      'PROGUIDE_UI_ROOT',
      'CLAUDE_PROJECT_DIR',
      'CURSOR_WORKSPACE_FOLDER',
      'WORKSPACE_FOLDER',
      'PROJECT_ROOT',
      'INIT_CWD',
      'current working directory'
    ],
    clients: {
      claude_code: {
        install_command: 'claude mcp add proguide-test --env API_KEY=your_api_key -- proguide mcp',
        npx_command: 'claude mcp add proguide-test --env API_KEY=your_api_key -- npx @proguide/test@latest mcp',
        notes: [
          'Run the command from the QA workspace/app under test.',
          'Pass API_KEY with --env so the secret belongs to the MCP server configuration, not to the app repo.',
          'Claude Code sets CLAUDE_PROJECT_DIR for MCP servers; ProGuide uses it automatically.'
        ]
      },
      cursor: {
        config_path: '.cursor/mcp.json',
        config: cursorConfig,
        no_env_config: {
          mcpServers: {
            'proguide-test': {
              command: 'proguide',
              args: ['mcp']
            }
          }
        },
        notes: [
          'Place this file in the QA workspace/app under test.',
          'Prefer a connector/client secret mechanism over product-repo .env files when available.',
          'Cursor normally runs stdio MCP servers from the workspace; ProGuide also accepts an optional root tool argument.'
        ]
      },
      generic: {
        type: 'stdio',
        command: 'proguide',
        args: ['mcp'],
        env: {
          API_KEY: 'your_api_key'
        },
        notes: [
          'Start the process from the QA workspace/app under test.',
          'If the client supports per-tool arguments, it may pass root explicitly.'
        ]
      }
    }
  };
}

function normalizeClientKey(value) {
  const normalized = String(value || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (['claude', 'claude_code'].includes(normalized)) return 'claude_code';
  if (normalized === 'cursor') return 'cursor';
  if (['generic', 'mcp'].includes(normalized)) return 'generic';
  return normalized;
}

function renderAgentSetup(payload) {
  const lines = ['ProGuide MCP setup'];
  if (payload.clients.claude_code) {
    lines.push('', 'Claude Code:', `  ${payload.clients.claude_code.install_command}`);
  }
  if (payload.clients.cursor) {
    lines.push('', 'Cursor .cursor/mcp.json:', JSON.stringify(payload.clients.cursor.config, null, 2));
  }
  if (payload.clients.generic) {
    lines.push('', 'Generic MCP stdio:', JSON.stringify(payload.clients.generic, null, 2));
  }
  return lines.join('\n');
}

function renderDryRunPreview(payload) {
  const lines = [
    `Dry-run: ${payload.summary.total} caso(s), ${payload.summary.ready} listo(s), ${payload.summary.warnings} advertencia(s).`
  ];
  const warningsByCase = new Map();
  for (const warning of payload.warnings || []) {
    const list = warningsByCase.get(warning.case_id) || [];
    list.push(warning);
    warningsByCase.set(warning.case_id, list);
  }
  for (const testCase of payload.cases || []) {
    lines.push('', `${testCase.number || '-'} ${testCase.title} [${testCase.automation_state}]`);
    for (const step of testCase.executable_steps || []) {
      const stepWarnings = (warningsByCase.get(testCase.id) || []).filter((warning) => Number(warning.step) === Number(step.number));
      const marker = stepWarnings.length ? ' !' : '  ';
      const confidence = Number(step.confidence ?? 0).toFixed(2);
      lines.push(`${marker} ${step.number}. ${step.original_text} -> ${step.normalized_action} (${confidence})`);
      for (const warning of stepWarnings) {
        lines.push(`     warning: ${warning.type}`);
      }
    }
    for (const warning of (warningsByCase.get(testCase.id) || []).filter((item) => !item.step)) {
      lines.push(`  ! ${warning.type}: ${warning.message}`);
    }
  }
  return lines.join('\n');
}

function renderUsage(usage) {
  const lines = [
    `Uso LLM (${usage.scope}${usage.run_id ? ` ${usage.run_id}` : ''})`,
    `Costo estimado: ${formatCliUsd(usage.estimated_cost_usd)}`,
    `Tokens: ${formatCliTokens(usage.total_tokens)} total, ${formatCliTokens(usage.input_tokens)} input, ${formatCliTokens(usage.output_tokens)} output`,
    `Cache: ${formatCliTokens(usage.cache_creation_input_tokens)} write, ${formatCliTokens(usage.cache_read_input_tokens)} read`,
    `Llamadas: ${usage.entries_count}`
  ];
  if (!usage.entries_count) return [...lines, 'Sin uso registrado.'].join('\n');
  lines.push('', 'Ultimas llamadas:');
  for (const entry of usage.entries.slice(0, 8)) {
    lines.push([
      entry.timestamp || '-',
      entry.run_id || '-',
      entry.provider || 'llm',
      entry.model || '-',
      formatCliTokens(entry.usage?.total_tokens),
      formatCliUsd(entry.estimated_cost_usd),
      entry.purpose || '-'
    ].join('\t'));
  }
  if (usage.entries.length > 8) lines.push(`... ${usage.entries.length - 8} mas`);
  return lines.join('\n');
}

function renderStopViewer(payload) {
  if (!payload.viewers?.length) {
    return `No habia visor ProGuide activo para ${payload.root}.`;
  }
  const lines = [`Visores detenidos: ${payload.stopped_count}/${payload.viewers.length}.`];
  for (const item of payload.viewers) {
    const status = item.stopped ? 'Detenido' : 'No detenido';
    const pid = item.pid ? ` pid=${item.pid}` : '';
    const reason = item.stopped ? '' : ` (${item.message || 'sin detalle'})`;
    lines.push(`${status}: ${item.baseUrl}${pid}${reason}`);
  }
  return lines.join('\n');
}

function formatCliTokens(value) {
  const number = Math.round(Number(value || 0));
  if (!Number.isFinite(number) || number <= 0) return '0';
  return String(number);
}

function formatCliUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'sin estimar';
  const number = Number(value);
  const digits = number > 0 && number < 0.01 ? 6 : (number < 1 ? 4 : 2);
  return `USD ${number.toFixed(digits)}`;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cliError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function classifyError(error) {
  const message = String(error.message || error).toLowerCase();
  if (message.includes('source_path') || message.includes('stdin') || message.includes('obligatorio') || message.includes('invalido')) {
    return EXIT.invalidInput;
  }
  if (message.includes('openai') || message.includes('anthropic') || message.includes('llm') || message.includes('codigo')) {
    return EXIT.generation;
  }
  if (message.includes('pytest') || message.includes('playwright') || message.includes('browser') || message.includes('runtime')) {
    return EXIT.execution;
  }
  return EXIT.config;
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function renderDoctor(payload) {
  return payload.checks
    .map((check) => `${check.ok ? 'ok' : 'fail'}\t${check.name}\t${check.message || ''}`)
    .join('\n');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

await main(process.argv.slice(2));
