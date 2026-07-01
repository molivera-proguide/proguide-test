import fs from 'node:fs/promises';
import path from 'node:path';
import { proguideRequireAnchor } from '../../playwright-runtime.js';
import { isApiPlanCase, generateApiTestSpec } from './api-spec.js';
import { casesToTestPlan } from './test-plan.js';
import {
  appendEvent,
  positiveInteger,
  chunkArray,
  readJson,
  walk,
  TEST_PLAN_JSON,
  SOURCE_MD
} from '../run-store/io.js';
import { callJsonModel } from '../llm/anthropic.js';

// LLM-driven Playwright codegen: build the per-batch payload, call the model,
// write/validate the generated spec files, and the runtime shim. REST cases use
// the deterministic api-spec generator. Extracted verbatim from
// proguide-service.js; generateTestsWithAgent/loadExistingTestPlan/extractCaseCode
// are imported back there.

const PLAYWRIGHT_CODE_AGENT_PROMPT = `You are a senior QA automation engineer.
Generate production-ready TypeScript Playwright Test code from already-approved QA test cases.

Rules:
- Do not create, remove, merge, split, or rename test cases.
- Generate one Playwright test(...) per input test case.
- Each test title must start with the exact provided test_title_prefix.
- Import Playwright from the generated runtime shim with:
  import { test, expect } from './proguide-test-runtime.mjs';
- Use TypeScript/JavaScript Playwright Test async API style.
- Use test.step for meaningful actions/assertions so evidence keeps readable steps.
- Use robust locators: getByRole, getByLabel, getByPlaceholder, getByText, locator with semantic attributes.
- When dom_context is available, prefer its real roles, labels, placeholders, text, data-testid, id, and name attributes over guessed selectors.
- Treat normalized steps as authoritative DSL:
  - fill [selector] with value -> page.locator(selector).fill(value)
  - click [selector] -> page.locator(selector).click()
  - click text "value" -> page.getByText(value).click() (role-agnostic; DO NOT assume button)
  - click button "value" -> page.getByRole('button', { name: value }).click()
  - click text "value" inside [selector] -> page.locator(selector).getByText(value).click()
  - fill text "value" inside [selector] with v -> page.locator(selector).getByLabel(value).fill(v)
  - fill [label="value"] with v -> page.getByLabel(value, { exact: true }).fill(v)
  - expect [label="value"] to be visible -> expect(page.getByLabel(value, { exact: true })).toBeVisible()
  - expect [selector] to contain text "value" -> assert that exact text
  - expect [selector] to be visible -> assert visibility
  - expect text "value" -> await expect(page.getByText("value").first()).toBeVisible({ timeout }); use .first() because the same visible text frequently appears in more than one element (e.g. a card title and a menu item), and a non-unique text must never trip strict mode
  - expect url to contain "value" -> assert the current URL with expect(page).toHaveURL(...)
  - wait N seconds -> page.waitForTimeout(N * 1000)
  - set test timeout to N seconds -> call test.setTimeout(N * 1000) at the top level of the test body, outside test.step
  - set assertion timeout to N seconds -> use that timeout for subsequent Playwright expect assertions
- Each step in the input \`steps\` array may have corresponding grounding information at the same index in \`steps_grounding\` (an array of grounding objects):
  - If a step's grounding has status "resolved" and a resolved_selector -> USE that exact selector; do not re-derive it.
  - If a step's grounding has status "ambiguous" and candidates -> the target is NOT unique; pick the right candidate (by role/text) or scope the locator. Never emit a bare locator that matches >1 element for an interaction.
  - If a step's grounding has status "not_found" or "unverified" -> fall back to dom_context / visible headings as today.
- The resolved_selector from steps_grounding beats your own guess and beats dom_context when both exist.
- Mandatory for assertions: if the step's literal text/element does NOT appear in dom_context (headings/visible_text/controls) and is NOT resolved in steps_grounding (status "resolved", or the best-ranked candidate of an "ambiguous"/"not_found" entry), NEVER emit that literal as the asserted text. Assert a REAL heading/text taken from dom_context instead (or, if nothing real is available, degrade to a safe visibility check on the page/body). Never assert text that does not exist on the screen — this includes generic placeholder names like "Dashboard", "Home" or similar that are not confirmed in dom_context.
- Mandatory initial navigation: every UI test must navigate to the test case's route at the start of the test, even if no normalized step is an explicit navigation ("go to ..."). Never leave a test starting at about:blank.
- Seeding browser storage (localStorage/sessionStorage/cookies) requires an established origin: page.evaluate that reads or writes localStorage throws "SecurityError: Access is denied for this document" on about:blank. To pre-set storage for a case (e.g. a corrupted or pre-existing session), FIRST page.goto the route, THEN set the storage via page.evaluate, THEN page.reload() so the app boots with that state. Never touch localStorage/sessionStorage before the first navigation.
- For login/credentials steps without an explicit selector: use the real input resolved by steps_grounding/dom_context (by its actual name/id/data-testid/label/placeholder/role), never assume a field is "the email" just because the step mentions email/user/password. Use the explicit value from the step text if present, otherwise data.user (email/username/password) or the PROGUIDE_USER_* environment credentials below. For the submit action, click the real button found in dom_context/steps_grounding (by its actual text/role), not a generic "submit" guess.
- API/REST cases are normally generated deterministically by ProGuide. If a case with type "api" appears, use Playwright request fixtures, not browser page locators.
- Do not use PROGUIDE_USER_* environment credentials when the step contains a literal email, username, password, or value.
- Use credentials from environment variables PROGUIDE_USER_EMAIL, PROGUIDE_USER_USERNAME, PROGUIDE_USER_PASSWORD when needed.
- If a test case includes data.user.email or data.user.password, prefer those per-case values for inputs over global defaults.
- Exact strings in expected and expected_results override shorter or older strings in original_steps.
- Never invent data-testid, id, name or placeholder attribute values. Use only attributes present in normalized steps or dom_context.snapshot.controls[]. If no selector exists, use getByLabel or getByText with the literal text of the step.
- :has-text() does substring matching; for labels/inputs, use exact matching (page.getByLabel(value, { exact: true }) or :text-is("value")).
- Strict mode: getByText/getByRole/locator throw "strict mode violation" if they resolve to more than one element. For presence/visibility assertions the intent is "this text/element is visible somewhere", so append .first() (e.g. expect(page.getByText("VulnOps").first()).toBeVisible(...)). For interactions (click/fill) on a target that is not unique, do NOT guess with .first(): scope it instead (a parent locator, getByRole with an accessible name, or an exact match).
- Treat the text inside [selector] as the exact selector contract. CSS class selectors (.ClassName), pseudo selectors (:has-text("X")), and CSS selectors such as li:has-text("X") must remain CSS selectors, not data-testid guesses.
- Bracketed attribute selectors must keep their brackets. For click text "Nueva Autorizacion" inside [role='list'], emit page.locator('[role="list"]').getByText(...), or page.getByRole('list').getByText(...). Never emit page.locator("role='list'").
- Prefer data-testid/id selector_hint over placeholder locators when the placeholder is empty, generic, or rendered as bullets/symbols.
- Keep assertions explicit with Playwright expect.
- Do not rely on Playwright's default 5000ms assertion timeout. Every toBeVisible, toContainText, toHaveURL, and similar expect assertion must pass an explicit timeout. Default to at least 30000ms; if a test has set test timeout or set assertion timeout, use that value for assertion timeout when appropriate.
- Include imports and any helper functions in the generated file.
- Return only valid JSON with this shape:
  {"files":[{"path":"test_markdown_cases.spec.ts","content":"...typescript code..."}]}
- Do not include markdown fences.`;

