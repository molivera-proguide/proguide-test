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
import { mergeCaseData, dataFromLines, normalizeStep, inferCaseRoute } from '../lib/cases/normalize.js';
import { inferCaseType } from '../lib/cases/api-normalize.js';
import { parseMarkdownCases } from '../lib/markdown/parse-cases.js';
import { collectPlaywrightSpecs, normalizePlaywrightSpecResult } from '../lib/runner/results.js';
import { playwrightWorkerArgs } from '../lib/runner/config.js';
import { normalizeLlmUsage, estimateLlmCost } from '../lib/usage/pricing.js';

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
  assert.deepEqual(
    mergeCaseData({ a: 1, u: { x: 1 } }, { b: 2, u: { y: 2 } }),
    { b: 2, u: { y: 2, x: 1 }, a: 1 }
  );
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

test('cases/api-normalize: inferCaseType detects api vs ui', () => {
  assert.equal(inferCaseType({ type: 'api' }), 'api');
  assert.equal(
    inferCaseType({ request: { method: 'GET', path: '/x' } }),
    'api'
  );
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
  assert.deepEqual(collectPlaywrightSpecs(report).map((s) => s.title), ['a', 'b']);
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

test('usage/pricing: normalizeLlmUsage sums totals; estimateLlmCost returns a cost', () => {
  const usage = normalizeLlmUsage('anthropic', { input_tokens: 10, output_tokens: 5 });
  assert.equal(usage.total_tokens, 15);
  assert.equal(usage.provider, 'anthropic');
  const est = estimateLlmCost('anthropic', 'claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 1000 });
  assert.ok(Number.isFinite(est.cost_usd) && est.cost_usd > 0);
  assert.ok(est.pricing);
});
