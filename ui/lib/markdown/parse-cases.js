// @ts-check
import { norm, normalizePriority, splitTags, joinText, noneIfEmpty } from '../shared/text.js';
import { safeId } from '../shared/id.js';
import { maskSecretText, maskSecretLines } from '../shared/secrets.js';
import { stripListMarker, stripMarkdownEmphasis, cleanList } from './text.js';
import {
  inferCaseType,
  normalizeApiStep,
  normalizeApiRequest,
  normalizeApiRequestsFromSteps,
  normalizeApiAssertions
} from '../cases/api-normalize.js';
import {
  buildSteps,
  assessAutomation,
  dataFromLines,
  inferCaseRoute
} from '../cases/normalize.js';

// Markdown → structured cases parser: split a Markdown document into case blocks
// and parse each into a normalized case object. Pure (no I/O). Extracted verbatim
// from proguide-service.js; only parseMarkdownCases is consumed there.

const FIELD_ALIASES = {
  titulo: 'title',
  title: 'title',
  descripcion: 'description',
  description: 'description',
  prioridad: 'priority',
  priority: 'priority',
  criticidad: 'priority',
  criticality: 'priority',
  severidad: 'priority',
  severity: 'priority',
  precondicion: 'preconditions',
  precondiciones: 'preconditions',
  precondition: 'preconditions',
  preconditions: 'preconditions',
  datos: 'data_used',
  'datos utilizados': 'data_used',
  data: 'data_used',
  'test data': 'data_used',
  pasos: 'original_steps',
  acciones: 'original_steps',
  steps: 'original_steps',
  'resultado esperado': 'expected_results',
  'resultados esperados': 'expected_results',
  esperado: 'expected_results',
  esperados: 'expected_results',
  expected: 'expected_results',
  'expected result': 'expected_results',
  'expected results': 'expected_results',
  tags: 'tags',
  etiquetas: 'tags',
  qa: 'qa_owner',
  responsable: 'qa_owner',
  resp: 'qa_owner',
  'qa responsable': 'qa_owner',
  desarrollo: 'dev_owner',
  desa: 'dev_owner',
  dev: 'dev_owner',
  ticket: 'ticket',
  requerimiento: 'ticket',
  tipo: 'test_type',
  type: 'test_type',
  kind: 'test_type',
  clase: 'test_type',
  metodo: 'request_method',
  method: 'request_method',
  verbo: 'request_method',
  endpoint: 'request_path',
  path: 'request_path',
  url_api: 'request_path',
  'api url': 'request_path',
  header: 'request_headers',
  headers: 'request_headers',
  cabecera: 'request_headers',
  cabeceras: 'request_headers',
  query: 'request_query',
  params: 'request_query',
  parametros: 'request_query',
  body: 'request_body',
  payload: 'request_body',
  cuerpo: 'request_body',
  'request body': 'request_body',
  status: 'expected_status',
  'status esperado': 'expected_status',
  'estado http': 'expected_status',
  'codigo http': 'expected_status',
  'codigo de estado': 'expected_status',
  ruta: 'route',
  route: 'route',
  url: 'route'
};

export function parseMarkdownCases(markdown, { sourceName = 'source.md' } = {}) {
  const blocks = splitCaseBlocks(markdown);
  const cases = [];
  blocks.forEach((block, index) => {
    const testCase = parseBlock(block, index + 1);
    if (testCase) cases.push(testCase);
  });
  if (!cases.length && markdown.trim()) {
    const fallback = parseBlock({ heading: sourceName, lines: markdown.split(/\r?\n/) }, 1);
    if (fallback) cases.push(fallback);
  }
  return cases;
}

