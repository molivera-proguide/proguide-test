import path from 'node:path';

/**
 * Whether `target` resolves to `root` itself or a path nested inside it.
 */
export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative)));
}