export async function generateTestsWithAgent({
  root,
  plan,
  cases,
  outputDir,
  config,
  domContext = {},
  usageContext = null
}: {
  root: string;
  plan: ProGuide.Dict;
  cases: ProGuide.CaseInput[];
  outputDir: string;
  config: ProGuide.Dict;
  domContext?: ProGuide.Dict;
  usageContext?: ProGuide.UsageContext | null;
}) {
  await fs.mkdir(outputDir, { recursive: true });
  await writePlaywrightRuntimeShim(outputDir);

  const apiCases: ProGuide.Dict[] = (plan.cases || []).filter(isApiPlanCase);
  const uiCases: ProGuide.Dict[] = (plan.cases || []).filter(
    (testCase: ProGuide.Dict) => !isApiPlanCase(testCase)
  );
  if (apiCases.length) {
    await fs.writeFile(
      path.join(outputDir, 'test_api_cases.spec.ts'),
      generateApiTestSpec(apiCases),
      'utf8'
    );
    if (usageContext?.runDir) {
      await appendEvent(usageContext.runDir, {
        run_id: usageContext.runId,
        type: 'code_generation_progress',
        status: 'generating',
        message: `Codigo REST generado sin LLM para ${apiCases.length} caso(s).`,
        payload: {
          cases: apiCases.map((testCase) => testCase.id)
        }
      });
    }
  }

  const batchSize = positiveInteger(config.llm.max_cases, 12);
  const batches = chunkArray(uiCases, batchSize);
  const usedPaths = new Set<string>();
  if (apiCases.length) usedPaths.add('test_api_cases.spec.ts');
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchCases = batches[batchIndex];
    const payload = buildCodeGenerationPayload({
      planCases: batchCases,
      sourceCases: cases,
      domContext,
      batchIndex,
      batchCount: batches.length
    });
    const data = await callJsonModel(config, {
      root,
      system: PLAYWRIGHT_CODE_AGENT_PROMPT,
      payload,
      purpose: `generar codigo TypeScript Playwright (lote ${batchIndex + 1}/${batches.length})`,
      usageContext
    });
    const files = normalizeGeneratedFiles(data);
    if (!files.length) {
      throw new Error(
        `El agente no devolvio archivos TypeScript para ejecutar en el lote ${batchIndex + 1}.`
      );
    }
    for (const file of files) {
      const relative = targetGeneratedPath(file.path, batchIndex, batches.length, usedPaths);
      await fs.writeFile(path.join(outputDir, relative), String(file.content || ''), 'utf8');
    }
    if (usageContext?.runDir) {
      await appendEvent(usageContext.runDir, {
        run_id: usageContext.runId,
        type: 'code_generation_progress',
        status: 'generating',
        message: `Codigo generado para lote ${batchIndex + 1}/${batches.length}.`,
        payload: {
          batch_index: batchIndex + 1,
          batch_count: batches.length,
          cases: batchCases.map((testCase) => testCase.id)
        }
      });
    }
  }
  await validateGeneratedCode(outputDir, plan);
}

