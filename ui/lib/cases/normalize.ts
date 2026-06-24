import { norm, stripAccents } from '../shared/text.js';
import { isPlainObject } from '../shared/object.js';
import { isSecretKey, allowsTestPasswordKey } from '../shared/secrets.js';
import { cleanList } from '../markdown/text.js';
import {
  normalizeApiStep,
  normalizeApiCaseStep,
  parseExpectedApiAssertion
} from './api-normalize.js';

// Step normalization, automation assessment, selector/route inference and case
// data merging. Pure transforms (no I/O). Extracted verbatim from
// proguide-service.js; the public functions below are imported back there.

const GENERIC_EXPECTED_RE = /\b(correcto|correctamente|funciona|ok|exitoso|exitosamente|segun corresponda|adecuado)\b/i;
const NOT_AUTOMATABLE_RE = /\b(captcha|2fa|otp|token fisico|sms|llamada|telefono|fuera del navegador|manual|base de datos|db|api externa|correo fisico|impresion)\b/i;
const REVIEW_STEP_RE = /\b(validar que corresponda|segun criterio|revisar visualmente|comprobar manualmente|buscar el expediente|ubicar el expediente|datos de ambiente|consultar con)\b/i;
const NAVIGATION_RE = /\b(ir|abrir|navegar|visitar|acceder|entrar|dirigirse|volver)\b/i;

type AutomationAssessment = [string, string, number];

export function buildSteps(originalSteps: string[], options: ProGuide.Dict = {}) {
  return originalSteps.map((step, index) => ({
    number: index + 1,
    original_text: step,
    normalized_action: options.type === 'api' ? normalizeApiCaseStep(step) : normalizeStep(step),
    status: 'pending',
    started_at: null,
    finished_at: null,
    duration_seconds: 0,
    observed_result: '',
    screenshot: null,
    error: null,
    confidence: stepConfidence(step, options),
    needs_review: REVIEW_STEP_RE.test(step),
    review_reason: REVIEW_STEP_RE.test(step) ? 'Paso ambiguo o dependiente de datos de ambiente.' : ''
  }));
}

export function normalizeStep(step: unknown): string {
  const normalized = norm(step);
  const explicit = explicitStep(step);
  if (explicit) return explicit;
  const apiStep = normalizeApiStep(step);
  if (apiStep) return apiStep;
  const isAssertion = /\b(expect|validar|verificar|comprobar|debe|mostrar|muestra|contiene|visible|aparece)\b/.test(normalized);
  const urlAssertion = normalizeUrlAssertion(step);
  if (urlAssertion) return urlAssertion;
  const route = extractRoute(step);
  const clickTarget = extractClickTarget(step);
  if (clickTarget) return `click button ${clickTarget}`;
  if (route) return `go to ${route}`;
  if (/\b(email|e-mail|correo|usuario|user)\b/.test(normalized) && /\b(completar|ingresar|escribir|cargar|enter)\b/.test(normalized)) {
    return /\b(invalido|invalid|malformado|incorrecto)\b/.test(normalized) ? 'enter invalid email' : 'enter valid email';
  }
  if (/\b(password|pass|clave|contrasena)\b/.test(normalized) && /\b(completar|ingresar|escribir|cargar|enter)\b/.test(normalized)) {
    return /\b(invalido|invalid|corta|corto|incorrecto)\b/.test(normalized) ? 'enter invalid password' : 'enter valid password';
  }
  if (isAssertion && /\bdashboard\b/.test(normalized)) return 'expect text "Dashboard"';
  if (!isAssertion && /\b(enviar|submit|login|iniciar sesion|continuar)\b/.test(normalized)) return 'submit form';
  if (NAVIGATION_RE.test(normalized)) return 'go to /';
  if (/\b(recargar|refresh)\b/.test(normalized)) return 'refresh page';
  return String(step || '');
}

