import fs from 'node:fs/promises';
import path from 'node:path';
import { isApiPlanCase } from './api-spec.js';
import { runProcess } from '../runner/playwright.js';
import { runtimeEnv } from '../../playwright-runtime.js';
import { ensureSession } from '../auth/session.js';
import { writeJson, readJson, exists, firstUsefulLogLine, PROGUIDE_DIR } from '../run-store/io.js';

function stripWrappingQuotes(val: string): string {
  return val.replace(/^["']|["']$/g, '');
}

function normText(val: unknown): string {
  return String(val || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2));
  return out;
}

// Lightweight, dependency-free similarity in [0,1]: exact > substring >
// character-bigram Dice coefficient. Character bigrams (not whole words) so that
// variants/typos like "Cancelacion" vs "Cancelar" rank close.
function similarity(a: unknown, b: unknown): number {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const bx = bigrams(x);
  const by = bigrams(y);
  if (!bx.length || !by.length) return 0;
  const counts = new Map<string, number>();
  for (const gram of by) counts.set(gram, (counts.get(gram) || 0) + 1);
  let inter = 0;
  for (const gram of bx) {
    const remaining = counts.get(gram) || 0;
    if (remaining > 0) {
      inter += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * inter) / (bx.length + by.length);
}

function ctrlTextBlob(ctrl: ProGuide.Dict): string {
  return [ctrl.text, (ctrl.label || []).join(' '), ctrl.aria_label, ctrl.placeholder]
    .filter(Boolean)
    .join(' ');
}

function rankedCandidates(controls: ProGuide.Dict[], target: string, limit = 5): ProGuide.Dict[] {
  return controls
    .map((ctrl) => ({ ctrl, score: similarity(target, ctrlTextBlob(ctrl)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ ctrl }) => ({ selector: ctrl.selector_hint, text: ctrl.text, role: ctrl.role }));
}

// True only when grounding actively confirmed every element-targeting step of a
// case (status `resolved`). Used at execution time to decide that a later
// locator failure is a real regression, not a calibration miss. Returns false
// when no grounding ran or any target was unresolved/ambiguous/unverified.
export function caseGroundingConfirmed(testCase: ProGuide.Dict): boolean {
  const steps = testCase?.executable_steps || [];
  let targeted = 0;
  for (const step of steps) {
    if (!parseStepTarget(step.normalized_action || step.original_text || '')) continue;
    targeted += 1;
    if (!step.grounding || step.grounding.status !== 'resolved') return false;
  }
  return targeted > 0;
}

// True when at least one element-targeting step of the case was grounded as
// `not_found` (the dry-run walk found the screen but no matching element/text).
// Used as a SIGNAL, not a gate: a case can still execute and even "pass" (e.g.
// the LLM fell back to a real heading instead of the unresolved literal), but
// the result is flagged `needs_calibration` instead of a plain `passed` so a
// lucky-by-chance green doesn't hide an unverified target.
export function caseHasNotFoundTarget(testCase: ProGuide.Dict): boolean {
  const steps = testCase?.executable_steps || [];
  return steps.some(
    (step: ProGuide.Dict) =>
      parseStepTarget(step.normalized_action || step.original_text || '') &&
      step.grounding?.status === 'not_found'
  );
}

export function parseStepTarget(action: string): { type: 'selector' | 'text'; value: string } | null {
  if (!action) return null;
  
  // 1. expect text "something" -> text "something"
  const expectTextMatch = action.match(/^expect text\s+["'](.+?)["']\s*$/i);
  if (expectTextMatch) {
    return { type: 'text', value: expectTextMatch[1] };
  }

  // 2. click text "something" inside [selector] -> text "something"
  const clickTextMatch = action.match(/^click text\s+["'](.+?)["']\s+inside\s+(.+)$/i);
  if (clickTextMatch) {
    return { type: 'text', value: clickTextMatch[1] };
  }

  const clickTextBare = action.match(/^click text\s+["'](.+?)["']\s*$/i);
  if (clickTextBare) return { type: 'text', value: clickTextBare[1] };

  const fillTextInsideMatch = action.match(/^fill text\s+["'](.+?)["']\s+inside\s+(.+?)\s+with\s+(.+)$/i);
  if (fillTextInsideMatch) {
    return { type: 'text', value: fillTextInsideMatch[1] };
  }

  // 3. click [li:has-text("something")] -> text "something"
  const liMatch = action.match(/^click \[li:has-text\((.+?)\)\]$/i);
  if (liMatch) {
    const textVal = stripWrappingQuotes(liMatch[1].trim());
    return { type: 'text', value: textVal };
  }

  // 4. go to /route -> skip (no element target to verify)
  if (action.startsWith('go to ')) {
    return null;
  }

  // 5. click button something -> text "something" or selector
  const clickButtonMatch = action.match(/^click button\s+(.+)$/i);
  if (clickButtonMatch) {
    const val = clickButtonMatch[1].trim();
    if (/^[#.[]/.test(val)) {
      return { type: 'selector', value: val };
    }
    return { type: 'text', value: val };
  }

  // 6. click [selector]
  const clickMatch = action.match(/^click\s+(.+)$/i);
  if (clickMatch) {
    const val = clickMatch[1].trim();
    if (/^[#.[]/.test(val)) {
      return { type: 'selector', value: val };
    }
    return { type: 'text', value: val };
  }

  // 7. fill [selector] with value  (and the valueless form `fill [selector]`)
  const fillMatch =
    action.match(/^fill\s+(.+?)\s+with\s+(.+)$/i) || action.match(/^fill\s+(.+)$/i);
  if (fillMatch) {
    const val = fillMatch[1].trim();
    if (/^[#.[]/.test(val)) {
      return { type: 'selector', value: val };
    }
    return { type: 'text', value: val };
  }

  // 8. expect [selector] to be visible / contain text
  const expectMatch = action.match(/^expect\s+(.+?)\s+to\s+(?:be\s+visible|contain\s+text\s+(.+))$/i);
  if (expectMatch) {
    const val = expectMatch[1].trim();
    if (/^[#.[]/.test(val)) {
      return { type: 'selector', value: val };
    }
    return { type: 'text', value: val };
  }

  return null;
}

export function groundStepAgainstSnapshot(
  step: ProGuide.Dict,
  snapshot: any
): {
  status: 'resolved' | 'ambiguous' | 'not_found' | 'unverified';
  resolved_selector?: string;
  candidates: any[];
} {
  const action = step.normalized_action || step.original_text || '';
  
  if (
    /^(wait \d+|set test timeout|set assertion timeout|refresh page)/i.test(action) ||
    action.startsWith('go to ')
  ) {
    return { status: 'resolved', candidates: [] };
  }

  const target = parseStepTarget(action);
  if (!target) {
    return { status: 'resolved', candidates: [] };
  }

  const controls = snapshot.controls || [];
  const matches: any[] = [];

  if (target.type === 'selector') {
    // ProGuide's DSL wraps selectors in brackets, including id/class:
    // `[#username]` means the selector `#username`. Unwrap so it matches the
    // snapshot's selector_hint (`#username`). Attribute selectors like
    // `[data-testid="x"]` / `[name="x"]` stay as-is (handled below).
    const rawSel = target.value.trim();
    const idWrap = rawSel.match(/^\[(#[^\]]+|\.[^\]]+)\]$/);
    const sel = idWrap ? idWrap[1] : rawSel;
    let idVal = '';
    let testIdVal = '';
    let nameVal = '';
    
    if (sel.startsWith('#')) {
      idVal = sel.slice(1);
    } else {
      const testIdMatch = sel.match(/\[data-testid=["'](.+?)["']\]/i) || sel.match(/\[data-test=["'](.+?)["']\]/i) || sel.match(/\[data-cy=["'](.+?)["']\]/i);
      if (testIdMatch) {
        testIdVal = testIdMatch[1];
      }
      const nameMatch = sel.match(/\[name=["'](.+?)["']\]/i);
      if (nameMatch) {
        nameVal = nameMatch[1];
      }
    }

    for (const ctrl of controls) {
      if (
        ctrl.selector_hint === sel ||
        (idVal && ctrl.id === idVal) ||
        (testIdVal && ctrl.data_testid === testIdVal) ||
        (nameVal && ctrl.name === nameVal)
      ) {
        matches.push(ctrl);
      }
    }

    // The snapshot only exposes id/data-testid/name/role/text. For class or
    // complex CSS selectors we cannot confirm presence, so a miss is "unverified"
    // (don't claim not_found and tempt the agent to "fix" a valid selector).
    const verifiable = Boolean(idVal || testIdVal || nameVal);
    if (matches.length === 0 && !verifiable) {
      return { status: 'unverified', candidates: [] };
    }
  } else {
    // Text target (accent- and case-insensitive)
    const textVal = normText(target.value);

    for (const ctrl of controls) {
      const ctrlText = normText(ctrl.text);
      const ctrlLabel = (ctrl.label || []).map((l: string) => normText(l));
      const ctrlAria = normText(ctrl.aria_label);
      const ctrlPlaceholder = normText(ctrl.placeholder);

      if (
        ctrlText === textVal ||
        ctrlText.includes(textVal) ||
        ctrlLabel.includes(textVal) ||
        ctrlAria === textVal ||
        ctrlPlaceholder === textVal
      ) {
        matches.push(ctrl);
      }
    }

    // Check headings and visible text for assertion steps
    const isAssertion = /expect/i.test(action);
    if (matches.length === 0 && isAssertion) {
      const visibleText = normText(snapshot.visible_text);
      const headings = (snapshot.headings || []).map((h: string) => normText(h));
      if (visibleText.includes(textVal) || headings.some((h) => h.includes(textVal))) {
        return {
          status: 'resolved',
          resolved_selector: 'text="' + target.value + '"',
          candidates: []
        };
      }
    }
  }

  if (matches.length === 1) {
    return {
      status: 'resolved',
      resolved_selector: matches[0].selector_hint,
      candidates: []
    };
  } else if (matches.length > 1) {
    return {
      status: 'ambiguous',
      candidates: matches.map(m => ({
        selector: m.selector_hint,
        text: m.text,
        role: m.role
      }))
    };
  } else {
    // Surface the closest elements first so the agent can pick the right one.
    return {
      status: 'not_found',
      candidates: rankedCandidates(controls, target.value, 5)
    };
  }
}

// Step-driven walk probe: navigates the route (reusing storageState when auth is
// configured), and for each step takes a DOM snapshot BEFORE executing it, then
// executes the step best-effort to advance the flow (tolerant: a failed step
// doesn't abort the walk). Each step is grounded against the screen it would act
// on — so post-login targets (e.g. an assertion after a login click) get the
// real authenticated screen, not the login page.
const WALK_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { URL } = require('node:url');

const req = createRequire(process.env.PROGUIDE_PLAYWRIGHT_REQUIRE || __filename);
const playwright = req('playwright');

const DOM_SNAPSHOT_JS = (maxControls) => {
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const text = (value, limit = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const cssEscape = (value) => {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  };
  const inferredRole = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') return el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return '';
  };
  const labelsFor = (el) => {
    const labels = [];
    if (el.id) {
      document.querySelectorAll('label[for="' + cssEscape(el.id) + '"]').forEach((label) => labels.push(text(label.textContent)));
    }
    if (el.labels) Array.from(el.labels).forEach((label) => labels.push(text(label.textContent)));
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) labels.push(text(wrappingLabel.textContent));
    return [...new Set(labels.filter(Boolean))].slice(0, 3);
  };
  const selectorHint = (el) => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
    if (testId) return '[data-testid="' + testId + '"]';
    if (el.id) return '#' + cssEscape(el.id);
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
    const tag = el.tagName.toLowerCase();
    if (tag === 'li') {
      const innerText = text(el.innerText || el.textContent, 30).replace(/"/g, '\\"');
      if (innerText) {
        return 'li:has-text("' + innerText + '")';
      }
    }
    return tag;
  };
  const controls = Array.from(document.querySelectorAll('input, textarea, select, button, a, li, label, [role], [onclick], [data-testid], [data-test], [data-cy]'))
    .filter(visible)
    .slice(0, maxControls)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: inferredRole(el),
      text: text(el.innerText || el.textContent),
      label: labelsFor(el),
      aria_label: text(el.getAttribute('aria-label')),
      placeholder: text(el.getAttribute('placeholder')),
      name: text(el.getAttribute('name')),
      type: text(el.getAttribute('type')),
      id: text(el.id),
      data_testid: text(el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy')),
      selector_hint: selectorHint(el)
    }));
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .filter(visible)
    .slice(0, 20)
    .map((el) => text(el.innerText || el.textContent));
  const visible_text = Array.from(document.querySelectorAll('main, body'))
    .slice(0, 1)
    .map((el) => text(el.innerText || el.textContent, 1000))[0] || '';
  return { url: window.location.href, title: document.title, headings, controls, visible_text };
};

function targetUrl(baseUrl, route) {
  const value = String(route || '/');
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(baseUrl || '').replace(/\/+$/, '') + '/';
  return new URL(value.replace(/^\/+/, ''), base).href;
}

function stripQuotes(v) {
  return String(v || '').replace(/^["']|["']$/g, '');
}

function dslToCss(sel) {
  const m = String(sel || '').match(/^\[(#.+|\..+)\]$/);
  return m ? m[1] : String(sel || '');
}

// Fill that self-corrects so the WALK can drive a login flow even when the
// authored selector does not exist on the real DOM (e.g. the case says
// [name="email"] but the app uses #username). This ONLY steers exploration so
// the walk can reach the post-login screen; it never becomes generated test code
// (the test still uses selectors the LLM grounded against the real DOM).
async function fillWithFallback(page, selector, value, action, timeout) {
  try {
    const loc = page.locator(selector).first();
    if (await loc.count()) { await loc.fill(value, { timeout }); return true; }
  } catch (e) { /* fall through to the heuristic */ }
  const wantsPassword = /pass|pwd|clave|contra/i.test(String(selector) + ' ' + String(action));
  const candidateSel = wantsPassword
    ? 'input[type="password"]'
    : 'input[type="email"], input[type="text"], input[type="tel"], input:not([type])';
  try {
    const cands = page.locator(candidateSel);
    const n = await cands.count();
    for (let i = 0; i < n; i++) {
      const c = cands.nth(i);
      if (!(await c.isEditable().catch(() => false))) continue;
      const current = await c.inputValue().catch(() => '');
      if (!current) { await c.fill(value, { timeout }); return true; }
    }
    if (n) { await cands.first().fill(value, { timeout }); return true; }
  } catch (e) { /* tolerant */ }
  return false;
}

// Click a named button, falling back to the form's submit control so a login
// step still advances when the button label does not match exactly.
async function clickButtonWithFallback(page, name, timeout) {
  try {
    const byName = page.getByRole('button', { name }).first();
    if (await byName.count()) { await byName.click({ timeout }); return; }
  } catch (e) { /* fall through */ }
  try {
    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    if (await submit.count()) { await submit.click({ timeout }); }
  } catch (e) { /* tolerant */ }
}

async function advance(page, action, base, timeout) {
  const a = String(action || '').trim();
  let m;
  if ((m = a.match(/^fill text\s+["'](.+?)["']\s+inside\s+(.+?)\s+with\s+(.+)$/i))) {
    const label = m[1].trim();
    const container = dslToCss(m[2].trim());
    const val = stripQuotes(m[3].trim());
    await page.locator(container).getByLabel(label).first().fill(val, { timeout });
    return;
  }
  if ((m = a.match(/^fill\s+(.+?)\s+with\s+(.+)$/i)) || (m = a.match(/^fill\s+(.+)$/i))) {
    await fillWithFallback(page, dslToCss(m[1].trim()), m[2] ? stripQuotes(m[2].trim()) : '', a, timeout);
    return;
  }
  if ((m = a.match(/^click text\s+["'](.+?)["']\s+inside\s+(.+)$/i))) {
    const textVal = m[1].trim();
    const container = dslToCss(m[2].trim());
    await page.locator(container).getByText(textVal).first().click({ timeout });
    return;
  }
  if ((m = a.match(/^click text\s+["'](.+?)["']\s*$/i))) {
    const textVal = m[1].trim();
    await page.getByText(textVal).first().click({ timeout });
    return;
  }
  if ((m = a.match(/^click button\s+(.+)$/i))) {
    const t = m[1].trim();
    if (/^[#.[]/.test(t)) await page.click(dslToCss(t), { timeout });
    else await clickButtonWithFallback(page, stripQuotes(t), timeout);
    return;
  }
  if ((m = a.match(/^click\s+(.+)$/i))) {
    const t = m[1].trim();
    if (/^[#.[]/.test(t)) await page.click(dslToCss(t), { timeout });
    else await page.getByText(stripQuotes(t), { exact: false }).first().click({ timeout });
    return;
  }
  if ((m = a.match(/^go to\s+(.+)$/i))) {
    await page.goto(targetUrl(base, m[1].trim()), { waitUntil: 'domcontentloaded', timeout });
    return;
  }
  if (/^\//.test(a)) {
    await page.goto(targetUrl(base, a), { waitUntil: 'domcontentloaded', timeout });
    return;
  }
  if ((m = a.match(/^wait\s+(\d+)\s*seconds?/i))) {
    await page.waitForTimeout(Math.min(Number(m[1]), 3) * 1000);
    return;
  }
  // refresh page / set timeout / expect* -> nothing to advance
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const timeout = Number(payload.timeout_ms || 8000);
  const actionTimeout = Number(payload.action_timeout_ms || 5000);
  const maxControls = Number(payload.max_controls || 150);
  const browserName = payload.browser || 'chromium';
  const browserType = playwright[browserName] || playwright.chromium;

  const browser = await browserType.launch({ headless: true });
  const contextOptions = {};
  if (payload.storage_state_path && fs.existsSync(payload.storage_state_path)) {
    contextOptions.storageState = payload.storage_state_path;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const results = [];
  let success = false;
  let errorMsg = '';
  try {
    await page.goto(targetUrl(payload.base_url || '', payload.route || '/'), { waitUntil: 'domcontentloaded', timeout });
    try { await page.waitForLoadState('networkidle', { timeout: 2000 }); } catch { /* best effort */ }
    for (const step of payload.steps || []) {
      let snapshot = null;
      try { snapshot = await page.evaluate(DOM_SNAPSHOT_JS, maxControls); } catch { snapshot = null; }
      results.push({ number: step.number, snapshot });
      try {
        await advance(page, step.normalized_action || step.original_text || '', payload.base_url || '', actionTimeout);
        try { await page.waitForLoadState('domcontentloaded', { timeout: 3000 }); } catch { /* best effort */ }
      } catch { /* tolerant: keep walking even if a step can't be executed */ }
    }
    // Final snapshot AFTER the last step. A login flow's last action is usually
    // the submit, so the authenticated screen only exists once every step ran;
    // without this, a case whose last step is the login click never captures the
    // post-login DOM and grounding/codegen stay blind to it.
    try {
      try { await page.waitForLoadState('networkidle', { timeout: 2000 }); } catch { /* best effort */ }
      const finalSnapshot = await page.evaluate(DOM_SNAPSHOT_JS, maxControls);
      results.push({ number: 'final', snapshot: finalSnapshot });
    } catch { /* best effort */ }
    success = true;
  } catch (error) {
    errorMsg = String(error.message || error).slice(0, 500);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(outputPath, JSON.stringify({ success, error: errorMsg, steps: results }, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
`;

async function runWalkProbe({
  root,
  baseUrl,
  route,
  config,
  storageStatePath,
  steps
}: {
  root: string;
  baseUrl: string;
  route: string;
  config: ProGuide.Dict;
  storageStatePath: string;
  steps: ProGuide.Dict[];
}): Promise<{ success: boolean; error?: string; steps?: ProGuide.Dict[] }> {
  const proguideDir = path.join(root, PROGUIDE_DIR);
  await fs.mkdir(proguideDir, { recursive: true });

  const inputPath = path.join(proguideDir, 'walk_input.json');
  const outputPath = path.join(proguideDir, 'walk_output.json');
  const scriptPath = path.join(proguideDir, 'walk_probe.cjs');
  const logPath = path.join(proguideDir, 'walk.log');

  const payload = {
    base_url: baseUrl,
    route,
    browser: config.runner?.browser || 'chromium',
    timeout_ms: Number(config.grounding?.nav_timeout_ms) || 30000,
    action_timeout_ms: Number(config.grounding?.action_timeout_ms) || 5000,
    max_controls: 150,
    storage_state_path: storageStatePath,
    steps: (steps || []).map((s) => ({
      number: s.number,
      normalized_action: s.normalized_action,
      original_text: s.original_text
    }))
  };

  await writeJson(inputPath, payload);
  await fs.writeFile(scriptPath, WALK_PROBE_SCRIPT, 'utf8');
  await fs.writeFile(
    logPath,
    `$ ${process.execPath} ${scriptPath} ${inputPath} ${outputPath}\n`,
    'utf8'
  );

  try {
    const completed = await runProcess([process.execPath, scriptPath, inputPath, outputPath], {
      cwd: root,
      env: runtimeEnv(),
      logPath
    });
    if (completed.code !== 0 && !(await exists(outputPath))) {
      const logText = await fs.readFile(logPath, 'utf8').catch(() => '');
      return {
        success: false,
        error: firstUsefulLogLine(logText) || `walk probe exited with code ${completed.code}`
      };
    }
    const result = await readJson(outputPath, null);
    if (!result) return { success: false, error: 'walk probe sin salida' };
    return result;
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

function applyGrounding(step: ProGuide.Dict, grounding: ProGuide.Dict, route: string) {
  step.grounding = grounding;
  if (grounding.status === 'resolved') {
    if (
      !step.review_reason ||
      /no encontrado|ambiguo|no verificable|recorrer|inspeccionar/i.test(step.review_reason)
    ) {
      step.needs_review = false;
      step.review_reason = '';
    }
    return;
  }
  step.needs_review = true;
  if (grounding.status === 'ambiguous') {
    step.review_reason = 'Target de paso ambiguo. Coinciden varios elementos en la pantalla.';
  } else if (grounding.status === 'not_found') {
    step.review_reason = `Target de paso no encontrado en la pantalla del paso ${step.number} (ruta ${route}).`;
  } else {
    step.review_reason = `Target no verificable automaticamente (selector de clase/CSS, o pantalla no alcanzada en el walk).`;
  }
}

export async function groundCaseSteps({
  root,
  baseUrl,
  config,
  credentials = {},
  testCase
}: {
  root: string;
  baseUrl: string;
  config: ProGuide.Dict;
  credentials?: ProGuide.Dict;
  testCase: ProGuide.Dict;
}) {
  if (isApiPlanCase(testCase)) {
    return;
  }

  const steps: ProGuide.Dict[] = testCase.executable_steps || [];
  if (!steps.length) return;
  const route = testCase.route || '/';

  // Reuse an authenticated session for protected routes (same gate as the
  // pre-pass): only when auth.login_route is configured.
  let storageStatePath = '';
  if (config.auth?.login_route) {
    try {
      const session = await ensureSession({ root, baseUrl, config, credentials });
      if (session.available && session.storageStatePath) {
        storageStatePath = session.storageStatePath;
      }
    } catch {
      // fall through unauthenticated; the walk still drives the case's own login steps
    }
  }

  const walk = await runWalkProbe({ root, baseUrl, route, config, storageStatePath, steps });

  if (!walk.success) {
    const errorMsg = walk.error || 'No se pudo recorrer la ruta';
    const isTimeout = /timeout/i.test(errorMsg);
    const hint = isTimeout
      ? ' El pre-pass de grounding es no bloqueante: la ejecucion real puede continuar. Si el sitio es lento o usa SSO/red interna, subi grounding.nav_timeout_ms en proguide_tests/config.yaml.'
      : ' El pre-pass de grounding es no bloqueante: la ejecucion real puede continuar.';
    for (const step of steps) {
      if (parseStepTarget(step.normalized_action)) {
        step.grounding = { status: 'unverified', candidates: [] };
        step.needs_review = true;
        step.review_reason = `Error al recorrer la ruta ${route}: ${errorMsg}.${hint}`;
      }
    }
    return walk;
  }

  const snapshotByStep = new Map(
    (walk.steps || []).map((s: ProGuide.Dict) => [s.number, s.snapshot])
  );

  for (const step of steps) {
    const snapshot = snapshotByStep.get(step.number);
    if (!snapshot) {
      if (parseStepTarget(step.normalized_action)) {
        step.grounding = { status: 'unverified', candidates: [] };
        step.needs_review = true;
        step.review_reason = `No se pudo inspeccionar la pantalla del paso ${step.number}.`;
      }
      continue;
    }
    applyGrounding(step, groundStepAgainstSnapshot(step, snapshot), route);
  }

  return walk;
}

function mergeWalkSnapshots(walkSteps: any[], maxControls: number = 80) {
  const controls: any[] = [];
  const headingsSet = new Set<string>();
  const visibleTextSet = new Set<string>();
  const seenSelectors = new Set<string>();
  let finalUrl = '';
  let finalTitle = '';

  const validSteps = (walkSteps || []).filter((s) => s?.snapshot);

  for (let i = validSteps.length - 1; i >= 0; i--) {
    const snap = validSteps[i].snapshot;
    if (!snap) continue;

    if (!finalUrl && snap.url) finalUrl = snap.url;
    if (!finalTitle && snap.title) finalTitle = snap.title;

    if (Array.isArray(snap.headings)) {
      for (const h of snap.headings) {
        if (h) headingsSet.add(h);
      }
    }

    if (snap.visible_text) {
      visibleTextSet.add(snap.visible_text);
    }

    if (Array.isArray(snap.controls)) {
      for (const ctrl of snap.controls) {
        const key = ctrl.selector_hint || `${ctrl.tag}:${ctrl.text}`;
        if (key && !seenSelectors.has(key)) {
          seenSelectors.add(key);
          controls.push(ctrl);
        }
      }
    }
  }

  return {
    url: finalUrl || '',
    title: finalTitle || '',
    headings: Array.from(headingsSet),
    controls: controls.slice(0, maxControls),
    visible_text: Array.from(visibleTextSet).join('\n\n')
  };
}

export async function groundCases({
  root,
  baseUrl,
  config,
  credentials = {},
  cases,
  runDir
}: {
  root: string;
  baseUrl: string;
  config: ProGuide.Dict;
  credentials?: ProGuide.Dict;
  cases: ProGuide.Dict[];
  runDir?: string;
}) {
  if (!baseUrl) return;
  const byCaseId: ProGuide.Dict = {};

  for (const testCase of cases) {
    const walk = await groundCaseSteps({
      root,
      baseUrl,
      config,
      credentials,
      testCase
    });

    if (walk && Array.isArray(walk.steps) && walk.success) {
      const mergedSnap = mergeWalkSnapshots(walk.steps, Number(config.llm?.dom_context_max_controls || 80));
      byCaseId[testCase.id] = {
        available: true,
        route: testCase.route || '/',
        snapshot: mergedSnap
      };
    } else {
      byCaseId[testCase.id] = {
        available: false,
        route: testCase.route || '/',
        error: walk?.error || 'Pre-pass de grounding no produjo walk exitoso'
      };
    }
  }

  if (runDir) {
    const outputPath = path.join(runDir, 'dom_context.json');
    const output = {
      available: Object.values(byCaseId).some((item: any) => item.available),
      by_case_id: byCaseId
    };
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  }
}
