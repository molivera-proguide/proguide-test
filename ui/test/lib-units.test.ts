import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the pure lib/ modules extracted during the refactor. These
// pin the behavior of the leaf helpers directly (no I/O, no LLM, no Playwright),
// complementing the markdown golden test and the e2e/cli integration suites.

import {
  norm,
  slug,
  normalizePriority,
  priorityForPlan,
  splitTags,
  noneIfEmpty,
  cleanCaseTitle,
  joinText
} from '../lib/shared/text.js';
import { safeNumber, roundMoney } from '../lib/shared/num.js';
import { isSecretKey, maskSecretText } from '../lib/shared/secrets.js';
import { isPlainObject } from '../lib/shared/object.js';
import { safeId } from '../lib/shared/id.js';
import { isPathInside } from '../lib/shared/paths.js';
import { escapeHtml } from '../lib/shared/html.js';
import {
  mergeCaseData,
  dataFromLines,
  normalizeStep,
  inferCaseRoute
} from '../lib/cases/normalize.js';
import { inferCaseType } from '../lib/cases/api-normalize.js';
import { parseMarkdownCases } from '../lib/markdown/parse-cases.js';
import {
  collectPlaywrightSpecs,
  normalizePlaywrightSpecResult,
  isLocatorError
} from '../lib/runner/results.js';
import { countSummary, statusFromSummary } from '../lib/run-store/io.js';
import { playwrightWorkerArgs } from '../lib/runner/config.js';
import { expectTimeoutForPlan } from '../lib/runner/playwright.js';
import { normalizeLlmUsage, estimateLlmCost } from '../lib/usage/pricing.js';
import { findInvalidGeneratedSelectors } from '../lib/codegen/agent.js';
import { buildTypeScriptCode } from '../views/code.js';

test('shared/text: norm folds accents, lowercases, strips emphasis, collapses space', () => {
  assert.equal(norm('  Hóla   MÚNDO *x* '), 'hola mundo x');
  assert.equal(norm(null), '');
});

test('shared/text: slug, priority, tags, noneIfEmpty, cleanCaseTitle, joinText', () => {
  assert.equal(slug('Hello World! @x'), 'hello-world-x');
  assert.equal(normalizePriority('high'), 'alta');
  assert.equal(normalizePriority('critical'), 'critica');
  assert.equal(normalizePriority('zz'), 'media');
  assert.equal(priorityForPlan('alta'), 'high');
  assert.deepEqual(splitTags('a, b; c'), ['a', 'b', 'c']);
  assert.equal(noneIfEmpty('   '), null);
  assert.equal(noneIfEmpty('x'), 'x');
  assert.equal(cleanCaseTitle('• Caso uno'), 'Caso uno');
  assert.equal(joinText('a', 'b'), 'a\nb');
  assert.equal(joinText('', 'b'), 'b');
});

test('shared/num: safeNumber and roundMoney', () => {
  assert.equal(safeNumber('3'), 3);
  assert.equal(safeNumber(undefined), 0);
  assert.equal(safeNumber('nope'), 0);
  assert.equal(roundMoney(1 / 3), Number(roundMoney(1 / 3)));
  assert.ok(Number.isFinite(roundMoney(0.123456789)));
});

test('shared/secrets: isSecretKey and maskSecretText', () => {
  assert.equal(isSecretKey('password'), true);
  assert.equal(isSecretKey('email'), false);
  assert.ok(!maskSecretText('Password: hunter2').includes('hunter2'));
});

test('shared/object, id, paths, html primitives', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(safeId('Caso #1: Login'), safeId('Caso #1: Login'));
  assert.ok(/^[a-z0-9_]+$/i.test(safeId('Caso #1: Login')));
  assert.equal(isPathInside('/a/b', '/a/b/c'), true);
  assert.equal(isPathInside('/a/b', '/a/x'), false);
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#039;&lt;/b&gt;');
});

test('cases/normalize: mergeCaseData deep-merges, primary wins', () => {
  assert.deepEqual(mergeCaseData({ a: 1, u: { x: 1 } }, { b: 2, u: { y: 2 } }), {
    b: 2,
    u: { y: 2, x: 1 },
    a: 1
  });
  assert.deepEqual(mergeCaseData({ a: 2 }, { a: 1 }), { a: 2 });
});

