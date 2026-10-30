import { XMLSerializer } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import type { Align, CharStyle, StylePatch } from './types.js';

const HH = 'http://www.hancom.co.kr/hwpml/2011/head';

function children(parent: Element, name: string): Element[] {
  const result: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === name) result.push(n as Element);
  }
  return result;
}
function first(parent: Element, name: string): Element | undefined {
  return children(parent, name)[0];
}
function descendants(parent: Document | Element, name: string): Element[] {
  const nodes = parent.getElementsByTagNameNS(HH, name);
  return Array.from({ length: nodes.length }, (_, i) => nodes.item(i)!).filter(Boolean);
}
function nextId(elements: Element[], start = 0): number {
  return elements.reduce((n, el) => Math.max(n, Number(el.getAttribute('id')) + 1 || 0), start);
}
function alignment(value: string | null): Align {
  switch (value?.toUpperCase()) {
    case 'RIGHT': return 'right';
    case 'CENTER': return 'center';
    case 'JUSTIFY': return 'justify';
    case 'DISTRIBUTE': case 'DISTRIBUTE_SPACE': return 'distribute';
    default: return 'left';
  }
}

export class Header {
  readonly styles = new Map<number, CharStyle>();
  readonly paraAlign = new Map<number, Align>();
  readonly styleNames = new Map<number, string>();
  readonly fonts: string[] = [];
  readonly namedStyles: { id: number; name: string }[] = [];
  private readonly fontIds = new Map<number, string>();
  private readonly charElements = new Map<number, Element>();
  private readonly paraElements = new Map<number, Element>();

  constructor(readonly document: Document) {
    const hangul = descendants(document, 'fontface').find(e => e.getAttribute('lang') === 'HANGUL');
    if (hangul) for (const font of children(hangul, 'font')) {
      const name = font.getAttribute('face') || '';
      this.fontIds.set(Number(font.getAttribute('id')), name);
      if (name && !this.fonts.includes(name)) this.fonts.push(name);
    }
    for (const el of descendants(document, 'charPr')) {
      const id = Number(el.getAttribute('id'));
      this.charElements.set(id, el);
      this.styles.set(id, this.readChar(el));
    }
    for (const el of descendants(document, 'paraPr')) {
      const id = Number(el.getAttribute('id'));
      this.paraElements.set(id, el);
      this.paraAlign.set(id, alignment(first(el, 'align')?.getAttribute('horizontal') ?? null));
    }
    for (const el of descendants(document, 'style')) {
      const id = Number(el.getAttribute('id'));
      const name = el.getAttribute('name') || el.getAttribute('engName') || '';
      this.styleNames.set(id, name);
      this.namedStyles.push({ id, name });
    }
  }

  private readChar(el: Element): CharStyle {
    const underline = first(el, 'underline');
    const strike = first(el, 'strikeout');
    const shade = el.getAttribute('shadeColor');
    return {
      charPrId: Number(el.getAttribute('id')),
      font: this.fontIds.get(Number(first(el, 'fontRef')?.getAttribute('hangul'))) || '',
      sizePt: Number(el.getAttribute('height') || 1000) / 100,
      bold: !!first(el, 'bold'), italic: !!first(el, 'italic'),
      underline: !!underline && (underline.getAttribute('type') || 'NONE').toUpperCase() !== 'NONE',
      strike: !!strike && (strike.getAttribute('shape') || 'NONE').toUpperCase() !== 'NONE',
      color: el.getAttribute('textColor') || '#000000',
      highlight: shade && shade.toLowerCase() !== 'none' ? shade : null,
    };
  }

  private setFontRefs(ref: Element, name: string): void {
    const faces = descendants(this.document, 'fontface');
    if (!faces.some(face => face.getAttribute('lang') === 'HANGUL')) {
      throw new Error('HWPX header has no HANGUL fontface');
    }
    for (const face of faces) {
      const lang = face.getAttribute('lang')?.toLowerCase();
      if (!lang || !['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'].includes(lang)) continue;
      const existing = children(face, 'font');
      let font = existing.find(item => item.getAttribute('face') === name);
      if (!font) {
        font = this.document.createElementNS(HH, 'hh:font');
        font.setAttribute('id', String(nextId(existing)));
        font.setAttribute('face', name);
        font.setAttribute('type', 'TTF');
        font.setAttribute('isEmbedded', '0');
        face.appendChild(font);
        face.setAttribute('fontCnt', String(existing.length + 1));
      }
      const id = Number(font.getAttribute('id'));
      ref.setAttribute(lang, String(id));
      if (lang === 'hangul') {
        this.fontIds.set(id, name);
        if (!this.fonts.includes(name)) this.fonts.push(name);
      }
    }
  }

  private same(a: Element, b: Element): boolean {
    const serializer = new XMLSerializer();
    const x = a.cloneNode(true) as Element, y = b.cloneNode(true) as Element;
    x.removeAttribute('id'); y.removeAttribute('id');
    return serializer.serializeToString(x) === serializer.serializeToString(y);
  }

