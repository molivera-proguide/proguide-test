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

  // A1, A2, C1 regressions
  assert.equal(normalizeStep('Click the "Acceder" button'), 'click button Acceder');
  assert.equal(normalizeStep('Press "Entrar"'), 'click text "Entrar"');
  assert.equal(normalizeStep('clic en "Volver"'), 'click text "Volver"');
  assert.equal(normalizeStep('click "BPM"'), 'click text "BPM"');
  assert.equal(normalizeStep('Click the "Solicitar nuevo Caso"'), 'click text "Solicitar nuevo Caso"');
  assert.equal(normalizeStep('click button "Acceder"'), 'click button Acceder');
  assert.equal(normalizeStep('haz clic en el botón "Acceder"'), 'click button Acceder');
  assert.equal(
    normalizeStep('fill the "Nombre" input inside the "Persona de contacto técnico" section with "Mariano"'),
    'fill [label="Nombre"] with "Mariano"'
  );
  assert.equal(
    normalizeStep('fill the "Nombre" input inside "#section-id" with "Mariano"'),
    'fill text "Nombre" inside [#section-id] with "Mariano"'
  );
});

test('cases/normalize: does not fabricate app content (PLAN-dehardcode-normalizer Ola 1+2)', () => {
  // Tier 1: a vague post-login assertion is no longer rewritten into the
  // hardcoded English literal "expect text Dashboard" — it falls through as
  // raw text for grounding + the codegen LLM to resolve against the real DOM.
  assert.equal(
    normalizeStep('verificar que se muestra el dashboard'),
    'verificar que se muestra el dashboard'
  );
  assert.equal(
    normalizeStep('Se muestra el dashboard de administracion'),
    'Se muestra el dashboard de administracion'
  );
  // Tier 2: navigation intent without a real, explicit route is not rewritten
  // into a fabricated "go to /" destination.
  assert.equal(normalizeStep('Ir al dashboard'), 'Ir al dashboard');
  assert.equal(normalizeStep('Acceder a la aplicacion'), 'Acceder a la aplicacion');
  // An explicit route is still extracted and rewritten (Tier 1/2 "mantener").
  assert.equal(normalizeStep('Ir a /dashboard'), 'go to /dashboard');
  // Ola 2 / Tier 3: login/credential steps without an explicit selector or
  // value no longer guess "this field is the email/password" — they stay raw
  // for grounding (real input) + the explicit/data.user value to resolve.
  assert.equal(normalizeStep('Ingresar usuario valido'), 'Ingresar usuario valido');
  assert.equal(normalizeStep('completar usuario con eolivera'), 'completar usuario con eolivera');
  assert.equal(
    normalizeStep('Completar la contrasena con un valor invalido'),
    'Completar la contrasena con un valor invalido'
  );
  assert.equal(normalizeStep('Enviar el formulario'), 'Enviar el formulario');
});

test('cases/normalize: recovers explicit value+field from "Ingresar `X` en `Y`" (walk-starving fix)', () => {
  // The value comes BEFORE the field and both are backtick-quoted. The generic
  // "fill FIELD with VALUE" extractor missed the value and emitted a valueless
  // `fill [selector]`, which made the grounding walk type empty credentials, fail
  // the login and never reach the post-login screens (dom_context login-only).
  assert.equal(
    normalizeStep('Ingresar `qa@testsprite.dev` en `login-email`.'),
    'fill [data-testid="login-email"] with qa@testsprite.dev'
  );
  assert.equal(
    normalizeStep('Ingresar `testsprite123` en `login-password`.'),
    'fill [data-testid="login-password"] with testsprite123'
  );
  // English + "in", and Spanish "en el campo" between value and field.
  assert.equal(
    normalizeStep('Enter `abcdef` in `login-password`'),
    'fill [data-testid="login-password"] with abcdef'
  );
  assert.equal(
    normalizeStep('Escribir `foo` en el campo `bar`'),
    'fill [data-testid="bar"] with foo'
  );
  // A field given as an explicit selector keeps its selector form.
  assert.equal(normalizeStep('Ingresar `a@b.com` en `#email`'), 'fill [#email] with a@b.com');
  // Backtick value with a bare (unquoted) field still recovers the value via the
  // value-after-selector fallback (previously only ' and " were recognized).
  assert.equal(
    normalizeStep('Ingresar `qa@testsprite.dev` en el campo login-email'),
    'fill [data-testid="login-email"] with qa@testsprite.dev'
  );
  // A vague login step (no explicit value+field) still stays raw (Ola 2, unchanged).
  assert.equal(normalizeStep('Completar un login valido'), 'Completar un login valido');
});