test('cases/normalize: dataFromLines maps email and masks secret keys', () => {
  assert.deepEqual(dataFromLines(['Email: a@b.com']), { user: { email: 'a@b.com' } });
  // password is a secret key and is dropped unless it is an allowed test key
  assert.deepEqual(dataFromLines(['Password: secret']), {});
});

test('cases/normalize: normalizeStep and inferCaseRoute', () => {
  assert.equal(normalizeStep('Ir a /login'), 'go to /login');
  assert.equal(inferCaseRoute('/', ['Ir a /panel']), '/panel');
  assert.equal(inferCaseRoute('/home', []), '/home');
});

test('cases/normalize: feedback DSL regressions stay explicit', () => {
  assert.equal(
    normalizeStep("expect text 'Afiliado elegible' to be visible"),
    'expect text "Afiliado elegible"'
  );
  assert.equal(
    normalizeStep("expect URL to contain '/elegibility'"),
    'expect url to contain "/elegibility"'
  );
  assert.equal(normalizeStep('click .MiClase'), 'click [.MiClase]');
  assert.equal(normalizeStep("click :has-text('X')"), "click [:has-text('X')]");
  assert.equal(
    normalizeStep("click X inside [role='list']"),
    'click text "X" inside [role=\'list\']'
  );
  assert.equal(
    normalizeStep("click listitem 'Modulo Salud'"),
    'click [li:has-text("Modulo Salud")]'
  );
  assert.equal(normalizeStep('wait 30 seconds'), 'wait 30 seconds');
  assert.equal(normalizeStep('set test timeout to 900 seconds'), 'set test timeout to 900 seconds');
  assert.equal(inferCaseRoute('/', ["expect URL to contain '/elegibility'"], []), '/');
});

test('cases/api-normalize: inferCaseType detects api vs ui', () => {
  assert.equal(inferCaseType({ type: 'api' }), 'api');
  assert.equal(inferCaseType({ request: { method: 'GET', path: '/x' } }), 'api');
  assert.equal(inferCaseType({ steps: ['click button'], expected: ['ok'] }), 'ui');
});

test('markdown/parse-cases: parses a TC heading block into one case', () => {
  const md = [
    '## TC-1 Login',
    'Pasos:',
    '1. Ir a /login',
    'Resultado esperado:',
    '- Muestra Dashboard'
  ].join('\n');
  const cases = parseMarkdownCases(md, { sourceName: 's.md' });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].route, '/login');
  assert.ok(cases[0].original_steps.length >= 1);
});

test('runner/results: collectPlaywrightSpecs flattens nested suites', () => {
  const report = { suites: [{ specs: [{ title: 'a' }], suites: [{ specs: [{ title: 'b' }] }] }] };
  assert.deepEqual(
    collectPlaywrightSpecs(report).map((s) => s.title),
    ['a', 'b']
  );
});

test('runner/results: normalizePlaywrightSpecResult maps passed status', () => {
  const spec = { ok: true, tests: [{ results: [{ status: 'passed', duration: 1200 }] }] };
  const out = normalizePlaywrightSpecResult(spec);
  assert.equal(out.status, 'passed');
  assert.equal(out.duration_seconds, 1.2);
});

test('runner/config: playwrightWorkerArgs', () => {
  assert.deepEqual(playwrightWorkerArgs({ runner: { parallel_workers: 'auto' } }), []);
  assert.deepEqual(playwrightWorkerArgs({ runner: { parallel_workers: 3 } }), ['--workers=3']);
  assert.deepEqual(playwrightWorkerArgs({ runner: { parallel_workers: '1' } }), ['--workers=1']);
  assert.throws(() => playwrightWorkerArgs({ runner: { parallel_workers: 'many' } }));
});

test('runner/playwright: expectTimeoutForPlan honors slow UI timeout DSL', () => {
  assert.equal(expectTimeoutForPlan({ cases: [] }), 30000);
  assert.equal(
    expectTimeoutForPlan({
      cases: [{ steps: ['set test timeout to 900 seconds'] }]
    }),
    900000
  );
  assert.equal(
    expectTimeoutForPlan({
      cases: [{ steps: ['set assertion timeout to 45 seconds'] }]
    }),
    45000
  );
});

