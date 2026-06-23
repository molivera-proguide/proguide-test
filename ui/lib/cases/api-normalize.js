// @ts-check
import { norm, stripAccents, firstArrayValue } from '../shared/text.js';
import { isPlainObject } from '../shared/object.js';
import { safeId } from '../shared/id.js';
import { maskSecretsDeep } from '../shared/secrets.js';
import {
  normalizeKeyValueObject,
  normalizeRequestBody,
  parseLooseValue,
  stringifyInlineValue
} from '../shared/value-parse.js';
import { cleanList, stripListMarker, stripMarkdownEmphasis } from '../markdown/text.js';

// REST/API case normalization: request/requests, assertions, captures, and the
// supported-assertion validation. Pure transforms (no I/O). Extracted verbatim
// from proguide-service.js; the public functions below are imported back there.

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const API_CASE_TYPES = new Set(['api', 'rest', 'restful', 'http', 'api rest', 'api restful']);

export function inferCaseType({ type, request, requests = [], steps = [] } = {}) {
  const explicitType = norm(type).replace(/[_-]+/g, ' ');
  if (API_CASE_TYPES.has(explicitType)) return 'api';
  if (request?.method && request?.path) return 'api';
  if (Array.isArray(requests) && requests.some((item) => item?.request?.method && item?.request?.path)) return 'api';
  if (cleanList(steps).some((step) => normalizeApiStep(step))) return 'api';
  return 'ui';
}

export function normalizeApiStep(step) {
  const request = apiRequestFromStep(step);
  if (!request) return null;
  const body = request.body === undefined ? '' : ` body ${stringifyInlineValue(request.body)}`;
  return `api ${request.method} ${request.path}${body}`;
}

export function normalizeApiCaseStep(step) {
  const requestStep = normalizeApiStep(step);
  if (requestStep) return requestStep;
  const assertion = parseExpectedApiAssertion(step);
  if (assertion) return `api assert ${formatApiAssertion(assertion)}`;
  return String(step || '').trim();
}

function formatApiAssertion(assertion) {
  if (assertion.type === 'status') return `status ${assertion.expected}`;
  if (assertion.type === 'ok') return 'ok';
  if (assertion.type === 'header') return `header ${assertion.name} ${assertion.operator || 'equals'} ${assertion.expected}`;
  if (assertion.type === 'body_contains') return `body contains ${assertion.expected}`;
  if (assertion.type === 'body_path') return `body.${assertion.path || '<root>'} ${assertion.operator || 'equals'} ${assertion.expected ?? ''}`.trim();
  return JSON.stringify(assertion);
}

export function apiRequestFromStep(step) {
  const text = String(step || '').trim();
  const match = text.match(/^(?:(?:api|rest|http|request|llamar|invocar)\s+)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(.*)$/i);
  if (!match) return null;
  const method = normalizeHttpMethod(match[1]);
  const requestPath = normalizeApiPath(match[2]);
  if (!method || !requestPath) return null;
  const tail = String(match[3] || '').trim();
  return {
    method,
    path: requestPath,
    ...apiRequestDecorationsFromStepTail(tail)
  };
}

export function normalizeApiRequest(input = {}) {
  const stepRequest = cleanList(input.steps || [])
    .map(apiRequestFromStep)
    .find(Boolean) || {};
  const explicitType = API_CASE_TYPES.has(norm(input.type).replace(/[_-]+/g, ' '));
  const explicitPath = input.path || input.endpoint || input.request_path || input.url;
  const method = normalizeHttpMethod(
    input.method ||
    input.request_method ||
    input.http_method ||
    stepRequest.method ||
    ''
  );
  const requestPath = normalizeApiPath(
    explicitPath ||
    stepRequest.path ||
    (explicitType ? input.route : '') ||
    ''
  );
  const body = firstNormalizedBody(
    input.body,
    input.payload,
    input.request_body,
    stepRequest.body
  );
  const expectedStatus = normalizeExpectedStatus(
    input.expected_status ??
    input.status_code ??
    input.status ??
    stepRequest.expected_status ??
    parseExpectedStatus(cleanList(input.expected || []).join('\n'))
  );
  const request = {
    method: method || (requestPath && (explicitType || explicitPath || stepRequest.path) ? 'GET' : ''),
    path: requestPath,
    headers: firstNormalizedKeyValue(input.headers, input.request_headers, stepRequest.headers),
    query: firstNormalizedKeyValue(input.query, input.params, input.request_query, stepRequest.query),
    expected_status: expectedStatus
  };
  if (body !== undefined) request.body = body;
  return request;
}

