// @ts-check
import path from 'node:path';

/**
 * Whether `target` resolves to `root` itself or a path nested inside it.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
