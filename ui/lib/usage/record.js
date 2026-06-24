// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../shared/time.js';
import { safeNumber, roundMoney } from '../shared/num.js';
import { normalizeLlmUsage, estimateLlmCost } from './pricing.js';
import {
  usageRoot,
  globalUsageLogPath,
  runPath,
  LLM_USAGE_JSON,
  readJson,
  writeJson,
  appendEvent,
  exists
} from '../run-store/io.js';

// LLM usage accounting: record each model call (global JSONL + per-run file +
// event) and summarize stored usage by provider/model/run with cost totals.
// I/O over run-store primitives + pricing. Extracted verbatim from
// proguide-service.js; recordLlmUsage/loadUsageSummary are imported back there
// (both part of the public API) and recordLlmUsage by lib/llm/anthropic.js.


/**
 * @param {{root: string, runId?: string|null, runDir?: string|null, provider: string, model: string, purpose: string, usage: ProGuide.Dict, request?: ProGuide.Dict}} input
 */
export async function recordLlmUsage({
  root,
  runId = null,
  runDir = null,
  provider,
  model,
  purpose,
  usage,
  request = {}
}) {
  const normalized = normalizeLlmUsage(provider, usage);
  if (!normalized.total_tokens && !normalized.input_tokens && !normalized.output_tokens) return null;

  const estimate = estimateLlmCost(provider, model, normalized);
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: nowIso(),
    run_id: runId || null,
    provider: String(provider || '').toLowerCase(),
    model: String(model || ''),
    purpose: String(purpose || ''),
    usage: normalized,
    estimated_cost_usd: estimate.cost_usd,
    pricing: estimate.pricing,
    request: {
      max_output_tokens: request.max_output_tokens || null
    }
  };

  await fs.mkdir(usageRoot(root), { recursive: true });
  await fs.appendFile(globalUsageLogPath(root), `${JSON.stringify(entry)}\n`, 'utf8');

  const effectiveRunDir = runDir || (runId ? runPath(root, runId) : null);
  if (effectiveRunDir) {
    const runUsagePath = path.join(effectiveRunDir, LLM_USAGE_JSON);
    const current = await readJson(runUsagePath, { run_id: runId || path.basename(effectiveRunDir), entries: [] });
    const entries = Array.isArray(current.entries) ? current.entries : [];
    entries.push(entry);
    await writeJson(runUsagePath, {
      run_id: runId || path.basename(effectiveRunDir),
      updated_at: entry.timestamp,
      summary: summarizeUsageEntries(entries, { scope: 'run', runId: runId || path.basename(effectiveRunDir) }),
      entries
    });
    await appendEvent(effectiveRunDir, {
      run_id: runId || path.basename(effectiveRunDir),
      type: 'llm_usage_recorded',
      status: '',
      message: `Uso LLM registrado: ${formatUsageTokensForEvent(normalized)} tokens.`,
      payload: {
        provider: entry.provider,
        model: entry.model,
        purpose: entry.purpose,
        estimated_cost_usd: entry.estimated_cost_usd,
        usage: entry.usage
      }
    }).catch(() => {});
  }

  return entry;
}

export async function loadUsageSummary(root, { runId = null } = {}) {
  const entries = runId
    ? await loadRunUsageEntries(root, runId)
    : await loadGlobalUsageEntries(root);
  return summarizeUsageEntries(entries, {
    scope: runId ? 'run' : 'workspace',
    runId: runId || null
  });
}

async function loadGlobalUsageEntries(root) {
  const logPath = globalUsageLogPath(root);
  if (!(await exists(logPath))) return [];
  const text = await fs.readFile(logPath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return normalizeStoredUsageEntry(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

async function loadRunUsageEntries(root, runId) {
  const runDir = runPath(root, runId);
  const payload = await readJson(path.join(runDir, LLM_USAGE_JSON), null);
  if (payload && Array.isArray(payload.entries)) {
    return payload.entries
      .map(normalizeStoredUsageEntry)
      .filter(Boolean)
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  }
  const entries = await loadGlobalUsageEntries(root);
  return entries.filter((entry) => entry.run_id === runId);
}

function normalizeStoredUsageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const provider = String(entry.provider || '').toLowerCase();
  return {
    id: String(entry.id || `${entry.timestamp || nowIso()}_${provider || 'llm'}`),
    timestamp: entry.timestamp || '',
    run_id: entry.run_id || null,
    provider,
    model: String(entry.model || ''),
    purpose: String(entry.purpose || ''),
    usage: normalizeLlmUsage(provider, entry.usage || {}),
    estimated_cost_usd: finiteOrNull(entry.estimated_cost_usd),
    pricing: entry.pricing || { source: 'unknown', note: 'Sin informacion de precios.' },
    request: entry.request || {}
  };
}

function summarizeUsageEntries(entries, { scope = 'workspace', runId = null } = {}) {
  const normalizedEntries = (entries || []).map(normalizeStoredUsageEntry).filter(Boolean);
  const totals = usageTotals(normalizedEntries);
  return {
    scope,
    run_id: runId || null,
    generated_at: nowIso(),
    entries_count: normalizedEntries.length,
    ...totals,
    unknown_cost_entries: normalizedEntries.filter((entry) => entry.estimated_cost_usd === null).length,
    by_provider: groupUsage(normalizedEntries, (entry) => entry.provider || 'unknown'),
    by_model: groupUsage(normalizedEntries, (entry) => entry.model || 'unknown'),
    by_run: groupUsage(normalizedEntries, (entry) => entry.run_id || 'sin_run'),
    entries: normalizedEntries.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))),
    pricing_note: 'Costos estimados con tokens reportados por la API. La factura final puede diferir por descuentos, impuestos, tiers o cambios de proveedor.'
  };
}

function usageTotals(entries) {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0
  };
  let hasKnownCost = false;
  for (const entry of entries || []) {
    const usage = entry.usage || {};
    totals.input_tokens += safeNumber(usage.input_tokens);
    totals.output_tokens += safeNumber(usage.output_tokens);
    totals.cache_creation_input_tokens += safeNumber(usage.cache_creation_input_tokens);
    totals.cache_creation_5m_input_tokens += safeNumber(usage.cache_creation_5m_input_tokens);
    totals.cache_creation_1h_input_tokens += safeNumber(usage.cache_creation_1h_input_tokens);
    totals.cache_read_input_tokens += safeNumber(usage.cache_read_input_tokens);
    totals.total_tokens += safeNumber(usage.total_tokens);
    if (entry.estimated_cost_usd !== null && Number.isFinite(Number(entry.estimated_cost_usd))) {
      hasKnownCost = true;
      totals.estimated_cost_usd += Number(entry.estimated_cost_usd);
    }
  }
  totals.estimated_cost_usd = hasKnownCost ? roundMoney(totals.estimated_cost_usd) : null;
  return totals;
}

function groupUsage(entries, keyFn) {
  const groups = new Map();
  for (const entry of entries || []) {
    const key = String(keyFn(entry) || 'unknown');
    const current = groups.get(key) || { key, entries: [] };
    current.entries.push(entry);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      entries_count: group.entries.length,
      last_at: group.entries.map((entry) => entry.timestamp || '').sort().at(-1) || '',
      ...usageTotals(group.entries)
    }))
    .sort((a, b) => {
      const costA = a.estimated_cost_usd ?? -1;
      const costB = b.estimated_cost_usd ?? -1;
      if (costA !== costB) return costB - costA;
      return String(b.last_at || '').localeCompare(String(a.last_at || ''));
    });
}

function formatUsageTokensForEvent(usage) {
  return String(safeNumber(usage.total_tokens));
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
