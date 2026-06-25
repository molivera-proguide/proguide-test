import fs from 'node:fs/promises';
import path from 'node:path';

// Shared .env loading used by both the CLI and the core service. The loader
// reads the first matching env file in each candidate location and sets any
// variable that is not already present in process.env (existing env wins).

/**
 * Ordered list of candidate .env file paths for a workspace root.
 */
export function envFileCandidates(root: string): string[] {
  return [
    process.env.PROGUIDE_ENV_FILE,
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.proguide', '.env'),
    path.join(root, '.env')
  ]
    .filter(Boolean)
    .map((item) => path.resolve(String(item)));
}

/**
 * Load environment variables from the candidate .env files into process.env.
 * Missing or unreadable files are skipped; variables already set are preserved.
 */
export async function loadDotEnv(root: string): Promise<void> {
  for (const envPath of envFileCandidates(root)) {
    let text;
    try {
      text = await fs.readFile(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}