export function assessAutomation(steps: string[], expected: string[], options: ProGuide.Dict = {}): AutomationAssessment {
  const joinedSteps = steps.join('\n');
  const joinedExpected = expected.join('\n');
  if (options.type === 'api') {
    if (Array.isArray(options.requests) && options.requests.length) {
      if (options.requests.some((entry) => !entry?.request?.method || !entry?.request?.path)) {
        return ['necesita_revision', 'Falta metodo o endpoint en al menos un request REST del flujo.', 0.55];
      }
      return ['listo', 'Caso REST multi-step listo para automatizar con Playwright request.', 0.92];
    }
    if (!options.request?.method || !options.request?.path) {
      return ['necesita_revision', 'Falta metodo o endpoint para ejecutar el caso REST.', 0.55];
    }
    if (!expected.length && options.request?.expected_status === null) {
      return ['necesita_revision', 'Falta resultado esperado verificable para la API REST.', 0.6];
    }
    return ['listo', 'Caso REST listo para automatizar con Playwright request.', 0.92];
  }
  if (!steps.length) return ['no_automatizable_aun', 'El caso no tiene pasos ejecutables.', 0.2];
  if (NOT_AUTOMATABLE_RE.test(joinedSteps)) return ['no_automatizable_aun', 'El caso requiere acciones fuera del navegador o controles no automatizables.', 0.35];
  if (!expected.length) return ['necesita_revision', 'Falta resultado esperado verificable.', 0.55];
  if (GENERIC_EXPECTED_RE.test(joinedExpected) && !hasConcreteExpected(expected)) return ['necesita_revision', 'El resultado esperado es generico; conviene hacerlo verificable.', 0.6];
  if (REVIEW_STEP_RE.test(joinedSteps)) return ['necesita_revision', 'Hay pasos ambiguos o dependientes de datos de ambiente.', 0.65];
  return ['listo', 'Caso listo para automatizar con el resolvedor actual.', 0.9];
}

function hasConcreteExpected(expected: string[]): boolean {
  return expected.some((item) => /\b(url|muestra|shows|visible|contains|contiene|mensaje|texto|dashboard|home|error|status|codigo|http|body|response|json|header)\b/i.test(item));
}

function stepConfidence(step: unknown, options: ProGuide.Dict = {}): number {
  if (options.type === 'api') {
    if (normalizeApiStep(step) || parseExpectedApiAssertion(step)) return 0.95;
    return 0.7;
  }
  if (explicitStep(step)) return 0.95;
  if (normalizeApiStep(step)) return 0.95;
  if (NOT_AUTOMATABLE_RE.test(String(step || ''))) return 0.2;
  if (REVIEW_STEP_RE.test(String(step || ''))) return 0.45;
  return normalizeStep(step) !== step ? 0.85 : 0.7;
}

export function explicitStep(step: unknown): string | null {
  const text = String(step || '').trim();
  const timing = normalizeTimingStep(text);
  if (timing) return timing;
  const urlAssertion = normalizeUrlAssertion(text);
  if (urlAssertion) return urlAssertion;
  const textExpectation = normalizeTextExpectation(text);
  if (textExpectation) return textExpectation;
  const contextualClick = normalizeContextualClick(text);
  if (contextualClick) return contextualClick;
  const listItemClick = normalizeListItemClick(text);
  if (listItemClick) return listItemClick;
  const cssSelectorAction = normalizeCssSelectorAction(text);
  if (cssSelectorAction) return cssSelectorAction;
  if (/^(?:fill|click|expect)\s+\[[^\]]+\]/i.test(text)) return text;
  const selector = extractExplicitSelector(text);
  if (!selector) return null;
  const normalized = norm(text);
  if (/\b(click|clic|hacer clic|presionar|seleccionar|tocar)\b/.test(normalized)) {
    return `click ${selector}`;
  }
  if (/\b(fill|completar|ingresar|escribir|cargar|setear|introducir)\b/.test(normalized)) {
    const value = valueAfterSelector(text, selector, /(?:\bcon\b|\bwith\b|\bvalor\b|\bvalue\b)\s+(.+)$/i);
    return value ? `fill ${selector} with ${value}` : `fill ${selector}`;
  }
  if (/\b(expect|validar|verificar|comprobar|debe|mostrar|muestra|contiene|visible)\b/.test(normalized)) {
    const value = valueAfterSelector(text, selector, /(?:\bmuestra\b|\bmostrar\b|\bcontiene\b|\btexto\b|\bvalor\b|\bshows?\b|\bcontains?\b)\s+(.+)$/i);
    return value ? `expect ${selector} to contain text ${JSON.stringify(value)}` : `expect ${selector} to be visible`;
  }
  return null;
}

