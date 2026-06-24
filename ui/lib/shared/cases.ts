type BrowserCase = { type?: string; request?: { method?: string; path?: string } };

/**
 * Whether a set of cases needs a real browser (Chromium) to run. API-only
 * suites (every case is type "api" or a bare method+path request) do not.
 * An empty/invalid set conservatively requires a browser.
 */
export function casesRequireBrowser(cases: BrowserCase[] = []): boolean {
  if (!Array.isArray(cases) || !cases.length) return true;
  return cases.some(
    (testCase) =>
      String(testCase.type || '').toLowerCase() !== 'api' &&
      !(testCase.request?.method && testCase.request?.path)
  );
}