test('cases/normalize: does not fabricate a selector from a case/requirement reference', () => {
  // "(TC-02)" is a cross-reference to another case, not an app selector. The
  // hyphen-fallback used to turn it into `fill [data-testid="TC-02"]`; now the
  // step stays raw so grounding + the codegen LLM resolve it against the real DOM.
  assert.equal(
    normalizeStep('Completar un login valido (TC-02).'),
    'Completar un login valido (TC-02).'
  );
  assert.equal(normalizeStep('Repetir el paso del caso RF-01'), 'Repetir el paso del caso RF-01');
  // A real hyphenated data-testid token is still extracted (regression guard).
  assert.equal(
    normalizeStep('Hacer clic en `login-submit`.'),
    'click [data-testid="login-submit"]'
  );
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

test('views/code: TypeScript preview renders new role-agnostic and label DSL forms', () => {
  const code = buildTypeScriptCode(
    {
      id: 'TC-UI-010',
      title: 'Formas DSL nuevas',
      route: '/',
      executable_steps: [
        { normalized_action: 'click text "BPM"' },
        { normalized_action: 'fill [label="Nombre"] with "Mariano"' },
        { normalized_action: 'fill text "Nombre" inside [#section-id] with "Mariano"' }
      ],
      expected_results: [],
      data: {}
    },
    { base_url: 'https://example.test' }
  );

  // click text "BPM" -> role-agnostic getByText, NOT a button locator nor a TODO
  assert.match(code, /getByText\(new RegExp\(escapeRegExp\("BPM"\), 'i'\)\)\.first\(\)\.click/);
  assert.doesNotMatch(code, /TODO: ajustar/);
  // fill [label="Nombre"] -> exact label, no invalid [label=...] CSS selector
  assert.match(code, /getByLabel\("Nombre", \{ exact: true \}\)\.first\(\)\.fill\("Mariano"/);
  assert.doesNotMatch(code, /locator\("\[label=/);
  // fill text "Nombre" inside [#section-id] -> scoped getByLabel within the container
  assert.match(code, /locator\("#section-id"\)\.getByLabel\("Nombre"\)\.first\(\)\.fill\("Mariano"/);
});

test('views/code: preview never fabricates a "redirect to dashboard/home" URL guess', () => {
  const code = buildTypeScriptCode(
    {
      id: 'TC-UI-011',
      title: 'Login redirige',
      route: '/login',
      executable_steps: [],
      expected_results: ['El sistema redirige al dashboard principal'],
      data: {}
    },
    { base_url: 'https://example.test' }
  );
  // No invented URL keyword pattern (home|dashboard|app|inicio): a vague
  // expected result with no real, literal text degrades to a safe check
  // instead of guessing app vocabulary (PLAN-dehardcode-normalizer.md §6.3).
  assert.doesNotMatch(code, /toHaveURL\(\/\.\*\(home\|dashboard\|app\|inicio\)/);
  assert.match(code, /expect\(page\.locator\("body"\)\)\.toBeVisible/);
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
  // and it carries the concrete recommended action for the QA
  assert.match(out.review_note, /Recalibrar/i);
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
  assert.deepEqual(parseStepTarget('click text "BPM"'), { type: 'text', value: 'BPM' });
  assert.deepEqual(parseStepTarget('fill text "Nombre" inside [#section-id] with Mariano'), { type: 'text', value: 'Nombre' });

  const snapshot = {
    controls: [
      { selector_hint: '#username', id: 'username', text: '' },
      { selector_hint: 'button:has-text("Acceder")', text: 'Acceder', role: 'button' },
      { selector_hint: 'li:has-text("BPM")', text: 'BPM', role: 'listitem' }
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

  // Role-agnostic click text resolved against li
  const step6 = { normalized_action: 'click text "BPM"' };
  const res6 = groundStepAgainstSnapshot(step6, snapshot);
  assert.equal(res6.status, 'resolved');
  assert.equal(res6.resolved_selector, 'li:has-text("BPM")');

  // Class/complex CSS selectors can't be confirmed from the snapshot -> unverified
  // (not a false not_found that would tempt the agent to "fix" a valid selector).
  const step7 = { normalized_action: 'click [.login-btn]' };
  const res7 = groundStepAgainstSnapshot(step7, snapshot);
  assert.equal(res7.status, 'unverified');
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

test('codegen/grounding: mergeWalkSnapshots unions screens so a later-screen assertion resolves', async () => {
  const { mergeWalkSnapshots, groundStepAgainstSnapshot } = await import('../lib/codegen/grounding.js');
  // Login screen then post-login dashboard, as the walk would capture across steps.
  const walkSteps = [
    {
      number: 1,
      snapshot: {
        url: '/',
        controls: [{ selector_hint: '#username', id: 'username', text: '' }],
        headings: ['Ingreso'],
        visible_text: 'Ingreso'
      }
    },
    {
      number: 2,
      snapshot: {
        url: '/home',
        controls: [],
        headings: [],
        visible_text: 'Home Informes Reportes Módulo Salud version 3.0.4'
      }
    }
  ];
  const merged = mergeWalkSnapshots(walkSteps);
  // A post-login assertion absent from the login screen still resolves against
  // the union of screens the walk saw (fixes the false not_found / review_note).
  assert.equal(
    groundStepAgainstSnapshot({ normalized_action: 'expect text "Informes"' }, merged).status,
    'resolved'
  );
  // A genuinely absent text is still not_found (no false green).
  assert.equal(
    groundStepAgainstSnapshot({ normalized_action: 'expect text "No Existe 999"' }, merged).status,
    'not_found'
  );
});

test('codegen/grounding: caseHasNotFoundTarget flags a not_found target as a signal', async () => {
  const { caseHasNotFoundTarget } = await import('../lib/codegen/grounding.js');
  assert.equal(
    caseHasNotFoundTarget({
      executable_steps: [
        { normalized_action: 'expect text "Finanzas familiares"', grounding: { status: 'resolved' } }
      ]
    }),
    false
  );
  assert.equal(
    caseHasNotFoundTarget({
      executable_steps: [
        { normalized_action: 'expect text "Dashboard"', grounding: { status: 'not_found' } }
      ]
    }),
    true
  );
  // ambiguous/unverified are not a not_found signal by themselves.
  assert.equal(
    caseHasNotFoundTarget({
      executable_steps: [
        { normalized_action: 'click [.btn]', grounding: { status: 'unverified' } }
      ]
    }),
    false
  );
  assert.equal(caseHasNotFoundTarget({ executable_steps: [] }), false);
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

test('runner/results: a passed test whose dry-run could not verify a target stays passed with an advisory note (not needs_calibration)', async () => {
  const { normalizePlaywrightSpecResult } = await import('../lib/runner/results.js');
  const passedSpec = {
    ok: true,
    tests: [{ results: [{ status: 'passed', duration: 500 }] }]
  };
  // Plain pass, no unresolved target -> passed, no note.
  const plain = normalizePlaywrightSpecResult(passedSpec);
  assert.equal(plain.status, 'passed');
  assert.equal(plain.review_note, '');
  // Passed but the dry-run had a not_found target: NOT a calibration issue
  // (nothing broke, the runner compensated the missing precondition). It stays
  // `passed` with an advisory note instead of dragging the run into
  // needs_calibration, so the flag only fires when there is real work to do.
  const unverified = normalizePlaywrightSpecResult(passedSpec, { hasNotFoundTarget: true });
  assert.equal(unverified.status, 'passed');
  assert.match(unverified.review_note, /Sin accion requerida/i);
});

test('codegen/test-plan & agent: casesToTestPlan and buildCodeGenerationPayload propagate grounding', async () => {
  const { casesToTestPlan } = await import('../lib/codegen/test-plan.js');
  const { buildCodeGenerationPayload } = await import('../lib/codegen/agent.js');

  const cases = [
    {
      id: 'tc_1',
      title: 'UI Test case',
      automation_state: 'listo',
      type: 'ui',
      executable_steps: [
        { normalized_action: 'click button Acceder', grounding: { status: 'resolved', resolved_selector: 'button:has-text("Acceder")' } },
        { normalized_action: 'wait 2 seconds' }
      ]
    }
  ];

  const plan = casesToTestPlan(cases, { sourceMd: 'test.md', appName: 'Test' });
  assert.equal(plan.cases.length, 1);
  assert.deepEqual(plan.cases[0].steps, ['click button Acceder', 'wait 2 seconds']);
  assert.deepEqual(plan.cases[0].steps_grounding, [
    { status: 'resolved', resolved_selector: 'button:has-text("Acceder")' },
    null
  ]);

  const payload = buildCodeGenerationPayload({
    planCases: plan.cases,
    sourceCases: cases,
    domContext: { by_case_id: { tc_1: { available: true } } },
    batchIndex: 0,
    batchCount: 1
  });

  assert.equal(payload.test_cases.length, 1);
  assert.deepEqual(payload.test_cases[0].steps_grounding, [
    { status: 'resolved', resolved_selector: 'button:has-text("Acceder")' },
    null
  ]);
});

test('version: checkStaleVersion reports not-stale when the on-disk version matches the running one', async () => {
  const { checkStaleVersion, RUNNING_VERSION } = await import('../lib/version.js');
  // In a fresh process the loaded version equals what is on disk, so nothing is
  // stale. The stale=true path only fires after a live reinstall bumps the disk
  // version above the one captured at startup (validated manually / in the field).
  assert.ok(RUNNING_VERSION, 'running version should be resolved from package.json');
  const result = checkStaleVersion();
  assert.equal(result.running, RUNNING_VERSION);
  assert.equal(result.onDisk, RUNNING_VERSION);
  assert.equal(result.stale, false);
});

