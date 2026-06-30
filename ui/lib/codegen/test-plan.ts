import { priorityForPlan } from '../shared/text.js';
import { maskSecretLines } from '../shared/secrets.js';
import { nowIso } from '../shared/time.js';
import {
  normalizeApiRequest,
  normalizeApiRequests,
  normalizeApiAssertions
} from '../cases/api-normalize.js';
import { mergeCaseData, dataFromLines, inferCaseRoute } from '../cases/normalize.js';

// Build the executable test plan (test_plan.json shape) from normalized cases.
// Pure transform (no I/O). Extracted verbatim from proguide-service.js; the
// single export is imported back there.

export function casesToTestPlan(
  cases: ProGuide.Dict[],
  { sourceMd, appName }: { sourceMd: string; appName: string }
) {
  const plannedCases: ProGuide.Dict[] = [];
  for (const testCase of cases) {
    if (testCase.excluded) continue;
    if (testCase.automation_state !== 'listo') continue;
    const type = testCase.type === 'api' ? 'api' : 'ui';
    const request =
      type === 'api'
        ? normalizeApiRequest({
            ...(testCase.request || {}),
            route: testCase.route,
            steps: testCase.original_steps || [],
            expected: testCase.expected_results || []
          })
        : null;
    const apiRequests = type === 'api' ? normalizeApiRequests(testCase.requests || []) : [];
    const steps: string[] = [];
    const stepsGrounding: any[] = [];
    for (const step of testCase.executable_steps || []) {
      const action = step.normalized_action || step.original_text;
      if (action) {
        steps.push(action);
        stepsGrounding.push(step.grounding || null);
      }
    }
    const caseData = mergeCaseData(testCase.data || {}, dataFromLines(testCase.data_used || []));
    const route =
      type === 'api'
        ? request.path || testCase.route || '/'
        : inferCaseRoute(testCase.route, testCase.original_steps, testCase.executable_steps);
    plannedCases.push({
      id: testCase.id,
      feature_id: 'markdown_cases',
      scenario_id: testCase.id,
      type,
      title: testCase.title,
      description: testCase.description || testCase.title,
      route,
      request,
      requests: apiRequests,
      assertions:
        type === 'api'
          ? normalizeApiAssertions({
              assertions: testCase.assertions || [],
              expected: testCase.expected_results || [],
              expectedStatus: request?.expected_status
            })
          : [],
      debug: Boolean(testCase.debug),
      priority: priorityForPlan(testCase.priority),
      steps: steps.length
        ? steps
        : type === 'api'
          ? [`api ${request.method} ${request.path}`]
          : ['go to /'],
      steps_grounding: steps.length
        ? stepsGrounding
        : [null],
      expected: (testCase.expected_results || []).length
        ? testCase.expected_results
        : type === 'api'
          ? [`status ${request.expected_status ?? 200}`]
          : ['page is visible'],
      data: {
        ...caseData,
        preconditions: testCase.preconditions || [],
        data_used: maskSecretLines(testCase.data_used || []),
        qa_owner: testCase.qa_owner || null,
        dev_owner: testCase.dev_owner || null,
        ticket: testCase.ticket || null
      }
    });
  }
  return {
    schema_version: '1.0',
    generated_at: nowIso(),
    app_name: appName,
    source_prd: sourceMd,
    cases: plannedCases
  };
}
