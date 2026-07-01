import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// package.json shipped alongside the compiled code (dist/package.json). Resolving
// relative to this module keeps it correct both from dist/ and the installed pkg.
const PACKAGE_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

function readDiskVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || '');
  } catch {
    return '';
  }
}

// Captured ONCE when this module is first imported == the version this process is
// actually running. A later `npm install` overwrites package.json on disk but not
// this in-memory value, which is exactly what lets us detect a stale MCP server
// that kept old code loaded after an upgrade (a recurring foot-gun: reinstalling
// does not reload a long-lived server process).
export const RUNNING_VERSION = readDiskVersion();

// True when a newer (or simply different) version sits on disk than the one this
// process loaded at startup -> the server is stale and must be restarted.
export function checkStaleVersion(): { stale: boolean; running: string; onDisk: string } {
  const onDisk = readDiskVersion();
  const stale = Boolean(RUNNING_VERSION && onDisk && onDisk !== RUNNING_VERSION);
  return { stale, running: RUNNING_VERSION, onDisk };
}
