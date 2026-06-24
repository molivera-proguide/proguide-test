// @ts-check
import { escapeHtml } from '../lib/shared/html.js';
import { cleanCaseTitle } from '../lib/shared/text.js';

const DEFAULT_ASSERTION_TIMEOUT_MS = 30000;

// Code views for the case detail page: syntax highlighting and the TypeScript
// Playwright snippet builder shown in the "generated code" tabs. Pure string
// rendering (escapeHtml + cleanCaseTitle). Extracted verbatim from server.js.

export function highlightCode(code, language) {
  return String(code || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(
      (line) => `<span class="code-line">${highlightCodeLine(line, language) || '&nbsp;'}</span>`
    )
    .join('');
}

function highlightCodeLine(line, language) {
  const tokens = [];
  const keywordSet = codeKeywords(language);
  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    if (language === 'typescript' && rest.startsWith('//')) {
      tokens.push(token('comment', rest));
      break;
    }
    if (language === 'typescript' && rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      const comment = end >= 0 ? rest.slice(0, end + 2) : rest;
      tokens.push(token('comment', comment));
      index += comment.length;
      continue;
    }

    const quote = line[index];
    if (quote === '"' || quote === "'" || (language === 'typescript' && quote === '`')) {
      const value = readQuoted(line, index, quote);
      tokens.push(token('string', value));
      index += value.length;
      continue;
    }

    const numberMatch = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (numberMatch) {
      tokens.push(token('number', numberMatch[0]));
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (identifierMatch) {
      const value = identifierMatch[0];
      if (keywordSet.has(value)) {
        tokens.push(token('keyword', value));
      } else if (rest.slice(value.length).trimStart().startsWith('(')) {
        tokens.push(token('function', value));
      } else {
        tokens.push(escapeHtml(value));
      }
      index += value.length;
      continue;
    }

    const punctuationMatch = rest.match(/^[{}()[\].,;:+\-*/%=<>!|&?]+/);
    if (punctuationMatch) {
      tokens.push(token('punctuation', punctuationMatch[0]));
      index += punctuationMatch[0].length;
      continue;
    }

    tokens.push(escapeHtml(line[index]));
    index += 1;
  }
  return tokens.join('');
}

function readQuoted(line, start, quote) {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      index += 1;
      break;
    }
    index += 1;
  }
  return line.slice(start, index);
}

function token(kind, value) {
  return `<span class="tok-${kind}">${escapeHtml(value)}</span>`;
}

function codeKeywords(_language) {
  return new Set([
    'as',
    'async',
    'await',
    'break',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'else',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'of',
    'return',
    'throw',
    'true',
    'try',
    'type',
    'undefined',
    'var',
    'while'
  ]);
}

export function buildTypeScriptCode(testCase, run) {
  const steps = (testCase.executable_steps || [])
    .map((step) => step.normalized_action || step.original_text)
    .filter(Boolean);
  const expected = (testCase.expected_results || []).filter(Boolean);
  const route = testCase.route || '/';
  const baseUrl = run.base_url || 'http://localhost:3000';
  const user = testCase.data?.user || {};
  const assertionTimeoutMs = assertionTimeoutForSteps(steps);
  const lines = [
    "import { test, expect } from './proguide-test-runtime.mjs';",
    '',
    `test(${jsString(`[${testCase.id}] ${cleanCaseTitle(testCase.title) || testCase.id || 'ProGuide case'}`)}, async ({ page }) => {`,
    `  const baseUrl = process.env.PROGUIDE_BASE_URL ?? ${jsString(baseUrl)};`,
    '  const user = {',
    `    email: process.env.PROGUIDE_USER_EMAIL ?? ${jsString(user.email || 'test@example.com')},`,
    `    username: process.env.PROGUIDE_USER_USERNAME ?? ${jsString(user.username || user.email || 'test@example.com')},`,
    "    password: process.env.PROGUIDE_USER_PASSWORD ?? 'password123',",
    '  };',
    ''
  ];

  let hasNavigation = false;
  const setupBlocks = [];
  const actionBlocks = [];
  for (const step of steps) {
    const rendered = renderTypeScriptAction(step, route, assertionTimeoutMs);
    hasNavigation ||= rendered.navigates;
    if (/^\s*set\s+(?:test|assertion)\s+timeout\s+to\s+\d{1,5}\s+seconds?\s*$/i.test(step)) {
      setupBlocks.push(...rendered.lines);
    } else {
      actionBlocks.push(...rendered.lines);
    }
  }
  lines.push(...setupBlocks);
  if (!hasNavigation && route) {
    lines.push(`  await goto(page, baseUrl, ${jsString(route)});`, '');
  }
  lines.push(...actionBlocks);
  for (const item of expected) {
    lines.push(...renderTypeScriptExpectation(item, assertionTimeoutMs));
  }
  if (!steps.length && !expected.length) {
    lines.push(
      `  await expect(page.locator("body")).toBeVisible({ timeout: ${assertionTimeoutMs} });`
    );
  }
  lines.push('});', '', ...typeScriptHelperLines());
  return lines.join('\n') + '\n';
}

