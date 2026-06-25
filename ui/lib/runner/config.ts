// Pure Playwright runner-config helpers: worker CLI args and normalization of
// the screenshot/trace/video capture modes. No I/O. Extracted verbatim from
// proguide-service.js; the service imports these back (and re-exports
// playwrightWorkerArgs, which is part of its public API).

export function playwrightWorkerArgs(config: ProGuide.Dict = {}): string[] {
  const rawWorkers = config?.runner?.parallel_workers ?? 'auto';
  const workers = String(rawWorkers ?? '')
    .trim()
    .toLowerCase();
  if (!workers || workers === 'auto') return [];
  if (['1', '0', 'false', 'off', 'none'].includes(workers)) return ['--workers=1'];

  const count = Number(rawWorkers);
  if (Number.isInteger(count) && count > 1) return [`--workers=${count}`];

  throw new Error(
    `runner.parallel_workers invalido: ${rawWorkers}. Usa "auto", 1 o un entero mayor que 1.`
  );
}

export function normalizePlaywrightScreenshot(value: unknown): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (['on', 'off', 'only-on-failure'].includes(normalized)) return normalized;
  if (['on-failure', 'failure', 'failed'].includes(normalized)) return 'only-on-failure';
  return 'only-on-failure';
}

export function normalizePlaywrightTrace(value: unknown): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (['on', 'off', 'retain-on-failure', 'on-first-retry', 'on-all-retries'].includes(normalized))
    return normalized;
  if (['retain-on-fail', 'retain-on-failed', 'retain-failure'].includes(normalized))
    return 'retain-on-failure';
  return 'retain-on-failure';
}

export function normalizePlaywrightVideo(value: unknown): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (['on', 'off', 'retain-on-failure', 'on-first-retry'].includes(normalized)) return normalized;
  if (['true', 'yes'].includes(normalized)) return 'on';
  if (['false', 'no', 'none'].includes(normalized)) return 'off';
  return 'on';
}
