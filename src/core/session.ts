import type { Document } from '@xmldom/xmldom';
import { randomUUID } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { Header } from './header.js';
import { buildSections } from './model.js';
import { applyOp } from './ops.js';
import { HwpxPackage, parseXml, serializeXml, type PackageSnapshot } from './package.js';
import { Registry } from './registry.js';
import { OpError, type DocModel, type DocSession, type FindHit, type Op, type OpResult, type Paragraph } from './types.js';

type Meta = { sourcePath: string | null; sourceFormat: 'hwpx' | 'hwp' | 'new'; path: string | null };
type Snapshot = { xml: string[]; registry: string; pkg: PackageSnapshot };

export class Session implements DocSession {
  readonly docId = randomUUID();
  private header: Header;
  private sections: Document[];
  private registry: Registry;
  private revision = 0;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private initial: string[];
  private saved: string[];
  private savedManifest: Uint8Array;
  private path: string | null;

  constructor(private pkg: HwpxPackage, private meta: Meta) {
    this.header = new Header(pkg.document(pkg.headerPath));
    this.sections = pkg.sectionPaths.map(path => pkg.document(path));
    this.registry = new Registry(this.sections);
    this.path = meta.path;
    this.initial = this.xml();
    this.saved = this.initial.slice();
    this.savedManifest = pkg.entries['Contents/content.hpf'];
    this.model();
  }
  private xml(): string[] { return [this.header.document, ...this.sections].map(serializeXml); }
  private snapshot(): Snapshot { return { xml: this.xml(), registry: this.registry.snapshot(), pkg: this.pkg.snapshot() }; }
  private restore(snapshot: Snapshot): void {
    this.pkg.restore(snapshot.pkg);
    const docs = snapshot.xml.map(parseXml);
    this.header = new Header(docs[0]);
    this.sections = docs.slice(1);
    this.registry.restore(snapshot.registry, this.sections);
  }
  model(): DocModel {
    const xml = this.xml();
    return { docId: this.docId, path: this.path, sourcePath: this.meta.sourcePath, sourceFormat: this.meta.sourceFormat,
      revision: this.revision, dirty: xml.some((s, i) => s !== this.saved[i]) || this.pkg.entries['Contents/content.hpf'] !== this.savedManifest,
      sections: buildSections(this.sections, this.header, this.registry), fonts: this.header.fonts, styles: this.header.namedStyles };
  }
  apply(ops: Op[]): OpResult {
    const before = this.snapshot();
    const result: OpResult = { revision: this.revision, created: [], replaced: 0 };
    let index = 0;
    try {
      for (const op of ops) {
        const applied = applyOp(op, { sections: this.sections, header: this.header, registry: this.registry, pkg: this.pkg });
        if (applied.created) result.created.push(applied.created);
        result.replaced += applied.replaced ?? 0;
        this.model();
        index++;
      }
    } catch (error) {
      this.restore(before);
      throw new OpError(index, error instanceof Error ? error.message : String(error));
    }
    if (ops.length) {
      this.undoStack.push(before);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
      result.revision = ++this.revision;
    }
    return result;
  }
  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
    this.revision++;
    return true;
  }
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.revision++;
    return true;
  }
  private paragraphs(): { p: Paragraph; tableId?: string; cell?: { row: number; col: number } }[] {
    const result: { p: Paragraph; tableId?: string; cell?: { row: number; col: number } }[] = [];
    const visit = (p: Paragraph, tableId?: string, cell?: { row: number; col: number }) => {
      result.push({ p, tableId, cell });
      for (const anchor of p.anchors) if (anchor.kind === 'table') for (const row of anchor.rows) for (const c of row) for (const child of c.paragraphs) visit(child, anchor.id, { row: c.row, col: c.col });
    };
    for (const section of this.model().sections) for (const p of section.paragraphs) visit(p);
    return result;
  }
  outline(opts: { from?: string; limit?: number } = {}): string {
    const paragraphs = this.paragraphs();
    const from = opts.from ? paragraphs.findIndex(x => x.p.id === opts.from || x.tableId === opts.from) : 0;
    return paragraphs.slice(Math.max(0, from), opts.limit === undefined ? undefined : Math.max(0, from) + opts.limit).map(({ p, tableId, cell }) => {
      const objects = p.anchors.filter(anchor => anchor.kind === 'object').map(anchor => {
        const size = anchor.widthMm !== undefined && anchor.heightMm !== undefined ? ` ${Number(anchor.widthMm.toFixed(2))}×${Number(anchor.heightMm.toFixed(2))}mm` : '';
        return ` [${anchor.id} ${anchor.label}${size}]`;
      }).join('');
      return `[${tableId && cell ? `${tableId} r${cell.row}c${cell.col}/` : ''}${p.id}] ${p.runs.map(r => r.text).join('')}${objects}`;
    }).join('\n');
  }
  plainText(): string { return this.paragraphs().map(({ p }) => p.runs.map(r => r.text).join('')).join('\n'); }
  find(query: string, opts: { regex?: boolean; matchCase?: boolean } = {}): FindHit[] {
    if (!query) return [];
    const pattern = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pattern, opts.matchCase ? 'g' : 'gi');
    const hits: FindHit[] = [];
    for (const { p, tableId, cell } of this.paragraphs()) {
      const text = p.runs.map(r => r.text).join('');
      for (const match of text.matchAll(re)) hits.push({ paragraphId: p.id, start: match.index, end: match.index + match[0].length,
        context: text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40), ...(tableId ? { tableId, cell } : {}) });
    }
    return hits;
  }
  getBinary(binId: string): { data: Uint8Array; mime: string } | null {
    const path = this.pkg.binaries.get(binId);
    if (!path || !this.pkg.entries[path]) return null;
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
    return { data: this.pkg.entries[path], mime: mime[extname(path).toLowerCase()] ?? 'application/octet-stream' };
  }
  async save(targetPath?: string): Promise<string> {
    const path = targetPath ?? this.path;
    if (!path) throw new Error('Save path is required');
    const xml = this.xml();
    const replacements = new Map<string, string>();
    [this.pkg.headerPath, ...this.pkg.sectionPaths].forEach((name, i) => { if (xml[i] !== this.initial[i]) replacements.set(name, xml[i]); });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, this.pkg.encode(replacements)); await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
    this.path = path;
    this.saved = xml;
    this.savedManifest = this.pkg.entries['Contents/content.hpf'];
    return path;
  }
}
