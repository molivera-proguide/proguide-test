import fs from 'node:fs/promises';
import path from 'node:path';

// Read and decode Markdown source files (UTF-8/UTF-16 BOM aware) and combine
// multiple sources. Extracted verbatim from run-store/runs.js; readMarkdownSources,
// markdownSourceFilename and combineMarkdownSources are imported back there.

type MarkdownSource = {
  path: string;
  name: string;
  markdown: string;
};

async function readMarkdownText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return repairDecodedMarkdown(new TextDecoder('utf-16le').decode(data.subarray(2)));
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return repairDecodedMarkdown(new TextDecoder('utf-16le').decode(swapBytes(data.subarray(2))));
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return repairDecodedMarkdown(new TextDecoder('utf-8').decode(data.subarray(3)));
  }
  return repairDecodedMarkdown(new TextDecoder('utf-8', { fatal: false }).decode(data));
}

export async function readMarkdownSources(sourceMd: string | string[]): Promise<MarkdownSource[]> {
  const paths = (Array.isArray(sourceMd) ? sourceMd : [sourceMd]).filter(Boolean);
  if (!paths.length) throw new Error('Debes pasar al menos un archivo Markdown.');
  return Promise.all(
    paths.map(async (filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      markdown: await readMarkdownText(filePath)
    }))
  );
}

export function markdownSourceFilename(sources: MarkdownSource[]): string {
  if (sources.length === 1) return sources[0].name;
  const names = sources.map((source) => source.name).join(', ');
  return names.length <= 180 ? names : `${sources.length} markdown files`;
}

export function combineMarkdownSources(sources: MarkdownSource[]): string {
  if (sources.length === 1) return sources[0].markdown;
  return sources
    .map((source) => `<!-- source: ${source.name} -->\n\n${source.markdown.trim()}`)
    .join('\n\n');
}

function swapBytes(buffer: Uint8Array): Buffer {
  const swapped = Buffer.from(buffer);
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    const next = swapped[index];
    swapped[index] = swapped[index + 1];
    swapped[index + 1] = next;
  }
  return swapped;
}

function repairDecodedMarkdown(text: string): string {
  return text.replace(/^(\s*)\ufffd(?=\s+)/gm, '$1-');
}
