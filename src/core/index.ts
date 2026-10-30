import { readFile, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { extname, resolve } from 'node:path';
import { convertHwpToHwpx } from '../convert/index.js';
import { HwpxPackage } from './package.js';
import { Session } from './session.js';
import type { DocSession } from './types.js';

export * from './types.js';

export function openHwpxBytes(bytes: Uint8Array, meta: { sourcePath: string | null; sourceFormat: 'hwpx' | 'hwp' | 'new'; path: string | null }): DocSession {
  return new Session(new HwpxPackage(bytes), meta);
}

export async function openDocument(path: string): Promise<DocSession> {
  path = resolve(path);
  const ext = extname(path).toLowerCase();
  if (ext === '.hwp') return openHwpxBytes(await convertHwpToHwpx(path), { sourcePath: path, sourceFormat: 'hwp', path: path.slice(0, -ext.length) + '.hwpx' });
  if (ext !== '.hwpx') throw new Error(`Unsupported document format: ${ext}`);
  return openHwpxBytes(await promisify(readFile)(path), { sourcePath: path, sourceFormat: 'hwpx', path });
}

export function newDocument(): DocSession {
  return openHwpxBytes(readFileSync(new URL('./template/blank.hwpx', import.meta.url)), { sourcePath: null, sourceFormat: 'new', path: null });
}