export function normalizeApiRequestsFromSteps(steps, { expected = [] } = {}) {
  const entries = cleanList(steps)
    .map((step, index) => apiRequestEntryFromStep(step, index))
    .filter(Boolean);
  if (!entries.length) return [];

  const expectedLines = cleanList(expected);
  const expectedStatus = parseExpectedStatus(expectedLines.join('\n'));
  const last = entries.at(-1);
  if (last && expectedLines.length) last.expected_results = expectedLines;
  if (last && expectedStatus !== null && last.expected_status === undefined) {
    last.expected_status = expectedStatus;
  }
  return normalizeApiRequests(entries);
}

export function normalizeApiRequests(value) {
  return firstArrayValue(value)
    .map((entry, index) => normalizeApiRequestEntry(entry, index))
    .filter((entry) => entry.request.method && entry.request.path);
}

export function buildApiExecutableSteps({ request, requests = [], assertions = [], captures = [] } = {}) {
  const entries = requests.length
    ? requests
    : (request?.method && request?.path ? [{
      id: 'request_1',
      request,
      assertions,
      captures
    }] : []);
  return entries.map((entry, index) => ({
    number: index + 1,
    original_text: `${entry.request.method} ${entry.request.path}`,
    normalized_action: `api ${entry.request.method} ${entry.request.path}`,
    status: 'pending',
    started_at: null,
    finished_at: null,
    duration_seconds: 0,
    observed_result: '',
    screenshot: null,
    error: null,
    confidence: 1,
    needs_review: false,
    review_reason: '',
    request: {
      method: entry.request.method,
      path: entry.request.path,
      headers: describeApiPayload(entry.request.headers),
      query: describeApiPayload(entry.request.query),
      body: describeApiPayload(entry.request.body)
    },
    assertions: (entry.assertions || []).map(formatApiAssertion),
    captures: (entry.captures || []).map((capture) => capture.name)
  }));
}

function normalizeApiRequestEntry(entry, index) {
  const source = isPlainObject(entry) ? entry : {};
  const nestedRequest = isPlainObject(source.request) ? source.request : {};
  const request = normalizeApiRequest({
    ...nestedRequest,
    type: 'api',
    route: source.route ?? nestedRequest.route,
    method: source.method ?? source.request_method ?? source.http_method ?? nestedRequest.method,
    path: source.path ?? source.endpoint ?? source.request_path ?? source.url ?? nestedRequest.path ?? nestedRequest.endpoint,
    headers: source.headers ?? source.request_headers ?? nestedRequest.headers,
    query: source.query ?? source.params ?? source.request_query ?? nestedRequest.query ?? nestedRequest.params,
    body: source.body ?? source.payload ?? source.request_body ?? nestedRequest.body ?? nestedRequest.payload,
    expected_status: source.expected_status ?? source.status_code ?? source.status ?? nestedRequest.expected_status
  });
  const id = safeId(source.id || source.name || `request_${index + 1}`);
  const assertions = normalizeApiAssertions({
    assertions: source.assertions || source.api_assertions || [],
    expected: source.expected_results || source.expected || [],
    expectedStatus: request.expected_status
  });
  rejectUnsupportedApiAssertions(assertions, id);
  return {
    id,
    title: String(source.title || source.description || `${request.method || 'REQUEST'} ${request.path || ''}`).trim(),
    request,
    assertions,
    captures: normalizeApiCaptures(source.captures ?? source.save ?? source.extract ?? source.exports ?? nestedRequest.captures),
    debug: Boolean(source.debug ?? nestedRequest.debug)
  };
}