test('views/code: TypeScript preview renders feedback DSL without navigation/assertion regressions', () => {
  const code = buildTypeScriptCode(
    {
      id: 'TC-UI-009',
      title: 'Consulta de elegibilidad',
      route: '/',
      executable_steps: [
        { normalized_action: 'set test timeout to 900 seconds' },
        { normalized_action: 'wait 30 seconds' },
        { normalized_action: 'expect url to contain "/elegibility"' },
        { normalized_action: 'click [.MiClase]' },
        { normalized_action: "click [:has-text('X')]" },
        { normalized_action: 'click text "X" inside [role=\'list\']' },
        { normalized_action: 'click [li:has-text("Modulo Salud")]' },
        { normalized_action: 'expect text "Afiliado elegible"' }
      ],
      expected_results: [],
      data: {}
    },
    { base_url: 'https://example.test' }
  );

  assert.ok(
    code.indexOf('test.setTimeout(900000);') < code.indexOf('await goto(page, baseUrl, "/");')
  );
  assert.match(code, /toHaveURL/);
  assert.doesNotMatch(code, /goto\(page, baseUrl, "\\\/elegibility"\)/);
  assert.match(code, /waitForTimeout\(30000\)/);
  assert.ok(code.includes('page.locator(".MiClase")'));
  assert.ok(code.includes('page.locator(":has-text(\'X\')")'));
  assert.ok(code.includes('page.locator("[role=\\"list\\"]")'));
  assert.ok(code.includes('page.locator("li:has-text'));
  assert.match(
    code,
    /toHaveURL\(new RegExp\(".\*\/elegibility.\*", 'i'\), \{ timeout: 900000 \}\)/
  );
  assert.match(code, /toBeVisible\(\{ timeout: 900000 \}\)/);
});

test('codegen/agent: rejects role attribute selectors without brackets', () => {
  assert.deepEqual(
    findInvalidGeneratedSelectors(`
    await page.locator("role='list'").getByText('Nueva Autorizacion').click();
    await page.locator('role=\\'menu\\'').click();
  `),
    ["role='list'", "role='menu'"]
  );

  assert.deepEqual(
    findInvalidGeneratedSelectors(`
    await page.locator("[role=\\"list\\"]").getByText('Nueva Autorizacion').click();
    await page.getByRole('list').getByText('Nueva Autorizacion').click();
  `),
    []
  );
});

test('usage/pricing: normalizeLlmUsage sums totals; estimateLlmCost returns a cost', () => {
  const usage = normalizeLlmUsage('anthropic', { input_tokens: 10, output_tokens: 5 });
  assert.equal(usage.total_tokens, 15);
  assert.equal(usage.provider, 'anthropic');
  const est = estimateLlmCost('anthropic', 'claude-haiku-4-5-20251001', {
    input_tokens: 1000,
    output_tokens: 1000
  });
  assert.ok(Number.isFinite(est.cost_usd) && est.cost_usd > 0);
  assert.ok(est.pricing);
});

test('runner/results: isLocatorError detects localization failures, not assertion failures', () => {
  assert.equal(isLocatorError(''), false);
  assert.equal(isLocatorError(null), false);
  // strict mode violation (ambiguous) -> calibration
  assert.equal(
    isLocatorError('strict mode violation: locator(\'label:has-text("Nombre")\') resolved to 2 elements'),
    true
  );
  // timeout waiting for a locator/getBy -> calibration
  assert.equal(
    isLocatorError('Timeout 30000ms exceeded.\n=========================== logs ===========================\nwaiting for locator(\'button:has-text("Acceder")\')'),
    true
  );
  assert.equal(
    isLocatorError('Timeout 5000ms exceeded waiting for getByRole("button", { name: "Acceder" })'),
    true
  );
  assert.equal(
    isLocatorError('Timeout 5000ms exceeded waiting for get_by_role("button", { name: "Acceder" })'),
    true
  );
  // locator not found -> calibration
  assert.equal(isLocatorError('locator("#missing") was not found'), true);
  // real Playwright format captured from an actual run -> calibration
  assert.equal(
    isLocatorError(
      "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Link Analysis')\nExpected: visible\nTimeout: 30000ms\nError: element(s) not found"
    ),
    true
  );
  // real assertion failure (element found, state/text mismatch) -> NOT calibration
  assert.equal(
    isLocatorError('Error: expect(locator("#status")).toHaveText("Listo")\nExpected: "Listo"\nReceived: "Pendiente"'),
    false
  );
  assert.equal(
    isLocatorError('Error: expect(page).toHaveURL(/\\/dashboard/)'),
    false
  );
  assert.equal(
    isLocatorError('Error: API response status 500 != 200'),
    false
  );
});

