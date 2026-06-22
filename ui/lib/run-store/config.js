// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROGUIDE_DIR, exists } from './io.js';

// Viewer/runner UI config: defaults + shallow YAML (config.yaml) overrides for the
// runner, identity and llm sections. Extracted verbatim from run-store/runs.js;
// loadUiConfig is imported back there.

export async function loadUiConfig(root) {
  const config = {
    runner: {
      browser: 'chromium',
      parallel_workers: 'auto',
      video: 'on',
      screenshots: 'on',
      traces: 'retain_on_failure'
    },
    identity: {
      run_user_email: '',
      run_user_name: '',
      project_name: '',
      project_key: '',
      require_user_email: false,
      require_project_name: false
    },
    llm: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.2,
      max_cases: 12,
      max_context_chars: 50000,
      max_output_tokens: 8000
    }
  };
  const configPath = path.join(root, PROGUIDE_DIR, 'config.yaml');
  if (!(await exists(configPath))) return config;
  const text = await fs.readFile(configPath, 'utf8');
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^([A-Za-z_][\w-]*):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const valueMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!valueMatch || !config[section]) continue;
    config[section][valueMatch[1]] = parseYamlScalar(valueMatch[2]);
  }
  return config;
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
