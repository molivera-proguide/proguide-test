import { inspectRoute } from './dom-context.js';
import { isApiPlanCase } from './api-spec.js';

function stripWrappingQuotes(val: string): string {
  return val.replace(/^["']|["']$/g, '');
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
    // Text target
    const textVal = target.value.toLowerCase().trim();
    
    for (const ctrl of controls) {
      const ctrlText = String(ctrl.text || '').toLowerCase().trim();
      const ctrlLabel = (ctrl.label || []).map((l: string) => l.toLowerCase().trim());
      const ctrlAria = String(ctrl.aria_label || '').toLowerCase().trim();
      const ctrlPlaceholder = String(ctrl.placeholder || '').toLowerCase().trim();

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
      const visibleText = String(snapshot.visible_text || '').toLowerCase();
      const headings = (snapshot.headings || []).map((h: string) => h.toLowerCase());
      if (visibleText.includes(textVal) || headings.some(h => h.includes(textVal))) {
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
    const candidates = controls.slice(0, 5).map((m: any) => ({
      selector: m.selector_hint,
      text: m.text,
      role: m.role
    }));
    return {
      status: 'not_found',
      candidates
    };
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

  const route = testCase.route || '/';
  const snapshot = await inspectRoute({
    root,
    baseUrl,
    route,
    config,
    credentials
  });

  if (!snapshot || !snapshot.success) {
    const errorMsg = snapshot?.error || 'No se pudo obtener snapshot de la ruta';
    for (const step of testCase.executable_steps || []) {
      const target = parseStepTarget(step.normalized_action);
      if (target) {
        step.grounding = {
          status: 'unverified',
          candidates: []
        };
        step.needs_review = true;
        step.review_reason = `Error al inspeccionar ruta ${route}: ${errorMsg}`;
      }
    }
    return;
  }

  for (const step of testCase.executable_steps || []) {
    const grounding = groundStepAgainstSnapshot(step, snapshot);
    step.grounding = grounding;
    if (grounding.status !== 'resolved') {
      step.needs_review = true;
      if (grounding.status === 'ambiguous') {
        step.review_reason = `Target de paso ambiguo. Coinciden varios elementos en la pantalla.`;
      } else if (grounding.status === 'not_found') {
        step.review_reason = `Target de paso no encontrado en la pantalla de la ruta ${route}.`;
      }
    } else {
      if (!step.review_reason || step.review_reason.includes('no encontrado') || step.review_reason.includes('ambiguo')) {
        step.needs_review = false;
        step.review_reason = '';
      }
    }
  }
}

export async function groundCases({
  root,
  baseUrl,
  config,
  credentials = {},
  cases
}: {
  root: string;
  baseUrl: string;
  config: ProGuide.Dict;
  credentials?: ProGuide.Dict;
  cases: ProGuide.Dict[];
}) {
  if (!baseUrl) return;
  for (const testCase of cases) {
    await groundCaseSteps({
      root,
      baseUrl,
      config,
      credentials,
      testCase
    });
  }
}