test('runner/results: normalizePlaywrightSpecResult reclassifies locator timeouts as needs_calibration', () => {
  const locatorTimeoutSpec = {
    ok: false,
    tests: [
      {
        results: [
          {
            status: 'failed',
            duration: 30000,
            errors: [
              {
                message:
                  'Timeout 30000ms exceeded.\nwaiting for locator(\'button:has-text("Acceder")\')'
              }
            ]
          }
        ]
      }
    ]
  };
  const out = normalizePlaywrightSpecResult(locatorTimeoutSpec);
  assert.equal(out.status, 'needs_calibration');
  // message is preserved (the locator error is still surfaced for calibration)
  assert.match(out.message || out.error_details || '', /waiting for locator/i);
});

test('runner/results: normalizePlaywrightSpecResult keeps real assertion failures as failed', () => {
  const assertionSpec = {
    ok: false,
    tests: [
      {
        results: [
          {
            status: 'failed',
            duration: 1200,
            errors: [
              {
                message:
                  'Error: expect(locator("#status")).toHaveText("Listo")\nExpected: "Listo"\nReceived: "Pendiente"'
              }
            ]
          }
        ]
      }
    ]
  };
  const out = normalizePlaywrightSpecResult(assertionSpec);
  assert.equal(out.status, 'failed');
});

test('run-store/io: countSummary counts needs_calibration as its own category', () => {
  const summary = {
    results: [
      { status: 'passed' },
      { status: 'failed' },
      { status: 'needs_calibration' },
      { status: 'needs_calibration' },
      { status: 'inconclusive' }
    ]
  };
  const counts = countSummary(summary);
  assert.equal(counts.passed, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.needs_calibration, 2);
  assert.equal(counts.inconclusive, 1);
});

test('run-store/io: statusFromSummary precedence setup_failed > failed > needs_calibration > inconclusive > passed', () => {
  assert.equal(statusFromSummary({ setup_failed: 1, failed: 1, needs_calibration: 1 }, 0), 'setup_failed');
  assert.equal(statusFromSummary({ setup_failed: 0, failed: 1, needs_calibration: 1 }, 0), 'failed');
  assert.equal(statusFromSummary({ failed: 0, needs_calibration: 2, inconclusive: 1 }, 0), 'needs_calibration');
  assert.equal(statusFromSummary({ needs_calibration: 0, inconclusive: 1, passed: 2 }, 0), 'inconclusive');
  assert.equal(statusFromSummary({ passed: 3, failed: 0, inconclusive: 0 }, 0), 'passed');
  // a run whose only failures are calibration -> needs_calibration, not failed
  assert.equal(statusFromSummary({ passed: 2, failed: 0, needs_calibration: 1 }, 0), 'needs_calibration');
});