function assertionTimeoutForSteps(steps) {
  const timeouts = [DEFAULT_ASSERTION_TIMEOUT_MS];
  for (const step of steps || []) {
    const match = String(step || '').match(
      /^\s*set\s+(?:test|assertion)\s+timeout\s+to\s+(\d{1,5})\s+seconds?\s*$/i
    );
    if (!match) continue;
    const ms = Number(match[1]) * 1000;
    if (Number.isFinite(ms) && ms > 0) timeouts.push(ms);
  }
  return Math.max(...timeouts);
}

function renderTypeScriptAction(
  step,
  caseRoute,
  assertionTimeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS
) {
  const text = String(step || '').trim();
  const normalized = text.toLowerCase();
  const lines = [`  // ${tsComment(text)}`];

  const testTimeoutMatch = text.match(/^\s*set\s+test\s+timeout\s+to\s+(\d{1,5})\s+seconds?\s*$/i);
  if (testTimeoutMatch) {
    lines.push(`  test.setTimeout(${Number(testTimeoutMatch[1]) * 1000});`, '');
    return { lines, navigates: false };
  }

  const assertionTimeoutMatch = text.match(
    /^\s*set\s+assertion\s+timeout\s+to\s+(\d{1,5})\s+seconds?\s*$/i
  );
  if (assertionTimeoutMatch) {
    lines.push(
      `  // Assertion timeout for this case: ${Number(assertionTimeoutMatch[1]) * 1000}ms`,
      ''
    );
    return { lines, navigates: false };
  }

  const waitMatch = text.match(/^\s*wait\s+(\d{1,5})\s+seconds?\s*$/i);
  if (waitMatch) {
    lines.push(`  await page.waitForTimeout(${Number(waitMatch[1]) * 1000});`, '');
    return { lines, navigates: false };
  }

  const urlExpectation = renderUrlContainExpectation(text, '  ', assertionTimeoutMs);
  if (urlExpectation.length) {
    lines.push(...urlExpectation, '');
    return { lines, navigates: false };
  }

  const contextualClickMatch = text.match(/^\s*click\s+text\s+["'](.+?)["']\s+inside\s+(.+?)\s*$/i);
  if (contextualClickMatch) {
    lines.push(
      `  await page.locator(${jsString(selectorFromDslTarget(contextualClickMatch[2]))}).getByText(new RegExp(escapeRegExp(${jsString(contextualClickMatch[1].trim())}), 'i')).first().click({ timeout: ${assertionTimeoutMs} });`
    );
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  const fillMatch = text.match(/^\s*fill\s+(.+?)\s+with\s+(.+?)\s*$/i);
  if (fillMatch) {
    lines.push(
      `  await page.locator(${jsString(selectorFromDslTarget(fillMatch[1]))}).first().fill(${jsString(stripQuotes(fillMatch[2].trim()))}, { timeout: 5000 });`,
      ''
    );
    return { lines, navigates: false };
  }

  const clickMatch = text.match(/^\s*click\s+(.+?)\s*$/i);
  if (clickMatch) {
    if (isDslSelectorTarget(clickMatch[1])) {
      const selector = selectorFromDslTarget(clickMatch[1]);
      lines.push(`  await page.locator(${jsString(selector)}).first().click({ timeout: 5000 });`);
      lines.push("  await page.waitForLoadState('domcontentloaded');", '');
      return { lines, navigates: false };
    }
  }

  const textExpectation = renderExplicitTextExpectation(text, '  ', assertionTimeoutMs);
  if (textExpectation.length) {
    lines.push(...textExpectation, '');
    return { lines, navigates: false };
  }

  const route = routeFromStep(text);
  if (route || /\b(go to|open|navigate|visitar|abrir|navegar)\b/i.test(text)) {
    const targetRoute = route && route !== '/' ? route : caseRoute || '/';
    lines.push(`  await goto(page, baseUrl, ${jsString(targetRoute)});`, '');
    return { lines, navigates: true };
  }

  if (normalized.includes('refresh') || normalized.includes('recargar')) {
    lines.push('  await page.reload();');
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  if (
    (normalized.includes('empty') || normalized.includes('vacio')) &&
    /email|correo/.test(normalized)
  ) {
    lines.push("  await fillEmail(page, '');", '');
    return { lines, navigates: false };
  }

  if (/email|e-mail|correo|username|usuario|user/.test(normalized)) {
    const value = /invalid|invalido|malformado|incorrecto/.test(normalized)
      ? "'invalid-email'"
      : 'user.email';
    lines.push(`  await fillEmail(page, ${value});`, '');
    return { lines, navigates: false };
  }

  if (/password|pass|clave|contrasena|contrase/.test(normalized)) {
    const value = /invalid|invalido|corta|corto|incorrecto/.test(normalized)
      ? "'123'"
      : 'user.password';
    lines.push(`  await fillPassword(page, ${value});`, '');
    return { lines, navigates: false };
  }

  const clickTarget = clickTargetFromStep(text);
  if (clickTarget) {
    lines.push(`  await clickByText(page, ${jsString(clickTarget)});`);
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  if (/submit|login|ingresar|enviar|continuar|iniciar sesion/.test(normalized)) {
    lines.push('  await clickSubmit(page);');
    lines.push("  await page.waitForLoadState('domcontentloaded');", '');
    return { lines, navigates: false };
  }

  lines.push('  // TODO: ajustar este paso con selectores reales si hace falta.', '');
  return { lines, navigates: false };
}

function renderTypeScriptExpectation(expected, assertionTimeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS) {
  const text = String(expected || '').trim();
  const normalized = text.toLowerCase();
  const lines = [`  // assert: ${tsComment(text)}`];
  const explicit = renderExplicitTextExpectation(text, '  ', assertionTimeoutMs);
  if (explicit.length) return [...lines, ...explicit, ''];

  const notShowsMatch = text.match(
    /(?:page\s+does\s+not\s+show|does\s+not\s+show|not\s+visible|pagina\s+no\s+muestra|no\s+se\s+muestra)\s+(.+)/i
  );
  if (notShowsMatch) {
    lines.push(
      `  await expect(page.getByText(new RegExp(escapeRegExp(${jsString(notShowsMatch[1].trim())}), 'i'))).toHaveCount(0, { timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  const containsMatch = normalized.match(
    /(?:url\s+contains|url\s+contiene|la\s+url\s+contiene)\s+(\S+)/
  );
  if (containsMatch) {
    lines.push(
      `  await expect(page).toHaveURL(new RegExp(${jsString(`.*${escapeRegex(containsMatch[1].trim())}.*`)}, 'i'), { timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  const showsMatch = text.match(
    /(?:page\s+shows|shows|pagina\s+muestra|la\s+pagina\s+muestra|se\s+muestra|muestra|visible)\s+(.+)/i
  );
  if (showsMatch && showsMatch[1].trim().length > 1) {
    lines.push(
      `  await expect(textLocator(page, ${jsString(showsMatch[1].trim())})).toBeVisible({ timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  const storageExistsMatch = text.match(/localStorage\s+key\s+["'](.+?)["']\s+exists/i);
  if (storageExistsMatch) {
    lines.push(
      `  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), ${jsString(storageExistsMatch[1].trim())})).not.toBeNull();`,
      ''
    );
    return lines;
  }

  const storageMissingMatch = text.match(
    /localStorage\s+key\s+["'](.+?)["']\s+does\s+not\s+exist/i
  );
  if (storageMissingMatch) {
    lines.push(
      `  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), ${jsString(storageMissingMatch[1].trim())})).toBeNull();`,
      ''
    );
    return lines;
  }

  if (normalized.includes('session email displayed correctly')) {
    lines.push(
      `  await expect(textLocator(page, user.email)).toBeVisible({ timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  if (normalized.includes('login form is visible') || normalized.includes('login screen')) {
    lines.push(
      `  await expect(page.locator("input").first()).toBeVisible({ timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  if (/redirect|home|dashboard|inicio/.test(normalized)) {
    lines.push(
      `  await expect(page).toHaveURL(/.*(home|dashboard|app|inicio).*/i, { timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  if (/error|validation|invalid|invalido|incorrecto/.test(normalized)) {
    lines.push(
      `  await expect(page.getByText(/error|required|invalid|incorrect|obligatorio|invalido|incorrecto|ingresa|email|contrasena/i).first()).toBeVisible({ timeout: ${assertionTimeoutMs} });`,
      ''
    );
    return lines;
  }

  lines.push(
    `  await expect(page.locator("body")).toBeVisible({ timeout: ${assertionTimeoutMs} });`,
    ''
  );
  return lines;
}

function renderExplicitTextExpectation(
  text,
  indent,
  assertionTimeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS
) {
  const textMatch = text.match(/^\s*expect\s+text\s+["'](.+?)["']\s*$/i);
  if (textMatch) {
    return [
      `${indent}await expect(textLocator(page, ${jsString(textMatch[1].trim())})).toBeVisible({ timeout: ${assertionTimeoutMs} });`
    ];
  }
  const urlExpectation = renderUrlContainExpectation(text, indent, assertionTimeoutMs);
  if (urlExpectation.length) return urlExpectation;
  const visibleMatch = text.match(/^\s*expect\s+(.+?)\s+(?:to\s+be\s+)?visible\s*$/i);
  if (visibleMatch) {
    return [
      `${indent}await expect(page.locator(${jsString(selectorFromDslTarget(visibleMatch[1]))}).first()).toBeVisible({ timeout: ${assertionTimeoutMs} });`
    ];
  }
  const containsMatch = text.match(/^\s*expect\s+(.+?)\s+to\s+contain\s+text\s+["'](.+?)["']\s*$/i);
  if (containsMatch) {
    return [
      `${indent}await expect(page.locator(${jsString(selectorFromDslTarget(containsMatch[1]))}).first()).toContainText(${jsString(containsMatch[2].trim())}, { timeout: ${assertionTimeoutMs} });`
    ];
  }
  return [];
}

function renderUrlContainExpectation(
  text,
  indent,
  assertionTimeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS
) {
  const match = String(text || '').match(/^\s*expect\s+url\s+to\s+contain\s+["']?(.+?)["']?\s*$/i);
  if (!match) return [];
  const fragment = stripQuotes(match[1].trim().replace(/[.;]+$/, ''));
  return [
    `${indent}await expect(page).toHaveURL(new RegExp(${jsString(`.*${escapeRegex(fragment)}.*`)}, 'i'), { timeout: ${assertionTimeoutMs} });`
  ];
}

function typeScriptHelperLines() {
  return [
    'async function goto(page: Page, baseUrl: string, route: string) {',
    "  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;",
    "  const normalizedRoute = route.startsWith('/') ? route.slice(1) : route;",
    '  await page.goto(new URL(normalizedRoute, base).toString());',
    "  await page.waitForLoadState('domcontentloaded');",
    '}',
    '',
    'async function fillEmail(page: Page, value: string) {',
    '  await fillFirst([',
    '    page.getByLabel(/email|e-mail|correo|usuario|user/i),',
    '    page.getByPlaceholder(/email|e-mail|correo|usuario|user/i),',
    '    page.locator("input[type=\'email\']"),',
    '    page.locator("input[name*=\'email\' i]"),',
    '    page.locator("input[name*=\'user\' i]"),',
    '    page.locator("input[autocomplete=\'username\']"),',
    '    page.locator("input").first(),',
    '  ], value);',
    '}',
    '',
    'async function fillPassword(page: Page, value: string) {',
    '  await fillFirst([',
    '    page.getByLabel(/password|pass|clave|contrasena/i),',
    '    page.getByPlaceholder(/password|pass|clave|contrasena/i),',
    '    page.locator("input[type=\'password\']"),',
    '    page.locator("input[name*=\'password\' i]"),',
    '    page.locator("input[autocomplete=\'current-password\']"),',
    '  ], value);',
    '}',
    '',
    'async function clickSubmit(page: Page) {',
    '  await clickFirst([',
    '    page.getByRole("button", { name: /submit|login|log in|sign in|ingresar|iniciar|entrar|acceder|continuar|enviar/i }),',
    '    page.locator("button[type=\'submit\']"),',
    '    page.locator("input[type=\'submit\']"),',
    '    page.locator("button").first(),',
    '  ]);',
    '}',
    '',
    'async function clickByText(page: Page, label: string) {',
    '  await clickFirst([',
    "    page.getByRole('button', { name: new RegExp(escapeRegExp(label), 'i') }),",
    "    page.getByText(new RegExp(escapeRegExp(label), 'i')),",
    '  ]);',
    '}',
    '',
    'async function fillFirst(locators: Locator[], value: string) {',
    '  for (const locator of locators) {',
    '    if (await hasVisible(locator)) {',
    '      await locator.first().fill(value, { timeout: 5000 });',
    '      return;',
    '    }',
    '  }',
    "  throw new Error('Could not find a visible input to fill.');",
    '}',
    '',
    'async function clickFirst(locators: Locator[]) {',
    '  for (const locator of locators) {',
    '    if (await hasVisible(locator)) {',
    '      await locator.first().click({ timeout: 5000 });',
    '      return;',
    '    }',
    '  }',
    "  throw new Error('Could not find a visible target to click.');",
    '}',
    '',
    'async function hasVisible(locator: Locator) {',
    '  try {',
    '    return await locator.first().isVisible({ timeout: 1000 });',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    'function textLocator(page: Page, value: string) {',
    "  return page.getByText(new RegExp(escapeRegExp(value), 'i')).first();",
    '}',
    '',
    'function escapeRegExp(value: string) {',
    "  return value.split('').map((char) => '\\\\^$.*+?()[]{}|'.includes(char) ? `\\\\${char}` : char).join('');",
    '}'
  ];
}

function routeFromStep(step) {
  const match = String(step || '').match(
    /(?:go to|open|navigate to|visitar|abrir|navegar(?:\s+a)?|ir\s+a)\s+(\S+)/i
  );
  if (!match) return '';
  const value = stripQuotes(match[1].trim().replace(/[.,;:]+$/, ''));
  if (['login', 'home', 'homepage', 'page', 'pagina'].includes(value.toLowerCase())) return '';
  return value;
}

function clickTargetFromStep(step) {
  const match = String(step || '')
    .trim()
    .match(/^click\s+(?:button\s+)?["']?([^"']+?)["']?$/i);
  if (!match) return '';
  const target = match[1].trim();
  if (!target || ['submit', 'form', 'button'].includes(target.toLowerCase())) return '';
  return target;
}

function selectorFromBracket(value) {
  const selector = String(value || '').trim();
  if (!selector) return '';
  if (
    /^(#|\.|\[|:|\*)/.test(selector) ||
    /\s|>|\+|~/.test(selector) ||
    /:[A-Za-z-]+(?:\(|$)/.test(selector)
  )
    return selector;
  if (/^[a-z][a-z0-9_-]*\[[^\]]+\]$/i.test(selector)) return selector;
  if (
    [
      'a',
      'button',
      'form',
      'input',
      'select',
      'textarea',
      'div',
      'span',
      'label',
      'main',
      'section'
    ].includes(selector.toLowerCase())
  ) {
    return selector;
  }

  const attrMatch = selector.match(/^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(.+)$/);
  if (attrMatch) {
    return `[${attrMatch[1]}="${cssAttrValue(stripQuotes(attrMatch[2].trim()))}"]`;
  }

  return `[data-testid="${cssAttrValue(selector)}"]`;
}

function selectorFromDslTarget(value) {
  const target = String(value || '').trim();
  if (target.startsWith('[[') && target.endsWith(']')) {
    return selectorFromBracket(target.slice(1, -1));
  }
  if (/^\[[^\]]+\]$/.test(target)) {
    return selectorFromBracket(target.slice(1, -1));
  }
  return selectorFromBracket(target);
}

function isDslSelectorTarget(value) {
  const target = String(value || '').trim();
  return (
    target.startsWith('[') || /^(#|\.|:|\*)/.test(target) || /^[a-z][a-z0-9_-]*:/i.test(target)
  );
}

function stripQuotes(value) {
  const text = String(value || '');
  if (text.length >= 2 && text[0] === text.at(-1) && ['"', "'"].includes(text[0])) {
    return text.slice(1, -1);
  }
  return text;
}

function cssAttrValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function tsComment(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\*\//g, '* /')
    .trim();
}

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