function splitCaseBlocks(markdown) {
  const blocks = [];
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading && isCaseHeading(heading[1], heading[2])) {
      if (current) blocks.push(current);
      current = { heading: cleanHeading(heading[2]), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  if (blocks.length) return blocks;

  const fallbackBlocks = [];
  current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (heading && !isFieldLabel(norm(heading[2]))) {
      if (current) fallbackBlocks.push(current);
      current = { heading: cleanHeading(heading[2]), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) fallbackBlocks.push(current);
  const contentBlocks = fallbackBlocks.filter(hasCaseContent);
  return contentBlocks.length ? contentBlocks : [{ heading: 'Caso 1', lines: markdown.split(/\r?\n/) }];
}

function isCaseHeading(prefix, text) {
  const normalized = norm(text);
  if (/^(?:caso|case|test|tc)(?:\s|#|:|\.|-|_|\d|$)/.test(normalized)) return true;
  if (/\btc[\s._-]*\d+\b/.test(normalized)) return true;
  return false;
}

function hasCaseContent(block) {
  let currentField = null;
  let hasSteps = false;
  let hasExpected = false;
  for (const rawLine of block.lines || []) {
    const line = rawLine.trim();
    if (!line || isSeparatorLine(line)) continue;
    if (line.startsWith('#')) {
      currentField = fieldFromHeading(line) || currentField;
      if (currentField === 'original_steps') hasSteps = true;
      if (currentField === 'expected_results') hasExpected = true;
      continue;
    }
    const stripped = stripListMarker(stripMarkdownEmphasis(line));
    const [label] = extractLabel(stripped);
    if (label) {
      currentField = label;
      if (label === 'original_steps') hasSteps = true;
      if (label === 'expected_results') hasExpected = true;
      continue;
    }
    if (currentField === 'original_steps' || looksLikeStep(line)) hasSteps = true;
    if (currentField === 'expected_results') hasExpected = true;
  }
  return hasSteps && hasExpected;
}

function parseBlock(block, number) {
  const fields = {
    title: titleFromHeading(block.heading, number),
    description: '',
    priority: 'media',
    preconditions: [],
    data_used: [],
    data: {},
    original_steps: [],
    expected_results: [],
    tags: [],
    route: '/',
    test_type: '',
    request_method: '',
    request_path: '',
    request_headers: [],
    request_query: [],
    request_body: [],
    expected_status: ''
  };
  let currentField = null;
  const originalLines = [`## ${block.heading}`, ...block.lines];
  for (const rawLine of block.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isSeparatorLine(line)) continue;
    if (line.startsWith('#')) {
      const label = fieldFromHeading(line);
      if (label) currentField = label;
      continue;
    }
    const stripped = stripListMarker(stripMarkdownEmphasis(line));
    const [label, value] = extractLabel(stripped);
    if (label) {
      currentField = label;
      if (value) appendField(fields, label, value);
      continue;
    }
    if (currentField) {
      appendField(fields, currentField, stripped);
    } else if (looksLikeStep(stripped)) {
      fields.original_steps.push(stripped);
    } else if (stripped) {
      fields.description = joinText(fields.description, stripped);
    }
  }

  fields.priority = normalizePriority(fields.priority || 'media');
  fields.tags = splitTags(fields.tags);
  fields.preconditions = cleanList(fields.preconditions);
  fields.data_used = cleanList(fields.data_used);
  fields.data = dataFromLines(fields.data_used);
  fields.original_steps = cleanList(fields.original_steps);
  fields.expected_results = cleanList(fields.expected_results);
  fields.route = inferCaseRoute(fields.route, fields.original_steps);
  const request = normalizeApiRequest({
    type: fields.test_type,
    route: fields.route,
    method: fields.request_method,
    path: fields.request_path,
    headers: fields.request_headers,
    query: fields.request_query,
    body: fields.request_body,
    expected_status: fields.expected_status,
    steps: fields.original_steps,
    expected: fields.expected_results
  });
  const requests = normalizeApiRequestsFromSteps(fields.original_steps, {
    expected: fields.expected_results
  });
  const type = inferCaseType(/** @type {ProGuide.CaseInput} */ ({
    type: fields.test_type,
    request,
    requests,
    steps: fields.original_steps,
    expected: fields.expected_results
  }));
  const effectiveRequest = requests[0]?.request || request;
  const executableSteps = buildSteps(fields.original_steps, { type });
  const assertions = type === 'api'
    ? (requests.length
        ? uniqueApiCaseAssertions(requests.flatMap((entry) => entry.assertions || []))
        : normalizeApiAssertions({
            expected: fields.expected_results,
            expectedStatus: effectiveRequest.expected_status
          }))
    : [];

  const title = String(fields.title || `Caso ${number}`).trim();
  const [automationState, stateReason, confidence] = assessAutomation(fields.original_steps, fields.expected_results, {
    type,
    request: effectiveRequest,
    requests,
    assertions
  });
  return {
    id: safeId(`caso_${number}_${title}`),
    number,
    type,
    title,
    description: String(fields.description || '').trim(),
    priority: fields.priority,
    tags: fields.tags,
    preconditions: fields.preconditions,
    data_used: maskSecretLines(fields.data_used),
    data: fields.data,
    request: type === 'api' ? effectiveRequest : null,
    requests: type === 'api' ? requests : [],
    assertions,
    original_steps: fields.original_steps,
    executable_steps: executableSteps,
    expected_results: fields.expected_results,
    confidence,
    automation_state: automationState,
    state_reason: stateReason,
    original_markdown: maskSecretText(originalLines.join('\n').trim()),
    route: fields.route,
    qa_owner: noneIfEmpty(fields.qa_owner),
    dev_owner: noneIfEmpty(fields.dev_owner),
    ticket: noneIfEmpty(fields.ticket),
    excluded: false,
    parallelizable: true,
    result_obtained: '',
    status: 'pending',
    started_at: null,
    finished_at: null,
    duration_seconds: 0,
    artifacts: []
  };
}

function uniqueApiCaseAssertions(assertions) {
  const seen = new Set();
  const unique = [];
  for (const assertion of assertions || []) {
    const key = JSON.stringify(assertion);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(assertion);
  }
  return unique;
}

function extractLabel(line) {
  const match = line.match(/^([^:]{2,40}):\s*(.*)$/);
  if (!match) return [null, ''];
  const field = FIELD_ALIASES[norm(match[1])];
  return field ? [field, match[2].trim()] : [null, ''];
}

function fieldFromHeading(line) {
  const label = line.replace(/^#+\s*/, '').trim();
  return FIELD_ALIASES[norm(label)] || null;
}

function appendField(fields, label, value) {
  const cleanValue = stripListMarker(value).trim();
  if (!cleanValue) return;
  if (['preconditions', 'data_used', 'original_steps', 'expected_results', 'tags', 'request_headers', 'request_query', 'request_body'].includes(label)) {
    fields[label] = fields[label] || [];
    fields[label].push(cleanValue);
  } else if (['qa_owner', 'dev_owner', 'ticket', 'route', 'priority', 'title', 'test_type', 'request_method', 'request_path', 'expected_status'].includes(label)) {
    fields[label] = cleanValue;
  } else if (label === 'description') {
    fields[label] = joinText(String(fields[label] || ''), cleanValue);
  }
}

function looksLikeStep(line) {
  return /^(?:\d+[).\s-]+|paso\s+\d+[:.\s-]+)/i.test(norm(line)) || Boolean(normalizeApiStep(line));
}

function isSeparatorLine(line) {
  return /^[-*_]{3,}$/.test(String(line || '').trim());
}

function titleFromHeading(heading, number) {
  const title = stripListMarker(String(heading).replace(/^\s*(?:caso|case|test|tc)(?:\s|#|:|\.|-|_)*\d*[\s:.\-_]*/i, '').trim());
  return title || `Caso ${number}`;
}

function cleanHeading(heading) {
  return stripListMarker(String(heading).trim().replace(/^#+|#+$/g, '').trim());
}

function isFieldLabel(text) {
  return Boolean(FIELD_ALIASES[text]);
}
