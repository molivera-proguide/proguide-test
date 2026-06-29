// @ts-check

// Public facade (barrel) for the ProGuide test service. The implementation lives
// in lib/ modules by domain (run-store, codegen, runner, usage, llm, cases,
// markdown, shared); this file only re-exports the public API consumed by
// cli.js, mcp-server.js, server.js and viewer.js. See REFACTOR.md for the map.

export {
  listRunRecords,
  loadRunBundle,
  loadGeneratedCaseCode,
  prepareMarkdownRun,
  prepareCasesRun,
  previewMarkdownRun,
  saveCasesForRun,
  appendCasesToRun,
  executePreparedRun
} from './lib/run-store/runs.js';
export { recordLlmUsage, loadUsageSummary } from './lib/usage/record.js';
export { parsePlaywrightResults } from './lib/runner/playwright.js';
export { playwrightWorkerArgs } from './lib/runner/config.js';
export { inspectRoute } from './lib/codegen/dom-context.js';