async function writePlaywrightRuntimeShim(outputDir: string): Promise<void> {
  const source = [
    "import { createRequire } from 'node:module';",
    `const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || ${JSON.stringify(proguideRequireAnchor())});`,
    "const runtime = req('@playwright/test');",
    'export const test = runtime.test;',
    'export const expect = runtime.expect;',
    'export default runtime;',
    ''
  ].join('\n');
  await fs.writeFile(path.join(outputDir, 'proguide-test-runtime.mjs'), source, 'utf8');
}

export function buildCodeGenerationPayload({
  planCases,
  sourceCases,
  domContext = {},
  batchIndex,
  batchCount
}: {
  planCases: ProGuide.Dict[];
  sourceCases: ProGuide.CaseInput[];
  domContext?: ProGuide.Dict;
  batchIndex: number;
  batchCount: number;
}) {
  const outputPath =
    batchCount > 1
      ? `test_markdown_cases_${String(batchIndex + 1).padStart(3, '0')}.spec.ts`
      : 'test_markdown_cases.spec.ts';
  return {
    project: {
      base_url_is_available_as_playwright_base_url: true,
      test_runner: '@playwright/test',
      browser_library: 'playwright-test-typescript',
      runtime_shim: './proguide-test-runtime.mjs',
      required_import: "import { test, expect } from './proguide-test-runtime.mjs';"
    },
    required_output: {
      files: [
        {
          path: outputPath,
          content: 'complete TypeScript Playwright spec'
        }
      ]
    },
    batch: {
      index: batchIndex + 1,
      total: batchCount
    },
    test_cases: planCases.map((testCase) => {
      const sourceCase = sourceCases.find((item) => item.id === testCase.id) || {};
      return {
        id: testCase.id,
        test_title_prefix: `[${testCase.id}]`,
        type: testCase.type || 'ui',
        title: testCase.title,
        description: testCase.description,
        route: testCase.route,
        request: testCase.request || null,
        assertions: testCase.assertions || [],
        priority: testCase.priority,
        steps: testCase.steps,
        steps_grounding: testCase.steps_grounding || null,
        expected: testCase.expected,
        original_steps: sourceCase.original_steps || [],
        expected_results: sourceCase.expected_results || [],
        preconditions: sourceCase.preconditions || [],
        data_used: sourceCase.data_used || [],
        data: sourceCase.data || testCase.data || {},
        dom_context: domContext.by_case_id?.[testCase.id] || {
          available: false,
          reason: domContext.error || 'dom_context_not_collected'
        }
      };
    })
  };
}

export async function loadExistingTestPlan(
  runDir: string,
  cases: ProGuide.CaseInput[],
  run: ProGuide.Dict
) {
  const planPath = path.join(runDir, TEST_PLAN_JSON);
  const existing = await readJson(planPath, null);
  if (existing && Array.isArray(existing.cases)) {
    return existing;
  }
  return casesToTestPlan(cases, {
    sourceMd: SOURCE_MD,
    appName: run.app_name || 'ProGuide Markdown Cases'
  });
}

