import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { posix } from 'node:path';

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
export function parseXml(data: string | Uint8Array): Document {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  return new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message); } }).parseFromString(text, 'application/xml');
}
export function serializeXml(doc: Document): string {
  const xml = new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^?]*\?>\s*/i, '');
  return declaration + xml;
}
function elements(doc: Document, name: string): Element[] {
  return Array.from(doc.getElementsByTagName('*')).filter(el => el.localName === name);
}

export class HwpxPackage {
  readonly entries: Record<string, Uint8Array>;
  readonly order: string[];
  readonly headerPath: string;
  readonly sectionPaths: string[];
  readonly binaries = new Map<string, string>();
  constructor(bytes: Uint8Array) {
    this.entries = unzipSync(bytes);
    this.order = Object.keys(this.entries);
    const manifestBytes = this.entries['Contents/content.hpf'];
    if (!manifestBytes) throw new Error('HWPX package has no Contents/content.hpf');
    const manifest = parseXml(manifestBytes);
    const items = new Map<string, string>();
    for (const item of elements(manifest, 'item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (!id || !href) continue;
      const clean = decodeURIComponent(href).replace(/^\/+/, '');
      const path = this.entries[clean] ? clean : posix.normalize(posix.join('Contents', clean));
      items.set(id, path);
      if (/^BinData\//i.test(path)) this.binaries.set(id, path);
    }
    const header = items.get('header') ?? [...items.values()].find(path => /(?:^|\/)header\.xml$/i.test(path));
    if (!header || !this.entries[header]) throw new Error('HWPX package has no header');
    this.headerPath = header;
    this.sectionPaths = elements(manifest, 'itemref').map(item => items.get(item.getAttribute('idref') ?? '')).filter((path): path is string => {
      if (!path || path === header || !this.entries[path] || !/\.xml$/i.test(path)) return false;
      return parseXml(this.entries[path]).documentElement?.localName === 'sec';
    });
    if (!this.sectionPaths.length) throw new Error('HWPX package has no sections in spine');
  }
  document(path: string): Document {
    const bytes = this.entries[path];
    if (!bytes) throw new Error(`Missing HWPX entry: ${path}`);
    return parseXml(bytes);
  }
  encode(replacements: Map<string, string>): Uint8Array {
    const files: Zippable = {};
    const order = ['mimetype', ...this.order.filter(name => name !== 'mimetype')];
    for (const name of order) {
      const content = replacements.has(name) ? new TextEncoder().encode(replacements.get(name)!) : this.entries[name];
      if (content) files[name] = [content, { level: name === 'mimetype' ? 0 : 6 }];
    }
    return zipSync(files);
  }
}
