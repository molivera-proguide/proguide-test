import { safeId } from '../shared/id.js';

// Pure parsing of the Playwright JSON report: flatten specs, match each to a
// plan case, and normalize status/message/error/steps/attachments. No I/O.
// Extracted verbatim from proguide-service.js; the three exports below are
// consumed by parsePlaywrightResults, which keeps the surrounding I/O.

export function collectPlaywrightSpecs(report: ProGuide.Dict) {
  const specs = [];
  const visitSuite = (suite) => {
    for (const spec of suite?.specs || []) specs.push(spec);
    for (const child of suite?.suites || []) visitSuite(child);
  };
  for (const suite of report?.suites || []) visitSuite(suite);
  return specs;
}

export function caseFromPlaywrightSpec(
  spec: ProGuide.Dict,
  caseById: Map<string, ProGuide.Dict>,
  caseBySafeId: Map<string, ProGuide.Dict>
) {
  const candidates = [
    caseIdFromTitle(spec?.title),
    caseIdFromAnnotations(spec),
    caseIdFromTitle(spec?.tests?.[0]?.title)
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (caseById.has(candidate)) return caseById.get(candidate);
    const safe = safeId(candidate);
    if (caseBySafeId.has(safe)) return caseBySafeId.get(safe);
  }
  return null;
}

function caseIdFromTitle(title: unknown) {
  const text = String(title || '').trim();
  const bracket = text.match(/^\[([^\]]+)]/);
  if (bracket) return bracket[1].trim();
  const prefix = text.match(/^([A-Za-z0-9_.-]+)\s*[:|-]/);
  return prefix ? prefix[1].trim() : '';
}

function caseIdFromAnnotations(spec: ProGuide.Dict) {
  const annotations = [
    ...(spec?.annotations || []),
    ...((spec?.tests || []).flatMap((test) => test.annotations || []))
  ];
  const annotation = annotations.find((item) => item?.type === 'proguide_case' || item?.type === 'case_id');
  return annotation?.description || '';
}

export function normalizePlaywrightSpecResult(spec: ProGuide.Dict) {
  const test = spec?.tests?.[0] || {};
  const results = Array.isArray(test.results) ? test.results : [];
  const result = results.at(-1) || {};
  const status = playwrightStatus(result.status || test.outcome || spec.ok);
  const message = playwrightMessage(result);
  const rawErrorDetails = playwrightErrorDetails(result, { stripDebugMarker: false });
  const errorDetails = stripApiDebugMarker(rawErrorDetails).trim();
  const actualResponse = playwrightActualResponse(message, rawErrorDetails);
  const steps = flattenPlaywrightSteps(result.steps || []);
  const attachments = results.flatMap((item) => item.attachments || []);
  const duration = results.reduce((total, item) => total + Number(item.duration || 0), 0);
  return {
    status,
    duration_seconds: Math.round((duration / 1000) * 1000) / 1000,
    message,
    error_details: errorDetails,
    actual_response: actualResponse,
    steps,
    attachments
  };
}

function playwrightStatus(status: unknown) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'passed' || normalized === 'expected' || normalized === 'true') return 'passed';
  if (['failed', 'timedout', 'timedout', 'interrupted', 'unexpected'].includes(normalized)) return 'failed';
  if (normalized === 'skipped') return 'inconclusive';
  return normalized ? 'failed' : 'inconclusive';
}

function playwrightMessage(result: ProGuide.Dict) {
  const errors = [
    ...(result?.errors || []),
    result?.error
  ].filter(Boolean);
  const first = errors[0];
  if (!first) return '';
  return shortPlaywrightMessage(first.message || first.value || first.stack || first);
}

function playwrightErrorDetails(
  result: ProGuide.Dict,
  options: { stripDebugMarker?: boolean } = {}
) {
  const chunks = [];
  const errors = [
    ...(result?.errors || []),
    result?.error
  ].filter(Boolean);
  for (const error of errors) {
    const formatted = formatPlaywrightError(error);
    if (formatted) chunks.push(formatted);
  }
  const stdout = outputEntriesText(result?.stdout);
  if (stdout) chunks.push(`stdout:\n${stdout}`);
  const stderr = outputEntriesText(result?.stderr);
  if (stderr) chunks.push(`stderr:\n${stderr}`);
  const text = uniqueTextChunks(chunks).join('\n\n').trim();
  return options.stripDebugMarker === false ? text : stripApiDebugMarker(text).trim();
}

function playwrightActualResponse(...values: unknown[]) {
  const text = values.map((value) => String(value || '')).join('\n');
  const base64Match = text.match(/PROGUIDE_API_DEBUG_BASE64 ([A-Za-z0-9+/=]+)/);
  if (base64Match) {
    try {
      const payload = JSON.parse(Buffer.from(base64Match[1], 'base64').toString('utf8'));
      return payload.actual_response || null;
    } catch {
      return null;
    }
  }
  const match = text.match(/PROGUIDE_API_DEBUG (\{[^\n]+\})/);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    return payload.actual_response || null;
  } catch {
    return null;
  }
}

function shortPlaywrightMessage(value: unknown) {
  return String(value || '').split('\n\nProGuide API debug:')[0].trim();
}

function stripApiDebugMarker(value: unknown) {
  return String(value || '')
    .replace(/\n?PROGUIDE_API_DEBUG_BASE64 [A-Za-z0-9+/=]+/g, '')
    .replace(/\n?PROGUIDE_API_DEBUG \{[^\n]+\}/g, '');
}

function formatPlaywrightError(error: any) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  const message = String(error.message || error.value || '').trim();
  const stack = String(error.stack || '').trim();
  const location = error.location
    ? `${error.location.file || ''}${error.location.line ? `:${error.location.line}` : ''}${error.location.column ? `:${error.location.column}` : ''}`.trim()
    : '';
  const chunks = [];
  if (stack && message && stack.includes(message)) {
    chunks.push(stack);
  } else {
    if (message) chunks.push(message);
    if (stack) chunks.push(stack);
  }
  if (location && !chunks.some((chunk) => chunk.includes(location))) chunks.push(`at ${location}`);
  if (!chunks.length) chunks.push(JSON.stringify(error, null, 2));
  return uniqueTextChunks(chunks).join('\n').trim();
}

function outputEntriesText(entries: any[]) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry?.text) return String(entry.text);
      if (entry?.buffer) {
        try {
          return Buffer.from(entry.buffer, 'base64').toString('utf8');
        } catch {
          return String(entry.buffer);
        }
      }
      return entry ? JSON.stringify(entry) : '';
    })
    .join('')
    .trim();
}

function uniqueTextChunks(chunks: unknown[]) {
  const seen = new Set();
  const unique = [];
  for (const chunk of chunks.map((item) => String(item || '').trim()).filter(Boolean)) {
    if (seen.has(chunk)) continue;
    seen.add(chunk);
    unique.push(chunk);
  }
  return unique;
}

function flattenPlaywrightSteps(steps: any[], prefix = '') {
  const lines = [];
  for (const step of steps || []) {
    const title = String(step.title || '').trim();
    const label = prefix && title ? `${prefix} > ${title}` : (title || prefix);
    if (label) lines.push(label);
    lines.push(...flattenPlaywrightSteps(step.steps || [], label));
  }
  return [...new Set(lines)];
}