test('codegen/grounding: parseStepTarget and groundStepAgainstSnapshot works correctly', async () => {
  const { parseStepTarget, groundStepAgainstSnapshot } = await import('../lib/codegen/grounding.js');

  assert.deepEqual(parseStepTarget('click button Acceder'), { type: 'text', value: 'Acceder' });
  assert.deepEqual(parseStepTarget('click #username'), { type: 'selector', value: '#username' });
  assert.deepEqual(parseStepTarget('fill [name="email"] with user'), { type: 'selector', value: '[name="email"]' });
  assert.deepEqual(parseStepTarget('expect text "Dashboard"'), { type: 'text', value: 'Dashboard' });

  const snapshot = {
    controls: [
      { selector_hint: '#username', id: 'username', text: '' },
      { selector_hint: 'button:has-text("Acceder")', text: 'Acceder', role: 'button' }
    ],
    visible_text: 'Bienvenido a la app. Dashboard cargado.',
    headings: ['Dashboard']
  };

  const step1 = { normalized_action: 'click #username' };
  const res1 = groundStepAgainstSnapshot(step1, snapshot);
  assert.equal(res1.status, 'resolved');
  assert.equal(res1.resolved_selector, '#username');

  const step2 = { normalized_action: 'click button Acceder' };
  const res2 = groundStepAgainstSnapshot(step2, snapshot);
  assert.equal(res2.status, 'resolved');
  assert.equal(res2.resolved_selector, 'button:has-text("Acceder")');

  const step3 = { normalized_action: 'expect text "Dashboard"' };
  const res3 = groundStepAgainstSnapshot(step3, snapshot);
  assert.equal(res3.status, 'resolved');
  assert.equal(res3.resolved_selector, 'text="Dashboard"');

  const step4 = { normalized_action: 'click #not_exists' };
  const res4 = groundStepAgainstSnapshot(step4, snapshot);
  assert.equal(res4.status, 'not_found');

  // Real normalizer wraps id selectors in brackets: `fill [#username] with "x"`.
  // Grounding must unwrap `[#id]` to match the snapshot's selector_hint `#username`.
  assert.deepEqual(parseStepTarget('fill [#username] with "x"'), {
    type: 'selector',
    value: '[#username]'
  });
  const step5 = { normalized_action: 'fill [#username] with "x"' };
  const res5 = groundStepAgainstSnapshot(step5, snapshot);
  assert.equal(res5.status, 'resolved');
  assert.equal(res5.resolved_selector, '#username');

  // Valueless fill is still parsed (gap fix).
  assert.deepEqual(parseStepTarget('fill [#username]'), {
    type: 'selector',
    value: '[#username]'
  });

  // Class/complex CSS selectors can't be confirmed from the snapshot -> unverified
  // (not a false not_found that would tempt the agent to "fix" a valid selector).
  const step6 = { normalized_action: 'click [.login-btn]' };
  const res6 = groundStepAgainstSnapshot(step6, snapshot);
  assert.equal(res6.status, 'unverified');
});


test('codegen/grounding: accent-insensitive match and ranked candidates', async () => {
  const { groundStepAgainstSnapshot, caseGroundingConfirmed } = await import(
    '../lib/codegen/grounding.js'
  );
  const snapshot = {
    controls: [
      { selector_hint: '[data-testid="submit"]', text: 'Accéder', role: 'button' },
      { selector_hint: '#cancel', text: 'Cancelar', role: 'button' },
      { selector_hint: '#help', text: 'Ayuda', role: 'link' }
    ],
    headings: [],
    visible_text: ''
  };

  // "Acceder" (no accent) resolves against "Accéder".
  const res = groundStepAgainstSnapshot({ normalized_action: 'click button Acceder' }, snapshot);
  assert.equal(res.status, 'resolved');
  assert.equal(res.resolved_selector, '[data-testid="submit"]');

  // Missing text -> not_found with the closest candidate ranked first.
  const miss = groundStepAgainstSnapshot(
    { normalized_action: 'click button Cancelacion' },
    snapshot
  );
  assert.equal(miss.status, 'not_found');
  assert.equal(miss.candidates[0].text, 'Cancelar');

  // caseGroundingConfirmed: true only when every targeted step resolved.
  assert.equal(
    caseGroundingConfirmed({
      executable_steps: [
        { normalized_action: 'fill [#username] with "x"', grounding: { status: 'resolved' } },
        { normalized_action: 'wait 2 seconds' }
      ]
    }),
    true
  );
  assert.equal(
    caseGroundingConfirmed({
      executable_steps: [
        { normalized_action: 'fill [#username] with "x"', grounding: { status: 'not_found' } }
      ]
    }),
    false
  );
  assert.equal(caseGroundingConfirmed({ executable_steps: [] }), false);
});

test('runner/results: grounded-confirmed locator failure stays failed (Prong A<->B)', async () => {
  const { normalizePlaywrightSpecResult } = await import('../lib/runner/results.js');
  const spec = {
    tests: [
      {
        results: [
          {
            status: 'failed',
            errors: [{ message: "Locator: getByText('Link Analysis')\nError: element(s) not found" }]
          }
        ]
      }
    ]
  };
  // Without grounding confirmation -> calibration.
  assert.equal(normalizePlaywrightSpecResult(spec).status, 'needs_calibration');
  // Grounding had confirmed the target existed -> a runtime miss is a real bug.
  assert.equal(
    normalizePlaywrightSpecResult(spec, { groundingConfirmed: true }).status,
    'failed'
  );
});
