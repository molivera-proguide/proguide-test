import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const sourcePackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const runtimePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  type: sourcePackage.type
};

await fs.writeFile(path.join(dist, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8');
await fs.cp(path.join(root, 'skills'), path.join(dist, 'skills'), { recursive: true });
