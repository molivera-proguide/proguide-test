import {
  normalizePriority,
  normalizeAutomationState,
  splitTags,
  firstArrayValue,
  noneIfEmpty
} from '../shared/text.js';
import { safeId } from '../shared/id.js';
import { maskSecretLines, sanitizeCaseData } from '../shared/secrets.js';
import { cleanList } from '../markdown/text.js';
import { parseMarkdownCases } from '../markdown/parse-cases.js';
import {
  inferCaseType,
  normalizeApiCaseStep,
  normalizeApiRequest,
  normalizeApiRequests,
  buildApiExecutableSteps,
  normalizeApiCaptures,
  normalizeApiAssertions,
  rejectUnsupportedApiAssertions
} from './api-normalize.js';
import {
  buildSteps,
  normalizeStep,
  assessAutomation,
  explicitStep,
  mergeCaseData,
  inferCaseRoute
} from './normalize.js';
import { loadUiConfig } from '../run-store/config.js';
import { callJsonModel } from '../llm/anthropic.js';

// Case storage normalization: turn agent/structured input into the canonical
// stored case shape, drive the Markdown-interpretation LLM agent, and compute
// normalization warnings. Extracted verbatim from run-store/runs.js; the three
// exports below are imported back there.

const MARKDOWN_AGENT_PROMPT = `You are a senior QA analyst converting Markdown test cases into structured cases.
Return only valid JSON. No markdown.

Rules:
- Do not execute tests.
- Do not invent credentials, environment data, or business records.
- Preserve the original wording in original_markdown/original_steps.
- Use Spanish UI state values:
  - automation_state: listo, necesita_revision, no_automatizable_aun
- Mark ambiguous cases as necesita_revision with a concrete state_reason.
- Mark captcha, 2FA, manual-only, external calls, or missing data as no_automatizable_aun.
- Keep password/secret/token values masked as ******.
- Use priority values baja, media, alta, critica.`;

