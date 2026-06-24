import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { playwrightCommand, runtimeEnv } from '../../playwright-runtime.js';
import { nowIso } from '../shared/time.js';
import { safeId } from '../shared/id.js';
import {
  playwrightWorkerArgs,
  normalizePlaywrightScreenshot,
  normalizePlaywrightTrace,
  normalizePlaywrightVideo
} from './config.js';
import {
  collectPlaywrightSpecs,
  caseFromPlaywrightSpec,
  normalizePlaywrightSpecResult
} from './results.js';
import {
  exists,
  readJson,
  collectApiEvidence,
  collectArtifacts,
  relativePath,
  setupFailureMessage
} from '../run-store/io.js';

// Playwright runner shell: write the config, spawn the run, and parse the JSON
// report into per-case results (with artifacts/evidence). I/O over run-store
// primitives + pure report parsing from ./results. Extracted verbatim from
// proguide-service.js; runPlaywrightTests and parsePlaywrightResults are
// imported back there (the latter is also part of the public API).

type PlanCase = ProGuide.Dict & {
  id: string;
  title: string;
  steps?: unknown[];
  expected?: unknown[];
};

type TestPlan = ProGuide.Dict & {
  cases: PlanCase[];
};

type RunProcessResult = {
  code: number;
};

type RunProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
};

export async function runPlaywrightTests({
  testsDir,
  runDir,
  plan,
  baseUrl,
  config,
  projectRoot,
  credentials
}: {
  testsDir: string;
  runDir: string;
  plan: TestPlan;
  baseUrl: string;
  config: ProGuide.Dict;
  projectRoot: string;
  credentials: ProGuide.Dict;
}) {
  await fs.mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  const reportPath = path.join(runDir, 'playwright-report.json');
  const playwrightLogPath = path.join(runDir, 'playwright.log');
  const outputDir = path.join(runDir, 'artifacts', 'playwright');
  const configPath = path.join(runDir, 'playwright.config.cjs');
  const runnerConfig = {
    browser: config.runner.browser || 'chromium',
    video: config.runner.video || 'on',
    screenshots: config.runner.screenshots || 'on',
    traces: config.runner.traces || 'retain_on_failure'
  };
  await writePlaywrightConfig({ configPath, testsDir, outputDir, reportPath, runnerConfig, plan });
  const command = playwrightCommand([
    'test',
    '--config',
    configPath,
    ...playwrightWorkerArgs(config)
  ]);
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnv(),
    PROGUIDE_BASE_URL: baseUrl,
    PROGUIDE_RUN_DIR: runDir,
    PROGUIDE_BROWSER: runnerConfig.browser,
    PROGUIDE_VIDEO: normalizePlaywrightVideo(runnerConfig.video),
    PROGUIDE_SCREENSHOTS: normalizePlaywrightScreenshot(runnerConfig.screenshots),
    PROGUIDE_TRACES: normalizePlaywrightTrace(runnerConfig.traces)
  };
  if (credentials.email) env.PROGUIDE_USER_EMAIL = credentials.email;
  if (credentials.username) env.PROGUIDE_USER_USERNAME = credentials.username;
  if (credentials.password) env.PROGUIDE_USER_PASSWORD = credentials.password;

  await fs.writeFile(playwrightLogPath, `$ ${command.join(' ')}\n`, 'utf8');
  const completed = await runProcess(command, { cwd: projectRoot, env, logPath: playwrightLogPath });
  let results = await parsePlaywrightResults({ plan, reportPath, runDir });
  if (completed.code !== 0 && !(await exists(reportPath))) {
    const logText = await fs.readFile(playwrightLogPath, 'utf8').catch(() => '');
    const setupMessage = setupFailureMessage(completed.code, logText, relativePath(playwrightLogPath, projectRoot));
    results = plan.cases.map((testCase) => ({
      id: testCase.id,
      title: testCase.title,
      status: 'setup_failed',
      duration_seconds: 0,
      message: setupMessage,
      error_details: logText.trim() || setupMessage,
      actual_response: null,
      steps: testCase.steps,
      expected: testCase.expected,
      api_evidence: [],
      videos: [],
      screenshots: [],
      traces: []
    }));
  }
  return {
    run_id: path.basename(runDir),
    base_url: baseUrl,
    started_at: startedAt,
    finished_at: nowIso(),
    results
  };
}

