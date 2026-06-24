// Markdown line-level text helpers: stripping list markers, emphasis, and
// cleaning list blocks into trimmed non-empty lines.

const BULLET_CHARS = '•◦⁃∙·—–�';

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripListMarker(line: string): string {
  const bulletPattern = escapeRegExp(BULLET_CHARS);
  return line
    .replace(
      new RegExp(`^\\s*(?:[-*+${bulletPattern}]\\s+|\\d+[\\).\\s-]+|paso\\s+\\d+[:.\\s-]+)`, 'i'),
      ''
    )
    .trim();
}

export function stripMarkdownEmphasis(line: string): string {
  return line.replace(/\*\*/g, '').replace(/__/g, '').trim();
}

export function cleanList(values: unknown): string[] {
  const rawValues =
    typeof values === 'string'
      ? [values]
      : values && typeof (values as any)[Symbol.iterator] === 'function'
        ? Array.from(values as Iterable<unknown>)
        : [];
  return rawValues.map((value) => stripListMarker(String(value)).trim()).filter(Boolean);
}