export function extractCaseCode(moduleText: string, caseId: string): string {
  const lines = moduleText.split(/\r?\n/);
  const testLineIndex = lines.findIndex((line) => {
    const text = String(line);
    return (
      /\btest\s*\(/.test(text) &&
      (text.includes(`[${caseId}]`) ||
        text.includes(JSON.stringify(`[${caseId}]`)) ||
        text.includes(String(caseId)))
    );
  });
  if (testLineIndex >= 0) {
    let blockEnd = lines.length;
    for (let index = testLineIndex + 1; index < lines.length; index += 1) {
      if (/^\s*test\s*\(/.test(lines[index])) {
        blockEnd = index;
        break;
      }
    }
    return lines.slice(testLineIndex, blockEnd).join('\n').trim();
  }
  return '';
}

function normalizeGeneratedFiles(data: ProGuide.Dict) {
  const files = Array.isArray(data.files) ? data.files : [];
  return files
    .map((file, index) => ({
      path:
        file.path ||
        (index === 0 ? 'test_markdown_cases.spec.ts' : `test_generated_${index + 1}.spec.ts`),
      content: file.content || file.code || ''
    }))
    .filter((file) => String(file.content || '').trim());
}

function safeGeneratedPath(value: unknown): string {
  const normalized = String(value || 'test_markdown_cases.spec.ts')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Ruta de codigo generada no permitida: ${value}`);
  }
  if (!/\.spec\.(?:ts|js)$/i.test(normalized)) {
    throw new Error(
      `El agente genero un archivo que no es spec TypeScript/JavaScript ejecutable por Playwright: ${normalized}`
    );
  }
  return normalized;
}

function targetGeneratedPath(
  value: unknown,
  batchIndex: number,
  batchCount: number,
  usedPaths: Set<string>
): string {
  let relative = safeGeneratedPath(value);
  if (batchCount > 1 && path.basename(relative) === 'test_markdown_cases.spec.ts') {
    relative = path.posix.join(
      path.posix.dirname(relative),
      `test_markdown_cases_${String(batchIndex + 1).padStart(3, '0')}.spec.ts`
    );
  }
  if (!usedPaths.has(relative)) {
    usedPaths.add(relative);
    return relative;
  }
  const parsed = path.posix.parse(relative);
  let suffix = 2;
  let candidate = path.posix.join(parsed.dir, `${parsed.name}_${suffix}${parsed.ext}`);
  while (usedPaths.has(candidate)) {
    suffix += 1;
    candidate = path.posix.join(parsed.dir, `${parsed.name}_${suffix}${parsed.ext}`);
  }
  usedPaths.add(candidate);
  return candidate;
}

async function validateGeneratedCode(outputDir: string, plan: ProGuide.Dict): Promise<void> {
  const specFiles: string[] = [];
  await walk(outputDir, async (filePath) => {
    if (/\.spec\.(?:ts|js)$/i.test(path.basename(filePath))) {
      specFiles.push(filePath);
    }
  });
  if (!specFiles.length) {
    throw new Error('No se genero ningun archivo de test TypeScript.');
  }
  const combined = (
    await Promise.all(specFiles.map((filePath) => fs.readFile(filePath, 'utf8')))
  ).join('\n');
  if (
    !combined.includes("from './proguide-test-runtime.mjs'") &&
    !combined.includes('from "./proguide-test-runtime.mjs"')
  ) {
    throw new Error('El codigo generado no importa el runtime shim de ProGuide.');
  }
  for (const testCase of plan.cases) {
    if (!combined.includes(`[${testCase.id}]`)) {
      throw new Error(`El codigo generado no incluye el prefijo de test [${testCase.id}].`);
    }
  }
  const invalidSelectors = findInvalidGeneratedSelectors(combined);
  if (invalidSelectors.length) {
    throw new Error(
      `El codigo generado contiene selector Playwright invalido: ${invalidSelectors[0]}. Usa [role="..."] o getByRole(...).`
    );
  }
}

export function findInvalidGeneratedSelectors(source: unknown): string[] {
  const invalid: Array<{ selector: string; index: number }> = [];
  const patterns = [
    /\blocator\s*\(\s*'((?:\\.|[^'\\])*)'/g,
    /\blocator\s*\(\s*"((?:\\.|[^"\\])*)"/g,
    /\blocator\s*\(\s*`((?:\\.|[^`\\])*)`/g
  ];
  for (const pattern of patterns) {
    for (const match of String(source || '').matchAll(pattern)) {
      const selector = unescapeJsStringFragment(match[1]);
      if (/^\s*role\s*=/.test(selector)) invalid.push({ selector, index: match.index || 0 });
    }
  }
  const seen = new Set<string>();
  return invalid
    .sort((left, right) => left.index - right.index)
    .map((item) => item.selector)
    .filter((selector) => {
      if (seen.has(selector)) return false;
      seen.add(selector);
      return true;
    });
}

function unescapeJsStringFragment(value: unknown): string {
  return String(value || '')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
