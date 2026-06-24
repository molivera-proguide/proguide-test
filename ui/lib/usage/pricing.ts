import { safeNumber, roundMoney } from '../shared/num.js';

// LLM usage normalization and local cost estimation. Only Anthropic models have
// a local pricing table; other providers return a null cost with a note.

export const ANTHROPIC_PRICING_SOURCE = 'https://docs.anthropic.com/en/docs/about-claude/pricing';

type AnthropicPricingFamily = 'sonnet' | 'opus' | 'haiku';

export const ANTHROPIC_PRICING_BY_FAMILY: Record<AnthropicPricingFamily, ProGuide.Dict<number>> = {
  sonnet: {
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_write_5m_per_mtok: 3.75,
    cache_write_1h_per_mtok: 6,
    cache_read_per_mtok: 0.3
  },
  opus: {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_write_5m_per_mtok: 6.25,
    cache_write_1h_per_mtok: 10,
    cache_read_per_mtok: 0.5
  },
  haiku: {
    input_per_mtok: 1,
    output_per_mtok: 5,
    cache_write_5m_per_mtok: 1.25,
    cache_write_1h_per_mtok: 2,
    cache_read_per_mtok: 0.1
  }
};

/**
 * Map a model id to its Anthropic pricing family, or '' if unknown.
 * @param {string} model
 */
export function anthropicModelFamily(model: string): AnthropicPricingFamily | '' {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('haiku')) return 'haiku';
  return '';
}

/**
 * Normalize a raw provider usage payload into ProGuide's canonical token shape.
 * @param {string} provider
 */
export function normalizeLlmUsage(provider: string, usage: ProGuide.Dict = {}) {
  const inputTokens = safeNumber(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens
  );
  const outputTokens = safeNumber(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens
  );
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {};
  const hasDetailedCacheCreation =
    usage.cache_creation_5m_input_tokens !== undefined ||
    usage.cache_creation_1h_input_tokens !== undefined ||
    Boolean(usage.cache_creation);
  const cacheCreation5m =
    safeNumber(usage.cache_creation_5m_input_tokens ?? cacheCreation.ephemeral_5m_input_tokens) +
    safeNumber(!hasDetailedCacheCreation ? usage.cache_creation_input_tokens : 0);
  const cacheCreation1h = safeNumber(
    usage.cache_creation_1h_input_tokens ?? cacheCreation.ephemeral_1h_input_tokens
  );
  const cacheRead = safeNumber(
    usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens
  );
  const cacheCreationTotal = cacheCreation5m + cacheCreation1h;
  const reportedTotal = safeNumber(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = reportedTotal || inputTokens + outputTokens + cacheCreationTotal + cacheRead;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTotal,
    cache_creation_5m_input_tokens: cacheCreation5m,
    cache_creation_1h_input_tokens: cacheCreation1h,
    cache_read_input_tokens: cacheRead,
    total_tokens: totalTokens,
    provider: String(provider || '').toLowerCase()
  };
}

/**
 * Estimate the USD cost of a normalized usage payload using the local table.
 * @param {string} provider
 * @param {string} model
 */
export function estimateLlmCost(provider: string, model: string, usage: ProGuide.Dict) {
  if (String(provider || '').toLowerCase() !== 'anthropic') {
    return {
      cost_usd: null,
      pricing: {
        source: 'unknown',
        note: 'Costo no estimado para este proveedor.'
      }
    };
  }
  const family = anthropicModelFamily(model);
  const pricing = family ? ANTHROPIC_PRICING_BY_FAMILY[family] : null;
  if (!pricing) {
    return {
      cost_usd: null,
      pricing: {
        source: ANTHROPIC_PRICING_SOURCE,
        note: `Modelo Anthropic sin tabla local de precios: ${model || 'unknown'}.`
      }
    };
  }
  const cost =
    (safeNumber(usage.input_tokens) * pricing.input_per_mtok +
      safeNumber(usage.output_tokens) * pricing.output_per_mtok +
      safeNumber(usage.cache_creation_5m_input_tokens) * pricing.cache_write_5m_per_mtok +
      safeNumber(usage.cache_creation_1h_input_tokens) * pricing.cache_write_1h_per_mtok +
      safeNumber(usage.cache_read_input_tokens) * pricing.cache_read_per_mtok) /
    1_000_000;
  return {
    cost_usd: roundMoney(cost),
    pricing: {
      source: ANTHROPIC_PRICING_SOURCE,
      provider: 'anthropic',
      model_family: family,
      unit: 'USD_per_million_tokens',
      rates: pricing
    }
  };
}
