import fs from 'node:fs/promises';
import path from 'node:path';
import { PROGUIDE_DIR, exists } from './io.js';
import { defaultConfig } from '../config/defaults.js';

// Viewer/runner UI config: central defaults + shallow YAML (config.yaml) overrides
// for the runner, identity and llm sections. loadUiConfig is imported back into
// run-store/runs.js.

export async function loadUiConfig(root: string): Promise<ProGuide.Dict> {
  const config = defaultConfig();
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

function parseYamlScalar(value: unknown): string | number | boolean {
  const trimmed = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