function apiRequestEntryFromStep(step, index) {
  const request = apiRequestFromStep(step);
  if (!request) return null;
  const entry = {
    id: `request_${index + 1}`,
    title: `${request.method} ${request.path}`,
    method: request.method,
    path: request.path,
    headers: request.headers,
    query: request.query,
    expected_status: request.expected_status,
    captures: request.captures
  };
  if (request.body !== undefined) entry.body = request.body;
  return entry;
}

function apiRequestDecorationsFromStepTail(tail) {
  const text = String(tail || '').trim();
  const cleanTail = stripCaptureClauses(text);
  const body = parseInlineBody(cleanTail);
  const headers = parseInlineKeyValueSegment(cleanTail, /(?:headers?|cabeceras?)/i);
  const query = parseInlineKeyValueSegment(cleanTail, /(?:query|params?|parametros?)/i);
  const expectedStatus = parseExpectedStatus(cleanTail);
  const captures = parseInlineCaptures(text);
  const decorations = {
    headers,
    query,
    expected_status: expectedStatus
  };
  if (body !== undefined) decorations.body = body;
  if (captures.length) decorations.captures = captures;
  return decorations;
}

function parseInlineBody(tail) {
  const text = String(tail || '');
  const match = text.match(/\b(?:con\s+)?(?:body|payload|cuerpo)\b\s*(?::|=)?\s*/i);
  if (!match) return undefined;
  const rest = text.slice((match.index || 0) + match[0].length).trim();
  const bodyText = readInlineValue(rest);
  return bodyText ? parseLooseValue(bodyText) : undefined;
}

function parseInlineKeyValueSegment(tail, keywordPattern) {
  const text = String(tail || '');
  const pattern = new RegExp(`\\b(?:con\\s+)?${keywordPattern.source}\\b\\s*(?::|=)?\\s*(.+)$`, 'i');
  const match = text.match(pattern);
  if (!match) return {};
  const value = readInlineValue(match[1]);
  if (!value) return {};
  const parsed = parseLooseValue(value);
  if (isPlainObject(parsed)) return normalizeKeyValueObject(parsed, { preserveSecrets: true });
  const normalized = normalizeKeyValueObject(value, { preserveSecrets: true });
  if (Object.keys(normalized).length) return normalized;
  const pair = value.match(/^([A-Za-z0-9_-]+)\s+(.+)$/);
  return pair ? { [pair[1]]: parseLooseValue(pair[2]) } : {};
}

function parseInlineCaptures(tail) {
  const captures = [];
  const text = String(tail || '');
  const pattern = /(?:capturar|capture|save|guardar|extraer|extract)\s+(?:campo|field|valor|value)?\s*`?([A-Za-z_][A-Za-z0-9_]*)`?(?:\s+(?:como|as)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?)?/ig;
  for (const match of text.matchAll(pattern)) {
    const path = match[1];
    const name = match[2] || path;
    captures.push({ name, path });
  }
  return normalizeApiCaptures(captures);
}

function stripCaptureClauses(value) {
  return String(value || '')
    .replace(/\s*(?:[\u2013\u2014-]\s*)?(?:capturar|capture|save|guardar|extraer|extract)\s+(?:campo|field|valor|value)?\s*`?[A-Za-z_][A-Za-z0-9_]*`?(?:\s+(?:como|as)\s+`?[A-Za-z_][A-Za-z0-9_]*`?)?/ig, '')
    .trim();
}

function readInlineValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const balanced = readBalancedJsonLike(text);
  if (balanced) return balanced;
  return text
    .split(/\s+\b(?:con\s+)?(?:headers?|cabeceras?|query|params?|parametros?|body|payload|cuerpo|status|estado|codigo)\b/i)[0]
    .replace(/[.;]+$/, '')
    .trim();
}

function readBalancedJsonLike(value) {
  const text = String(value || '').trim();
  const opener = text[0];
  const closer = opener === '{' ? '}' : (opener === '[' ? ']' : '');
  if (!closer) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return '';
}