  ensureCharPr(base: number, patch: StylePatch): number {
    const original = this.charElements.get(base);
    if (!original) throw new Error(`Unknown charPr id: ${base}`);
    const el = original.cloneNode(true) as Element;
    if (patch.sizePt !== undefined) el.setAttribute('height', String(Math.round(patch.sizePt * 100)));
    if (patch.color !== undefined) el.setAttribute('textColor', patch.color);
    if (patch.highlight !== undefined) el.setAttribute('shadeColor', patch.highlight ?? 'none');
    if (patch.font !== undefined) {
      let ref = first(el, 'fontRef');
      if (!ref) { ref = this.document.createElementNS(HH, 'hh:fontRef'); el.insertBefore(ref, el.firstChild); }
      this.setFontRefs(ref, patch.font);
    }
    for (const [name, enabled] of [['bold', patch.bold], ['italic', patch.italic]] as const) {
      if (enabled === undefined) continue;
      const old = first(el, name);
      if (!enabled && old) el.removeChild(old);
      if (enabled && !old) {
        const node = this.document.createElementNS(HH, `hh:${name}`);
        el.insertBefore(node, name === 'bold' ? first(el, 'italic') || first(el, 'underline') || null : first(el, 'underline') || null);
      }
    }
    for (const [name, attr, enabled, on] of [['underline', 'type', patch.underline, 'BOTTOM'], ['strikeout', 'shape', patch.strike, 'SOLID']] as const) {
      if (enabled === undefined) continue;
      let node = first(el, name);
      if (!node && !enabled) continue;
      if (!node) {
        node = this.document.createElementNS(HH, `hh:${name}`);
        if (name === 'underline') node.setAttribute('shape', 'SOLID');
        node.setAttribute('color', '#000000');
        el.insertBefore(node, name === 'underline' ? first(el, 'strikeout') || first(el, 'outline') || null : first(el, 'outline') || null);
      }
      node.setAttribute(attr, enabled ? on : 'NONE');
    }
    for (const [id, candidate] of this.charElements) if (this.same(el, candidate)) return id;
    const parent = original.parentNode as Element;
    const id = nextId([...this.charElements.values()]);
    el.setAttribute('id', String(id)); parent.appendChild(el);
    parent.setAttribute('itemCnt', String(children(parent, 'charPr').length));
    this.charElements.set(id, el); this.styles.set(id, this.readChar(el));
    return id;
  }

  ensureParaPr(base: number, align: Align): number {
    const original = this.paraElements.get(base);
    if (!original) throw new Error(`Unknown paraPr id: ${base}`);
    if (this.paraAlign.get(base) === align) return base;
    const el = original.cloneNode(true) as Element;
    let node = first(el, 'align');
    if (!node) { node = this.document.createElementNS(HH, 'hh:align'); node.setAttribute('vertical', 'BASELINE'); el.insertBefore(node, el.firstChild); }
    node.setAttribute('horizontal', align.toUpperCase());
    for (const [id, candidate] of this.paraElements) if (this.same(el, candidate)) return id;
    const parent = original.parentNode as Element;
    const id = nextId([...this.paraElements.values()]);
    el.setAttribute('id', String(id)); parent.appendChild(el);
    parent.setAttribute('itemCnt', String(children(parent, 'paraPr').length));
    this.paraElements.set(id, el); this.paraAlign.set(id, align);
    return id;
  }

  ensureBorderFill(): number {
    const container = descendants(this.document, 'borderFills')[0];
    if (!container) throw new Error('HWPX header has no borderFills');
    const fills = children(container, 'borderFill');
    const sides = ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'];
    for (const fill of fills) {
      if (sides.every(side => first(fill, side)?.getAttribute('type') === 'SOLID') && !first(fill, 'fillBrush')) return Number(fill.getAttribute('id'));
    }
    const id = nextId(fills, 1);
    const fill = this.document.createElementNS(HH, 'hh:borderFill');
    for (const [key, value] of Object.entries({ id: String(id), threeD: '0', shadow: '0', centerLine: 'NONE', breakCellSeparateLine: '0' })) fill.setAttribute(key, value);
    for (const name of ['slash', 'backSlash']) {
      const node = this.document.createElementNS(HH, `hh:${name}`);
      node.setAttribute('type', 'NONE'); node.setAttribute('Crooked', '0'); node.setAttribute('isCounter', '0'); fill.appendChild(node);
    }
    for (const name of [...sides, 'diagonal']) {
      const node = this.document.createElementNS(HH, `hh:${name}`);
      node.setAttribute('type', 'SOLID'); node.setAttribute('width', '0.1 mm'); node.setAttribute('color', '#000000'); fill.appendChild(node);
    }
    container.appendChild(fill); container.setAttribute('itemCnt', String(fills.length + 1));
    return id;
  }
}
