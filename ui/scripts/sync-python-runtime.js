import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(uiRoot, '..');
const source = path.join(repoRoot, 'proguide');
const target = path.join(uiRoot, 'python', 'proguide');

if (!existsSync(source)) {
  throw new Error(`No se encontro el runtime Python en ${source}`);
}

await fs.rm(target, { recursive: true, force: true });
await copyTree(source, target);

async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__pycache__') continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.pyc')) continue;
    await fs.copyFile(sourcePath, targetPath);
  }
}