function firstNormalizedBody(...values) {
  for (const value of values) {
    const normalized = normalizeRequestBody(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstNormalizedKeyValue(...values) {
  for (const value of values) {
    const normalized = normalizeKeyValueObject(value, { preserveSecrets: true });
    if (Object.keys(normalized).length) return normalized;
  }
  return {};
}

export function normalizeApiCaptures(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeApiCaptureEntry(entry)).filter(Boolean);
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([name, entry]) => normalizeApiCaptureEntry(entry, name))
      .filter(Boolean);
  }
  return cleanList(value).map(parseApiCaptureLine).filter(Boolean);
}

function normalizeApiCaptureEntry(entry, fallbackName = '') {
  if (typeof entry === 'string') {
    const path = normalizeCapturePath(entry);
    return path !== null ? normalizeApiCaptureObject({ name: fallbackName, path }) : null;
  }
  if (!isPlainObject(entry)) return null;
  return normalizeApiCaptureObject({
    name: entry.name || entry.variable || entry.as || fallbackName,
    path: entry.path || entry.body_path || entry.json_path || entry.field,
    header: entry.header || entry.header_name
  });
}

function normalizeApiCaptureObject(entry) {
  const name = normalizeCaptureName(entry.name);
  const header = String(entry.header || '').trim().toLowerCase();
  const path = normalizeCapturePath(entry.path);
  if (!name || (!header && path === null)) return null;
  return header
    ? { name, source: 'header', header }
    : { name, source: 'body', path };
}

function parseApiCaptureLine(line) {
  const text = String(line || '').trim();
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:|<-|from)\s*(.+)$/i);
  if (!match) return null;
  const target = match[2].trim();
  const headerMatch = target.match(/^headers?\.?([A-Za-z0-9_-]+)$/i) || target.match(/^header\s+([A-Za-z0-9_-]+)$/i);
  return normalizeApiCaptureObject({
    name: match[1],
    header: headerMatch ? headerMatch[1] : '',
    path: headerMatch ? null : target
  });
}

function normalizeCaptureName(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : '';
}

function normalizeCapturePath(value) {
  if (value === undefined || value === null) return null;
  return String(value)
    .trim()
    .replace(/^(?:body|response|json)\./i, '')
    .replace(/^<root>$/i, '');
}

function describeApiPayload(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return keys.length ? `{ ${keys.join(', ')} }` : '{}';
  }
  return typeof value;
}

function normalizeHttpMethod(value) {
  const method = String(value || '').trim().toUpperCase();
  return HTTP_METHODS.has(method) ? method : '';
}

function normalizeApiPath(value) {
  const text = String(value || '').trim().replace(/[.,;]+$/, '');
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return text.startsWith('/') ? text : `/${text}`;
}

export function normalizeApiAssertions({ assertions = [], expected = [], expectedStatus = null } = {}) {
  const normalized = [];
  const status = normalizeExpectedStatus(expectedStatus) ?? parseExpectedStatus(cleanList(expected).join('\n'));
  if (status !== null) normalized.push({ type: 'status', expected: status });
  for (const assertion of assertions || []) {
    const parsed = normalizeApiAssertion(assertion);
    if (parsed) normalized.push(parsed);
  }
  for (const line of cleanList(expected)) {
    const parsed = parseExpectedApiAssertion(line);
    if (parsed && !(parsed.type === 'status' && normalized.some((item) => item.type === 'status'))) {
      normalized.push(parsed);
    }
  }
  const unique = uniqueApiAssertions(normalized);
  if (!unique.length) unique.push({ type: 'ok' });
  return unique;
}

export function rejectUnsupportedApiAssertions(assertions, context = '') {
  const unsupported = (assertions || []).find((assertion) => assertion?.type === 'unsupported');
  if (!unsupported) return;
  const suffix = context ? ` en ${context}` : '';
  throw new Error(`Asercion API no soportada${suffix}: ${unsupported.reason || 'unsupported_assertion'}. Usa status, ok, header, body_contains o body_path con equals/exists/contains/isArray. Usa path "" o "$" para el body raiz.`);
}