function normalizeTimingStep(text: unknown): string | null {
  const waitMatch = String(text || '').match(/^\s*(?:wait|esperar)\s+(\d{1,5})\s*(?:seconds?|segundos?)\s*$/i);
  if (waitMatch) return `wait ${Number(waitMatch[1])} seconds`;

  const testTimeoutMatch = String(text || '').match(/^\s*(?:set|configurar|establecer)\s+test\s+timeout\s+(?:to\s+)?(\d{1,5})\s*(?:seconds?|segundos?)\s*$/i);
  if (testTimeoutMatch) return `set test timeout to ${Number(testTimeoutMatch[1])} seconds`;

  const assertionTimeoutMatch = String(text || '').match(/^\s*(?:set|configurar|establecer)\s+assert(?:ion)?\s+timeout\s+(?:to\s+)?(\d{1,5})\s*(?:seconds?|segundos?)\s*$/i);
  if (assertionTimeoutMatch) return `set assertion timeout to ${Number(assertionTimeoutMatch[1])} seconds`;

  return null;
}

function normalizeUrlAssertion(text: unknown): string | null {
  const source = String(text || '').trim();
  const patterns = [
    /^\s*(?:expect|validar|verificar|comprobar)\s+(?:current\s+|actual\s+)?(?:url|ruta)\s+(?:to\s+)?(?:contain|contains|contiene|contener)\s+(.+?)\s*$/i,
    /^\s*(?:expect|validar|verificar|comprobar)\s+(?:que\s+)?la\s+(?:url|ruta)\s+(?:actual\s+)?(?:contenga|contiene|contener)\s+(.+?)\s*$/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const value = stripWrappingQuotes(match[1].trim().replace(/[.;]+$/, ''));
    if (value) return `expect url to contain ${JSON.stringify(value)}`;
  }
  return null;
}