export function normalizationWarnings(cases: ProGuide.Dict[]) {
  const warnings = [];
  for (const testCase of cases) {
    if (testCase.automation_state !== 'listo') {
      warnings.push({
        case_id: testCase.id,
        type: 'automation_state',
        message: testCase.state_reason || 'El caso requiere revision antes de ejecutar.'
      });
    }
    for (const assertion of testCase.assertions || []) {
      if (assertion.type === 'unsupported') {
        warnings.push({
          case_id: testCase.id,
          type: 'unsupported_api_assertion',
          message: `Asercion API no soportada: ${assertion.reason || 'unsupported'}`,
          assertion
        });
      }
    }
    for (const step of testCase.executable_steps || []) {
      if (Number(step.confidence ?? 1) < 0.75 || step.needs_review) {
        warnings.push({
          case_id: testCase.id,
          step: step.number,
          type: 'step_confidence',
          original_text: step.original_text,
          normalized_action: step.normalized_action,
          confidence: Number(step.confidence ?? 0)
        });
      }
      if (step.normalized_action === step.original_text && !explicitStep(step.original_text)) {
        warnings.push({
          case_id: testCase.id,
          step: step.number,
          type: 'unchanged_step',
          original_text: step.original_text,
          normalized_action: step.normalized_action,
          confidence: Number(step.confidence ?? 0)
        });
      }
      if (
        step.normalized_action === 'go to /' &&
        !/(https?:\/\/|\/[A-Za-z0-9_\-/?#=&.]+)/.test(step.original_text || '')
      ) {
        warnings.push({
          case_id: testCase.id,
          step: step.number,
          type: 'generic_navigation_fallback',
          original_text: step.original_text,
          normalized_action: step.normalized_action,
          confidence: Number(step.confidence ?? 0)
        });
      }
    }
  }
  return warnings;
}

export async function interpretMarkdownWithAgent(
  markdown: string,
  {
    root,
    sourceName,
    usageContext = null
  }: {
    root: string;
    sourceName: string;
    usageContext?: ProGuide.UsageContext | null;
  }
) {
  const config = await loadUiConfig(root);
  const baseline = parseMarkdownCases(markdown, { sourceName });
  const payload = {
    required_output_shape: markdownAgentSchema(),
    source_name: sourceName,
    markdown: markdown.slice(0, config.llm.max_context_chars),
    deterministic_baseline: baseline
  };
  const parsed = await callJsonModel(config, {
    root,
    system: MARKDOWN_AGENT_PROMPT,
    payload,
    purpose: 'interpretar casos Markdown',
    usageContext
  });
  const casesData = coerceCasesPayload(parsed);
  const cases = casesData.map((item, index) =>
    normalizeCaseForStorage(item, index + 1, baseline[index])
  );
  return cases.slice(0, config.llm.max_cases).length
    ? cases.slice(0, config.llm.max_cases)
    : baseline;
}

export function normalizeCaseForStorage(
  item: ProGuide.CaseInput,
  number: number,
  fallback: ProGuide.CaseInput = {}
) {
  const title = String(item.title || fallback.title || `Caso ${number}`).trim();
  const originalSteps = cleanList(
    item.original_steps || item.steps || fallback.original_steps || fallback.steps || []
  );
  const expectedResults = cleanList(
    item.expected_results || item.expected || fallback.expected_results || fallback.expected || []
  );
  const flowRequests = normalizeApiRequests(
    firstArrayValue(
      item.requests,
      item.flow,
      item.api_requests,
      item.request_steps,
      fallback.requests,
      fallback.flow,
      fallback.api_requests,
      fallback.request_steps
    )
  );
  const request = normalizeApiRequest({
    ...((fallback && fallback.request) || {}),
    ...((fallback && fallback.api) || {}),
    ...((item && item.request) || {}),
    ...((item && item.api) || {}),
    type:
      item.type ||
      item.kind ||
      item.test_type ||
      fallback.type ||
      fallback.kind ||
      fallback.test_type,
    route: item.route || fallback.route,
    method:
      item.method ||
      item.request_method ||
      item.http_method ||
      item.request?.method ||
      item.api?.method ||
      fallback.request?.method,
    path:
      item.path ||
      item.endpoint ||
      item.request_path ||
      item.url ||
      item.request?.path ||
      item.request?.endpoint ||
      item.api?.path ||
      item.api?.endpoint ||
      fallback.request?.path,
    headers:
      item.headers ||
      item.request_headers ||
      item.request?.headers ||
      item.api?.headers ||
      fallback.request?.headers,
    query:
      item.query ||
      item.params ||
      item.request_query ||
      item.request?.query ||
      item.request?.params ||
      item.api?.query ||
      item.api?.params ||
      fallback.request?.query,
    body:
      item.body ??
      item.payload ??
      item.request_body ??
      item.request?.body ??
      item.api?.body ??
      fallback.request?.body,
    expected_status:
      item.expected_status ||
      item.status_code ||
      item.status ||
      item.request?.expected_status ||
      item.api?.expected_status ||
      fallback.expected_status ||
      fallback.request?.expected_status,
    steps: originalSteps,
    expected: expectedResults
  });
  const effectiveRequest =
    request.method && request.path ? request : flowRequests[0]?.request || request;
  const type = inferCaseType({
    type:
      item.type ||
      item.kind ||
      item.test_type ||
      fallback.type ||
      fallback.kind ||
      fallback.test_type,
    request: effectiveRequest,
    requests: flowRequests,
    steps: originalSteps,
    expected: expectedResults
  });
  const assertions =
    type === 'api'
      ? normalizeApiAssertions({
          assertions: item.assertions || item.api_assertions || fallback.assertions || [],
          expected: expectedResults,
          expectedStatus: effectiveRequest.expected_status
        })
      : [];
  if (type === 'api') rejectUnsupportedApiAssertions(assertions, title);
  const apiExecutableSteps: ProGuide.Dict[] =
    type === 'api' && !originalSteps.length
      ? buildApiExecutableSteps({
          request: effectiveRequest,
          requests: flowRequests,
          assertions,
          captures: normalizeApiCaptures(
            item.captures ??
              item.save ??
              item.extract ??
              fallback.captures ??
              fallback.save ??
              fallback.extract
          )
        })
      : [];
  const executableSteps: ProGuide.Dict[] =
    Array.isArray(item.executable_steps) && item.executable_steps.length
      ? item.executable_steps.map((step, index) => ({
          number: Number(step.number || index + 1),
          original_text: String(step.original_text || originalSteps[index] || ''),
          normalized_action: String(
            step.normalized_action ||
              (type === 'api'
                ? normalizeApiCaseStep(step.original_text || originalSteps[index] || '')
                : normalizeStep(step.original_text || originalSteps[index] || ''))
          ),
          status: String(step.status || 'pending'),
          started_at: step.started_at || null,
          finished_at: step.finished_at || null,
          duration_seconds: Number(step.duration_seconds || 0),
          observed_result: String(step.observed_result || ''),
          screenshot: step.screenshot || null,
          error: step.error || null,
          confidence: Number(step.confidence ?? 1),
          needs_review: Boolean(step.needs_review),
          review_reason: String(step.review_reason || '')
        }))
      : apiExecutableSteps.length
        ? apiExecutableSteps
        : buildSteps(originalSteps, { type });
  const route =
    type === 'api'
      ? effectiveRequest.path ||
        inferCaseRoute(item.route || fallback.route, originalSteps, executableSteps)
      : inferCaseRoute(item.route || fallback.route, originalSteps, executableSteps);
  const explicitAutomationState = item.automation_state || fallback.automation_state || '';
  const apiAutomation =
    type === 'api'
      ? assessAutomation(originalSteps, expectedResults, {
          type,
          request: effectiveRequest,
          requests: flowRequests,
          assertions
        })
      : null;
  return {
    id: safeId(item.id || fallback.id || `caso_${number}_${title}`),
    number: Number(item.number || fallback.number || number),
    type,
    title,
    description: String(item.description ?? fallback.description ?? ''),
    priority: normalizePriority(item.priority || fallback.priority || 'media'),
    tags: splitTags(item.tags || fallback.tags || []),
    preconditions: cleanList(item.preconditions || fallback.preconditions || []),
    data_used: maskSecretLines(cleanList(item.data_used || fallback.data_used || [])),
    data: sanitizeCaseData(mergeCaseData(item.data || {}, fallback.data || {})),
    request: type === 'api' ? effectiveRequest : null,
    requests: type === 'api' ? flowRequests : [],
    assertions,
    original_steps: originalSteps,
    executable_steps: executableSteps,
    expected_results: expectedResults,
    confidence: Number(item.confidence ?? fallback.confidence ?? 1),
    automation_state: normalizeAutomationState(
      explicitAutomationState || apiAutomation?.[0] || 'listo'
    ),
    state_reason: String(item.state_reason ?? fallback.state_reason ?? apiAutomation?.[1] ?? ''),
    original_markdown: String(item.original_markdown ?? fallback.original_markdown ?? ''),
    route,
    debug: Boolean(item.debug ?? fallback.debug ?? false),
    qa_owner: noneIfEmpty(item.qa_owner ?? fallback.qa_owner),
    dev_owner: noneIfEmpty(item.dev_owner ?? fallback.dev_owner),
    ticket: noneIfEmpty(item.ticket ?? fallback.ticket),
    excluded: Boolean(item.excluded ?? fallback.excluded ?? false),
    parallelizable: item.parallelizable ?? fallback.parallelizable ?? true,
    result_obtained: String(item.result_obtained ?? fallback.result_obtained ?? ''),
    status: String(item.status || fallback.status || 'pending'),
    started_at: item.started_at || fallback.started_at || null,
    finished_at: item.finished_at || fallback.finished_at || null,
    duration_seconds: Number(item.duration_seconds || fallback.duration_seconds || 0),
    artifacts: Array.isArray(item.artifacts) ? item.artifacts : fallback.artifacts || []
  };
}

function markdownAgentSchema(): ProGuide.Dict {
  return {
    cases: [
      {
        id: 'caso_1_login_valido',
        number: 1,
        type: 'ui|api',
        title: 'Login valido',
        description: 'string',
        priority: 'baja|media|alta|critica',
        tags: ['string'],
        preconditions: ['string'],
        data_used: ['Password: ******'],
        request: {
          method: 'GET|POST|PUT|PATCH|DELETE',
          path: '/api/resource',
          headers: {},
          query: {},
          body: {},
          expected_status: 200
        },
        requests: [
          {
            id: 'login',
            method: 'POST',
            path: '/login',
            headers: {},
            query: {},
            body: {},
            expected_status: 200,
            assertions: [{ path: 'access_token', exists: true }],
            captures: { access_token: 'access_token' }
          }
        ],
        assertions: [{ type: 'status', expected: 200 }],
        original_steps: ['string'],
        executable_steps: [
          {
            number: 1,
            original_text: 'Ir a /login',
            normalized_action: 'go to /login',
            confidence: 0.9,
            needs_review: false,
            review_reason: ''
          }
        ],
        expected_results: ['page shows Dashboard'],
        confidence: 0.9,
        automation_state: 'listo|necesita_revision|no_automatizable_aun',
        state_reason: 'string',
        original_markdown: 'string',
        route: '/',
        qa_owner: 'string or null',
        dev_owner: 'string or null',
        ticket: 'string or null',
        excluded: false,
        parallelizable: true
      }
    ]
  };
}

function coerceCasesPayload(data: ProGuide.Dict): ProGuide.CaseInput[] {
  if (Array.isArray(data.cases)) return data.cases;
  if (Array.isArray(data.normalized_cases)) return data.normalized_cases;
  if (Array.isArray(data.test_cases)) return data.test_cases;
  throw new Error('El agente no devolvio una lista de casos en la clave cases.');
}