function normalizeApiAssertion(assertion) {
  if (!assertion) return unsupportedApiAssertion(assertion, 'empty_assertion');
  if (typeof assertion === 'string') return parseExpectedApiAssertion(assertion) || unsupportedApiAssertion(assertion, 'unsupported_text_assertion');
  if (!isPlainObject(assertion)) return unsupportedApiAssertion(assertion, 'unsupported_assertion_value');
  if (assertion.type === 'status') {
    const expected = normalizeExpectedStatus(assertion.expected ?? assertion.status ?? assertion.status_code);
    return expected === null ? unsupportedApiAssertion(assertion, 'invalid_status_assertion') : { type: 'status', expected };
  }
  if (assertion.type === 'unsupported') {
    return {
      type: 'unsupported',
      reason: String(assertion.reason || 'unsupported_assertion'),
      raw: assertion.raw ?? maskSecretsDeep(assertion)
    };
  }
  if (assertion.type === 'ok') return { type: 'ok' };
  if (assertion.type === 'header') {
    return {
      type: 'header',
      name: String(assertion.name || assertion.header || '').toLowerCase(),
      operator: assertion.operator === 'contains' ? 'contains' : 'equals',
      expected: parseLooseValue(assertion.expected ?? assertion.value ?? '')
    };
  }
  if (assertion.type === 'body_contains') {
    return {
      type: 'body_contains',
      expected: parseLooseValue(assertion.expected ?? assertion.value ?? '')
    };
  }
  if (assertion.type === 'body_path') {
    const operator = ['exists', 'contains', 'is_array'].includes(assertion.operator) ? assertion.operator : 'equals';
    const normalized = {
      type: 'body_path',
      path: normalizeApiBodyPath(firstDefined(assertion.path, assertion.field, assertion.json_path, '')),
      operator
    };
    if (operator !== 'exists') normalized.expected = parseLooseValue(assertion.expected ?? assertion.value ?? assertion.equals ?? assertion.contains);
    if (operator === 'is_array') delete normalized.expected;
    return normalized.path || operator === 'is_array' ? normalized : unsupportedApiAssertion(assertion, 'missing_body_path');
  }
  const status = normalizeExpectedStatus(assertion.status ?? assertion.status_code ?? assertion.expected_status);
  if (status !== null) return { type: 'status', expected: status };
  const header = assertion.header || assertion.header_name;
  if (header) {
    return {
      type: 'header',
      name: String(header).toLowerCase(),
      operator: assertion.contains !== undefined ? 'contains' : 'equals',
      expected: parseLooseValue(assertion.contains ?? assertion.equals ?? assertion.expected ?? assertion.value ?? '')
    };
  }
  const pathValue = firstDefined(assertion.path, assertion.json_path, assertion.field, assertion.body_path);
  if (pathValue !== undefined && pathValue !== null) {
    const bodyPath = normalizeApiBodyPath(pathValue);
    if (assertion.exists === true) {
      return { type: 'body_path', path: bodyPath, operator: 'exists' };
    }
    if (assertion.isArray === true || assertion.is_array === true || assertion.array === true) {
      return { type: 'body_path', path: bodyPath, operator: 'is_array' };
    }
    if (assertion.contains !== undefined) {
      return {
        type: 'body_path',
        path: bodyPath,
        operator: 'contains',
        expected: parseLooseValue(assertion.contains)
      };
    }
    if (assertion.equals === undefined && assertion.expected === undefined && assertion.value === undefined) {
      return unsupportedApiAssertion(assertion, 'missing_body_path_expected_value');
    }
    return {
      type: 'body_path',
      path: bodyPath,
      operator: 'equals',
      expected: parseLooseValue(assertion.equals ?? assertion.expected ?? assertion.value)
    };
  }
  if (assertion.body_contains !== undefined || assertion.contains !== undefined) {
    return {
      type: 'body_contains',
      expected: parseLooseValue(assertion.body_contains ?? assertion.contains)
    };
  }
  return unsupportedApiAssertion(assertion, 'unsupported_assertion_object');
}

function uniqueApiAssertions(assertions) {
  const unique = [];
  const seen = new Set();
  for (const assertion of assertions || []) {
    const key = JSON.stringify(assertion);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(assertion);
  }
  return unique;
}