function normalizeTextExpectation(text: unknown): string | null {
  const match = String(text || '').match(/^\s*expect\s+text\s+["'](.+?)["'](?:\s+(?:to\s+be\s+)?visible)?\s*$/i);
  return match ? `expect text ${JSON.stringify(match[1].trim())}` : null;
}

function normalizeContextualClick(text: unknown): string | null {
  const match = String(text || '').match(/^\s*(?:click|clic|hacer\s+clic|presionar|seleccionar|tocar)\s+(.+?)\s+(?:inside|dentro\s+de|dentro)\s+(.+?)\s*$/i);
  if (!match) return null;
  const label = stripWrappingQuotes(match[1].trim().replace(/[.,;:]+$/, ''));
  const selector = cleanCssSelectorTarget(match[2]);
  if (!label || !selector || !isCssSelectorTarget(selector)) return null;
  return `click text ${JSON.stringify(label)} inside ${formatSelectorDsl(selector)}`;
}

function normalizeListItemClick(text: unknown): string | null {
  const match = String(text || '').match(/^\s*(?:click|clic|hacer\s+clic|presionar|seleccionar|tocar)\s+listitem\s+["'](.+?)["']\s*$/i);
  if (!match) return null;
  return `click [li:has-text(${JSON.stringify(match[1].trim())})]`;
}

function normalizeCssSelectorAction(text: unknown): string | null {
  const clickMatch = String(text || '').match(/^\s*(?:click|clic|hacer\s+clic|presionar|seleccionar|tocar)\s+(.+?)\s*$/i);
  if (clickMatch) {
    const selector = cleanCssSelectorTarget(clickMatch[1]);
    if (selector && isCssSelectorTarget(selector) && !isSimpleBracketSelector(selector)) {
      return `click ${formatSelectorDsl(selector)}`;
    }
  }

  const fillMatch = String(text || '').match(/^\s*(?:fill|completar|ingresar|escribir|cargar|setear|introducir)\s+(.+?)\s+(?:with|con|valor|value)\s+(.+?)\s*$/i);
  if (fillMatch) {
    const selector = cleanCssSelectorTarget(fillMatch[1]);
    if (selector && isCssSelectorTarget(selector) && !isSimpleBracketSelector(selector)) {
      return `fill ${formatSelectorDsl(selector)} with ${fillMatch[2].trim()}`;
    }
  }

  const visibleMatch = String(text || '').match(/^\s*(?:expect|validar|verificar|comprobar)\s+(.+?)\s+(?:to\s+be\s+)?visible\s*$/i);
  if (visibleMatch) {
    const selector = cleanCssSelectorTarget(visibleMatch[1]);
    if (selector && isCssSelectorTarget(selector) && !isSimpleBracketSelector(selector)) {
      return `expect ${formatSelectorDsl(selector)} to be visible`;
    }
  }

  return null;
}

function cleanCssSelectorTarget(value: unknown): string {
  return stripWrappingQuotes(String(value || '').trim().replace(/[.,;]+$/, ''));
}

function formatSelectorDsl(selector: string): string {
  if (isSimpleBracketSelector(selector)) return selector;
  return `[${selector}]`;
}

function isSimpleBracketSelector(selector: unknown): boolean {
  return /^\[[^\]]+\]$/.test(String(selector || '').trim());
}

function isCssSelectorTarget(selector: unknown): boolean {
  const value = String(selector || '').trim();
  if (!value) return false;
  if (/^(?:#|\.|:|\*)/.test(value)) return true;
  if (/^\[[^\]]+\](?:$|[\s.:#>[+~])/.test(value)) return true;
  return /^[A-Za-z][A-Za-z0-9_-]*(?:[#.:]|\[|::?[\w-]+|\s*[>+~]\s*)/.test(value);
}

function extractExplicitSelector(text: unknown): string | null {
  const bracketSelector = String(text || '').match(/\[[^\]]+\]/)?.[0];
  if (bracketSelector) return bracketSelector;
  const token = extractSelectorToken(text);
  return token ? `[data-testid="${escapeSelectorValue(token)}"]` : null;
}

function extractSelectorToken(text: unknown): string {
  const normalizedText = stripAccents(String(text || ''));
  const patterns = [
    /\b(?:campo|input|elemento|selector|boton|enlace|link|badge|contador|toggle|id|data-testid)\s+["']?([A-Za-z][A-Za-z0-9_-]{1,80})["']?/i,
    /["']([A-Za-z][A-Za-z0-9_-]{1,80})["']/i
  ];
  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (!match) continue;
    const token = match[1].trim().replace(/[.,;:]+$/, '');
    if (isSelectorLikeToken(token)) return token;
  }
  const fallback = normalizedText.match(/\b([A-Za-z][A-Za-z0-9_-]*(?:[-_][A-Za-z0-9]+)+)\b/);
  if (fallback && /\b(attribute|atributo)\b/i.test(normalizedText) && /^data-/i.test(fallback[1])) return '';
  return fallback && isSelectorLikeToken(fallback[1]) ? fallback[1] : '';
}

function isSelectorLikeToken(token: unknown): boolean {
  const value = String(token || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(value)) return false;
  if (/[-_]/.test(value)) return true;
  return /[a-z][A-Z]/.test(value);
}

function escapeSelectorValue(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function valueAfterSelector(text: unknown, selector: string, pattern: RegExp): string {
  const source = String(text || '');
  const selectorIndex = source.indexOf(selector);
  const afterSelector = selectorIndex >= 0 ? source.slice(selectorIndex + selector.length) : source;
  const match = afterSelector.match(pattern);
  if (!match) {
    const quoted = [...String(text || '').matchAll(/["']([^"']+)["']/g)]
      .map((item) => item[1].trim())
      .find((item) => item && item !== selector && !isSelectorLikeToken(item));
    return quoted || '';
  }
  return match[1].trim().replace(/^["']|["']$/g, '').replace(/[.;]+$/, '').trim();
}

function stripWrappingQuotes(value: unknown): string {
  const text = String(value || '').trim();
  if (text.length >= 2 && text[0] === text.at(-1) && ['"', "'"].includes(text[0])) {
    return text.slice(1, -1);
  }
  return text;
}

export function mergeCaseData(primary: unknown = {}, fallback: unknown = {}): ProGuide.Dict {
  const merged = { ...(isPlainObject(fallback) ? fallback : {}) };
  if (!isPlainObject(primary)) return merged;
  for (const [key, value] of Object.entries(primary)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeCaseData(value, merged[key]);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function dataFromLines(lines: unknown): ProGuide.Dict {
  const data: ProGuide.Dict = {};
  for (const line of cleanList(lines)) {
    const match = String(line).match(/^([^:]{2,60}):\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    const normalizedKey = norm(key);
    if (!value) continue;
    if (isSecretKey(normalizedKey)) {
      if (allowsTestPasswordKey(normalizedKey)) {
        data.user = { ...(data.user || {}), password: value };
      }
      continue;
    }
    if (/\b(email|e-mail|correo)\b/.test(normalizedKey) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      data.user = { ...(data.user || {}), email: value };
      continue;
    }
    if (/\b(usuario|user|username)\b/.test(normalizedKey)) {
      data.user = { ...(data.user || {}), username: value };
      continue;
    }
    const dataKey = normalizedKey.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (dataKey) data[dataKey] = value;
  }
  return data;
}

export function inferCaseRoute(
  explicitRoute: unknown,
  originalSteps: unknown[] = [],
  executableSteps: ProGuide.Dict[] = []
): string {
  const explicit = normalizeRouteValue(explicitRoute);
  if (explicit && explicit !== '/') return explicit;

  const candidates = [];
  for (const step of cleanList(originalSteps)) {
    candidates.push(extractRoute(step));
  }
  for (const step of executableSteps || []) {
    candidates.push(routeFromNormalizedAction(step?.normalized_action));
    candidates.push(extractRoute(step?.original_text || ''));
  }

  const inferred = candidates.map(normalizeRouteValue).find((route) => route && route !== '/');
  return inferred || explicit || '/';
}

function routeFromNormalizedAction(action: unknown): string | null {
  const match = String(action || '').trim().match(/^go to\s+(.+)$/i);
  return match ? match[1] : null;
}

function normalizeRouteValue(value: unknown): string {
  const text = String(value || '').trim().replace(/[.,;]+$/, '');
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
  return text.startsWith('/') ? text : `/${text}`;
}

function extractRoute(step: unknown): string | null {
  const text = String(step);
  if (normalizeUrlAssertion(text)) return null;
  const normalized = norm(text);
  const hasRouteContext = NAVIGATION_RE.test(normalized) ||
    (/\bingresar\b/.test(normalized) && /(https?:\/\/|\/[A-Za-z0-9_\-/?#=&.]+)/.test(text)) ||
    /\b(ruta|route|url)\b/.test(normalized) ||
    /^\s*(?:https?:\/\/|\/[A-Za-z0-9_\-/?#=&.]+)/.test(text);
  if (!hasRouteContext) return null;

  let match = text.match(/(https?:\/\/\S+|\/[A-Za-z0-9_\-/?#=&.]+)/);
  if (match) return match[1].replace(/[.,;]+$/, '');
  match = text.match(/\b(?:ruta|route|url)\s+([A-Za-z0-9_\-/?#=&.]+)/i);
  if (!match) return null;
  const value = match[1].trim().replace(/[.,;]+$/, '');
  return value.startsWith('/') ? value : `/${value}`;
}

function extractClickTarget(step: unknown): string | null {
  const patterns = [
    /(?:hacer\s+)?clic\s+(?:en\s+)?(?:el\s+boton\s+|boton\s+)?["']?([^"']+?)["']?$/i,
    /(?:click|press|presionar|seleccionar)\s+(?:button\s+|boton\s+)?["']?([^"']+?)["']?$/i
  ];
  for (const pattern of patterns) {
    const match = String(step).match(pattern);
    if (!match) continue;
    const target = match[1].trim().replace(/[.,;]+$/, '');
    if (target && !['formulario', 'boton', 'button'].includes(norm(target))) return target;
  }
  return null;
}