async function writePlaywrightConfig({
  configPath,
  testsDir,
  outputDir,
  reportPath,
  runnerConfig,
  plan
}: {
  configPath: string;
  testsDir: string;
  outputDir: string;
  reportPath: string;
  runnerConfig: ProGuide.Dict;
  plan: TestPlan;
}) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const expectTimeoutMs = expectTimeoutForPlan(plan);
  const configSource = [
    "const path = require('node:path');",
    '',
    'module.exports = {',
    `  testDir: ${JSON.stringify(testsDir)},`,
    `  outputDir: ${JSON.stringify(outputDir)},`,
    `  reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],`,
    `  expect: { timeout: ${expectTimeoutMs} },`,
    '  fullyParallel: true,',
    '  use: {',
    `    baseURL: process.env.PROGUIDE_BASE_URL || ${JSON.stringify('')},`,
    `    browserName: process.env.PROGUIDE_BROWSER || ${JSON.stringify(runnerConfig.browser || 'chromium')},`,
    `    screenshot: process.env.PROGUIDE_SCREENSHOTS || ${JSON.stringify(normalizePlaywrightScreenshot(runnerConfig.screenshots))},`,
    `    video: process.env.PROGUIDE_VIDEO || ${JSON.stringify(normalizePlaywrightVideo(runnerConfig.video))},`,
    `    trace: process.env.PROGUIDE_TRACES || ${JSON.stringify(normalizePlaywrightTrace(runnerConfig.traces))}`,
    '  }',
    '};',
    ''
  ].join('\n');
  await fs.writeFile(configPath, configSource, 'utf8');
}

export function expectTimeoutForPlan(plan: { cases?: Array<{ steps?: unknown[] }> } = {}) {
  const timeouts = [30000];
  for (const testCase of plan.cases || []) {
    for (const step of testCase.steps || []) {
      const match = String(step || '').match(/^set\s+(?:test|assertion)\s+timeout\s+to\s+(\d{1,5})\s+seconds?$/i);
      if (!match) continue;
      const ms = Number(match[1]) * 1000;
      if (Number.isFinite(ms) && ms > 0) timeouts.push(ms);
    }
  }
  return Math.max(...timeouts);
}


export function runProcess(command: string[], { cwd, env, logPath }: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise<RunProcessResult>((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', reject);
    child.stdout.on('data', (chunk) => fs.appendFile(logPath, chunk).catch(() => {}));
    child.stderr.on('data', (chunk) => fs.appendFile(logPath, chunk).catch(() => {}));
    child.on('close', (code) => resolve({ code: code ?? 0 }));
  });
}

export async function parsePlaywrightResults({
  plan,
  reportPath,
  runDir
}: {
  plan: TestPlan;
  reportPath: string;
  runDir: string;
}) {
  const caseById = new Map(plan.cases.map((testCase) => [String(testCase.id), testCase]));
  const caseBySafeId = new Map(plan.cases.map((testCase) => [safeId(testCase.id), testCase]));
  const parsed = new Map<string, ProGuide.Dict>();
  if (await exists(reportPath)) {
    const report = await readJson(reportPath, null);
    for (const spec of collectPlaywrightSpecs(report)) {
      const testCase = caseFromPlaywrightSpec(spec, caseById, caseBySafeId);
      if (!testCase) continue;
      const normalized = normalizePlaywrightSpecResult(spec);
      parsed.set(String(testCase.id), {
        id: testCase.id,
        title: testCase.title,
        status: normalized.status,
        duration_seconds: normalized.duration_seconds,
        message: normalized.message,
        error_details: normalized.error_details,
        actual_response: normalized.actual_response,
        steps: normalized.steps.length ? normalized.steps : testCase.steps,
        expected: testCase.expected,
        api_evidence: await collectApiEvidence(runDir, testCase.id),
        videos: await artifactPaths(runDir, normalized.attachments, new Set(['.webm']), safeId(testCase.id)),
        screenshots: await artifactPaths(runDir, normalized.attachments, new Set(['.png']), safeId(testCase.id)),
        traces: await artifactPaths(runDir, normalized.attachments, new Set(['.zip']), safeId(testCase.id))
      });
    }
  }

  const results = [];
  for (const testCase of plan.cases) {
    results.push(parsed.get(testCase.id) || {
      id: testCase.id,
      title: testCase.title,
      status: 'inconclusive',
      duration_seconds: 0,
      message: 'No Playwright result was found for this case.',
      error_details: '',
      actual_response: null,
      steps: testCase.steps,
      expected: testCase.expected,
      api_evidence: await collectApiEvidence(runDir, testCase.id),
      videos: await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, new Set(['.webm']), safeId(testCase.id)),
      screenshots: await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, new Set(['.png']), safeId(testCase.id)),
      traces: await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, new Set(['.zip']), safeId(testCase.id))
    });
  }
  return results;
}

async function artifactPaths(
  runDir: string,
  attachments: ProGuide.Dict[],
  suffixes: Set<string>,
  stem: string
) {
  const direct = [];
  for (const attachment of attachments || []) {
    const filePath = attachment.path ? path.resolve(String(attachment.path)) : '';
    if (!filePath || !suffixes.has(path.extname(filePath).toLowerCase()) || !(await exists(filePath))) continue;
    direct.push(relativePath(filePath, runDir));
  }
  const collected = await collectArtifacts(path.join(runDir, 'artifacts', 'playwright'), runDir, suffixes, stem);
  return [...new Set([...direct, ...collected])].sort();
}
