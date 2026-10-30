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
export type PackageSnapshot = { entries: Record<string, Uint8Array>; order: string[]; binaries: [string, string][] };

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
  snapshot(): PackageSnapshot {
    return { entries: { ...this.entries }, order: [...this.order], binaries: [...this.binaries] };
  }
  restore(snapshot: PackageSnapshot): void {
    for (const key of Object.keys(this.entries)) delete this.entries[key];
    Object.assign(this.entries, snapshot.entries);
    this.order.splice(0, this.order.length, ...snapshot.order);
    this.binaries.clear();
    for (const [id, path] of snapshot.binaries) this.binaries.set(id, path);
  }
  addBinary(data: Uint8Array, extension: string, mime: string): string {
    const manifest = this.document('Contents/content.hpf');
    const container = elements(manifest, 'manifest')[0];
    if (!container) throw new Error('HWPX package has no manifest');
    const ids = new Set(elements(manifest, 'item').map(item => item.getAttribute('id')));
    let n = 1;
    while (ids.has(`image${n}`) || this.entries[`BinData/image${n}.${extension}`]) n++;
    const id = `image${n}`, path = `BinData/${id}.${extension}`;
    const item = manifest.createElementNS(container.namespaceURI, `${container.prefix || 'opf'}:item`);
    item.setAttribute('id', id); item.setAttribute('href', path); item.setAttribute('media-type', mime); item.setAttribute('isEmbeded', '1');
    container.appendChild(item);
    this.entries['Contents/content.hpf'] = new TextEncoder().encode(serializeXml(manifest));
    this.entries[path] = data; this.order.push(path); this.binaries.set(id, path);
    return id;
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
