import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml } from '../shared/html.js';

// Render the per-run HTML evidence report (evidence.html) from the run summary.
// Extracted verbatim from proguide-service.js; imported back there.

export async function writeEvidenceReport({
  summary,
  run,
  cases,
  runDir
}: {
  summary: ProGuide.Dict;
  run: ProGuide.Dict;
  cases: ProGuide.Dict[];
  runDir: string;
}) {
  const caseById = new Map(cases.map((item) => [String(item.id), item]));
  const rows = (summary.results || []).map((result: ProGuide.Dict) => {
    const testCase: ProGuide.Dict = caseById.get(String(result.id)) || {};
    const errorDetails = result.error_details
      ? `<details class="error-console"><summary>Error Playwright completo</summary><pre>${escapeHtml(result.error_details)}</pre></details>`
      : '';
    const actualResponse = result.actual_response
      ? `<details class="error-console"><summary>Actual response</summary><pre>${escapeHtml(JSON.stringify(result.actual_response, null, 2))}</pre></details>`
      : '';
    const apiEvidence = (result.api_evidence || []).length
      ? `<details class="error-console"><summary>API evidence</summary><pre>${escapeHtml(JSON.stringify(result.api_evidence, null, 2))}</pre></details>`
      : '';
    return `<tr>
      <td>${escapeHtml(testCase.number || '')}</td>
      <td>${escapeHtml(result.title)}</td>
      <td>${escapeHtml(result.status)}</td>
      <td>${escapeHtml(result.message || '')}${apiEvidence}${actualResponse}${errorDetails}</td>
    </tr>`;
  }).join('');
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(run.title || run.ticket || 'Evidencia QA')}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 32px; line-height: 1.45; }
    h1 { margin: 0 0 8px; }
    .muted { color: #64748b; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; color: #475569; font-size: 12px; text-transform: uppercase; }
    .error-console { margin-top: 10px; }
    .error-console summary { cursor: pointer; color: #991b1b; font-weight: 700; }
    .error-console pre { white-space: pre-wrap; overflow-x: auto; background: #111827; color: #f8fafc; border-radius: 6px; padding: 12px; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <h1>${escapeHtml(run.title || run.ticket || 'Evidencia QA')}</h1>
  <p class="muted">${escapeHtml(summary.base_url || '')}</p>
  <p><strong>Run:</strong> ${escapeHtml(run.id)} | <strong>Estado:</strong> ${escapeHtml(run.status)}</p>
  <table>
    <thead><tr><th>N</th><th>Caso</th><th>Estado</th><th>Mensaje</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
  const htmlPath = path.join(runDir, 'evidence.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}
