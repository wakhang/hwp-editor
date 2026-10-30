import { readFileSync } from 'node:fs';
import type { Element, Node } from '@xmldom/xmldom';
import type { HwpxPackage } from './package.js';
import type { Registry } from './registry.js';
import type { Op } from './types.js';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HC = 'http://www.hancom.co.kr/hwpml/2011/core';
const MM = 25.4 / 7200;
type PictureOp = Extract<Op, { op: 'insertPicture' }>;

function dimensions(bytes: Buffer): { width: number; height: number; ext: string; mime: string } {
  let width = 0, height = 0, ext = '', mime = '';
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); ext = 'png'; mime = 'image/png';
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); ext = 'gif'; mime = 'image/gif';
  } else if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    const dib = bytes.readUInt32LE(14);
    if (dib === 12) { width = bytes.readUInt16LE(18); height = bytes.readUInt16LE(20); }
    else if (dib >= 40) { width = bytes.readInt32LE(18); height = Math.abs(bytes.readInt32LE(22)); }
    ext = 'bmp'; mime = 'image/bmp';
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    ext = 'jpg'; mime = 'image/jpeg';
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i++] !== 0xff) break;
      while (i < bytes.length && bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  }
  if (!width || !height || width < 0) throw new Error('Unsupported or invalid image');
  return { width, height, ext, mime };
}
function child(node: Node, local: string): Element | undefined {
  for (let n = node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === local) return n as Element;
  return undefined;
}
function value(el: Element | undefined, attr: string, fallback = 0): number {
  const raw = el?.getAttribute(attr); const n = raw ? Number(raw) : fallback;
  return Number.isFinite(n) ? n : fallback;
}
function availableWidth(p: Element): number {
  for (let n: Node | null = p.parentNode; n; n = n.parentNode) {
    if (n.nodeType === 1 && n.localName === 'tc') {
      const cell = n as Element;
      let table: Node | null = cell.parentNode;
      while (table && table.localName !== 'tbl') table = table.parentNode;
      const margin = cell.getAttribute('hasMargin') === '0' && table ? child(table, 'inMargin') : child(cell, 'cellMargin');
      return Math.max(1, value(child(cell, 'cellSz'), 'width') - value(margin, 'left') - value(margin, 'right'));
    }
  }
  const page = p.ownerDocument!.getElementsByTagNameNS(HP, 'pagePr').item(0) ?? undefined;
  const margin = page && child(page, 'margin');
  return Math.max(1, value(page, 'width', 59528) - value(margin, 'left', 8504) - value(margin, 'right', 8504) - value(margin, 'gutter'));
}
export function insertPicture(op: PictureOp, p: Element, pkg: HwpxPackage, registry: Registry): string {
  if ((op.path === undefined) === (op.data === undefined)) throw new Error('Specify exactly one of path and data');
  if (op.widthMm !== undefined && (!Number.isFinite(op.widthMm) || op.widthMm <= 0) || op.heightMm !== undefined && (!Number.isFinite(op.heightMm) || op.heightMm <= 0)) throw new Error('Picture dimensions must be positive');
  if (op.data !== undefined && (!op.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(op.data))) throw new Error('Invalid base64 image data');
  const bytes = op.path !== undefined ? readFileSync(op.path) : Buffer.from(op.data!, 'base64');
  const image = dimensions(bytes);
  let width = op.widthMm ?? (op.heightMm !== undefined ? op.heightMm * image.width / image.height : image.width * 25.4 / 96);
  let height = op.heightMm ?? width * image.height / image.width;
  const scale = Math.min(1, availableWidth(p) * MM / width); width *= scale; height *= scale;
  const w = Math.max(1, Math.round(width / MM)), h = Math.max(1, Math.round(height / MM));
  const id = pkg.addBinary(bytes, image.ext, image.mime);
  const doc = p.ownerDocument!;
  const make = (local: string, attrs: Record<string, string | number> = {}, ns = HP): Element => {
    const el = doc.createElementNS(ns, `${ns === HP ? 'hp' : 'hc'}:${local}`);
    for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val));
    return el;
  };
  const pic = make('pic', { id: 0, zOrder: 0, numberingType: 'PICTURE', textWrap: 'TOP_AND_BOTTOM', textFlow: 'BOTH_SIDES', lock: 0, dropcapstyle: 'None', href: '', groupLevel: 0, instid: 0, reverse: 0 });
  pic.appendChild(make('offset', { x: 0, y: 0 }));
  pic.appendChild(make('orgSz', { width: w, height: h })); pic.appendChild(make('curSz', { width: w, height: h }));
  pic.appendChild(make('flip', { horizontal: 0, vertical: 0 })); pic.appendChild(make('rotationInfo', { angle: 0, centerX: Math.floor(w / 2), centerY: Math.floor(h / 2), rotateimage: 1 }));
  const rendering = make('renderingInfo');
  for (const name of ['transMatrix', 'scaMatrix', 'rotMatrix']) rendering.appendChild(make(name, { e1: 1, e2: 0, e3: 0, e4: 0, e5: 1, e6: 0 }, HC));
  pic.appendChild(rendering);
  const rect = make('imgRect');
  [[0, 0], [w, 0], [w, h], [0, h]].forEach(([x, y], i) => rect.appendChild(make(`pt${i}`, { x, y }, HC))); pic.appendChild(rect);
  pic.appendChild(make('imgClip', { left: 0, right: image.width * 75, top: 0, bottom: image.height * 75 }));
  pic.appendChild(make('inMargin', { left: 0, right: 0, top: 0, bottom: 0 }));
  pic.appendChild(make('imgDim', { dimwidth: image.width * 75, dimheight: image.height * 75 }));
  pic.appendChild(make('img', { binaryItemIDRef: id, bright: 0, contrast: 0, effect: 'REAL_PIC', alpha: 0 }, HC));
  pic.appendChild(make('sz', { width: w, widthRelTo: 'ABSOLUTE', height: h, heightRelTo: 'ABSOLUTE', protect: 0 }));
  pic.appendChild(make('pos', { treatAsChar: 1, affectLSpacing: 0, flowWithText: 1, allowOverlap: 0, holdAnchorAndSO: 0, vertRelTo: 'PARA', horzRelTo: 'COLUMN', vertAlign: 'TOP', horzAlign: 'LEFT', vertOffset: 0, horzOffset: 0 }));
  pic.appendChild(make('outMargin', { left: 0, right: 0, top: 0, bottom: 0 }));
  const run = make('run', { charPrIDRef: value(child(p, 'run'), 'charPrIDRef') }); run.appendChild(pic);
  p.insertBefore(run, child(p, 'linesegarray') ?? null);
  const layout = child(p, 'linesegarray'); if (layout) p.removeChild(layout);
  return registry.id(pic, 'o');
}