function normalizeApiBodyPath(value) {
  const text = String(value ?? '').trim();
  return text === '$' ? '' : text.replace(/^\$\./, '').replace(/^\$/, '');
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function unsupportedApiAssertion(assertion, reason) {
  return {
    type: 'unsupported',
    reason,
    raw: maskSecretsDeep(assertion)
  };
}

export function parseExpectedApiAssertion(line) {
  const text = stripMarkdownEmphasis(stripListMarker(String(line || '').trim()));
  if (!text) return null;
  const status = parseExpectedStatus(text);
  if (status !== null) return { type: 'status', expected: status };

  const ascii = stripAccents(text).replace(/^(?:expect|validar|verificar|comprobar)\s+/i, '').trim();
  let match = ascii.match(/^(?:body|response|json)\.([A-Za-z0-9_$.[\]-]+)\s*(?:=|==|equals?|es|sea)\s*(.+)$/i);
  if (match) {
    return {
      type: 'body_path',
      path: match[1],
      operator: 'equals',
      expected: parseLooseValue(match[2])
    };
  }
  match = ascii.match(/^(?:response\s+)?body\s+field\s+([A-Za-z0-9_$.[\]-]+)\s+(?:exists?|existe|presente)$/i);
  if (match) {
    return {
      type: 'body_path',
      path: match[1],
      operator: 'exists'
    };
  }
  match = ascii.match(/^(?:response\s+)?body\s+field\s+([A-Za-z0-9_$.[\]-]+)\s*(?:=|==|equals?|es|sea)\s*(.+)$/i);
  if (match) {
    return {
      type: 'body_path',
      path: match[1],
      operator: 'equals',
      expected: parseLooseValue(match[2])
    };
  }
  match = ascii.match(/^(?:body|response|json)\.([A-Za-z0-9_$.[\]-]+)\s+(?:exists?|existe|presente)$/i);
  if (match) {
    return {
      type: 'body_path',
      path: match[1],
      operator: 'exists'
    };
  }
  match = ascii.match(/^(?:body|response|json)\.([A-Za-z0-9_$.[\]-]+)\s+(?:contains?|contiene)\s+(.+)$/i);
  if (match) {
    return {
      type: 'body_path',
      path: match[1],
      operator: 'contains',
      expected: parseLooseValue(match[2])
    };
  }
  match = ascii.match(/^headers?\s+([A-Za-z0-9_-]+)\s+(?:contains?|contiene)\s+(.+)$/i);
  if (match) {
    return {
      type: 'header',
      name: match[1].toLowerCase(),
      operator: 'contains',
      expected: parseLooseValue(match[2])
    };
  }
  match = ascii.match(/^headers?\s+([A-Za-z0-9_-]+)\s*(?:=|==|equals?|es)\s*(.+)$/i);
  if (match) {
    return {
      type: 'header',
      name: match[1].toLowerCase(),
      operator: 'equals',
      expected: parseLooseValue(match[2])
    };
  }
  match = ascii.match(/^(?:body|response|json)\s+(?:contains?|contiene)\s+(.+)$/i);
  if (match) {
    return {
      type: 'body_contains',
      expected: parseLooseValue(match[1])
    };
  }
  match = ascii.match(/^(?:body|response|json)\s+(?:is\s+)?(?:an\s+)?array$/i);
  if (match) {
    return {
      type: 'body_path',
      path: '',
      operator: 'is_array'
    };
  }
  return null;
}

function parseExpectedStatus(value) {
  const text = String(value || '');
  const normalized = norm(text);
  if (!/\b(status|estado|codigo|http)\b/.test(normalized) && !/^\s*[1-5][0-9]{2}\s*$/.test(text)) {
    return null;
  }
  const match = text.match(/\b([1-5][0-9]{2})\b/);
  return match ? normalizeExpectedStatus(match[1]) : null;
}

function normalizeExpectedStatus(value) {
  const number = Number(String(value ?? '').match(/[1-5][0-9]{2}/)?.[0] ?? NaN);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}
