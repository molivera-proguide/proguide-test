// @ts-check
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { loadDotEnv } from '../shared/env.js';
import { PROGUIDE_DIR, positiveInteger } from '../run-store/io.js';
import { recordLlmUsage } from '../usage/record.js';

// Anthropic JSON-model call: resolve the API key, invoke the Messages API,
// record usage, and extract a JSON object from the response. Extracted verbatim
// from proguide-service.js; callJsonModel is imported back there (the API-key,
// error-detail and JSON-extraction helpers stay internal).

export async function callJsonModel(config, { root, system, payload, purpose, usageContext = null }) {
  await loadDotEnv(root);
  const provider = String(config.llm.provider || 'disabled').toLowerCase();
  const configPath = path.join(root, PROGUIDE_DIR, 'config.yaml');
  const maxOutputTokens = positiveInteger(config.llm.max_output_tokens, 8000);
  if (provider === 'disabled') {
    throw new Error(`El agente LLM esta deshabilitado; no se puede ${purpose}. Root efectivo: ${root}. Provider: ${provider}. Config: ${configPath}.`);
  }
  if (provider === 'anthropic') {
    const apiKey = anthropicApiKey();
    if (!apiKey.value) throw new Error(`Falta ANTHROPIC_API_KEY, PROGUIDE_LLM_API_KEY o API_KEY para ${purpose}. Root efectivo: ${root}. Provider: ${provider}. Config: ${configPath}.`);
    const client = new Anthropic({ apiKey: apiKey.value });
    let data;
    try {
      data = await client.messages.create({
        model: config.llm.model,
        max_tokens: maxOutputTokens,
        temperature: Number(config.llm.temperature ?? 0.2),
        system,
        messages: [
          { role: 'user', content: JSON.stringify(payload) }
        ]
      });
    } catch (error) {
      throw new Error(`Anthropic fallo al ${purpose}${anthropicErrorDetails(error)}`, { cause: error });
    }
    await recordLlmUsage({
      root,
      runId: usageContext?.runId || null,
      runDir: usageContext?.runDir || null,
      provider,
      model: config.llm.model,
      purpose,
      usage: data.usage,
      request: { max_output_tokens: maxOutputTokens }
    }).catch(() => {});
    const text = (data.content || [])
      .map((block) => block.type === 'text' ? block.text : '')
      .join('\n');
    if (data.stop_reason === 'max_tokens') {
      throw new Error(`Anthropic trunco la respuesta al ${purpose}. max_tokens=${maxOutputTokens}. Sube llm.max_output_tokens o baja llm.max_cases en ${configPath}.`);
    }
    return extractJson(text, { purpose, provider, maxOutputTokens, configPath });
  }
  throw new Error(`Proveedor LLM no soportado: ${provider}. ProGuide solo soporta anthropic. Root efectivo: ${root}. Config: ${configPath}.`);
}

function anthropicErrorDetails(error) {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ? ` (${error.status})` : '';
    const message = error.message || error.name || 'sin detalle';
    return `${status}: ${message}`;
  }
  return `: ${error?.message || String(error)}`;
}

function anthropicApiKey() {
  const names = ['ANTHROPIC_API_KEY', 'PROGUIDE_LLM_API_KEY', 'API_KEY'];
  const name = names.find((item) => process.env[item]);
  return { name: name || names[0], value: name ? process.env[name] : '' };
}

function extractJson(content, context = {}) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        // Fall through to the contextual error below.
      }
    }
    const details = context.purpose
      ? ` al ${context.purpose}. Provider: ${context.provider}. max_tokens=${context.maxOutputTokens}. Config: ${context.configPath}.`
      : '.';
    throw new Error(`El agente no devolvio JSON valido${details} ${error.message}`, { cause: error });
  }
}
