import type { Document, Element, Node } from '@xmldom/xmldom';
import type { Header } from './header.js';
import type { Registry } from './registry.js';
import { composeDisplay } from './model.js';
import { insertPicture } from './picture.js';
import type { HwpxPackage } from './package.js';
import type { Op, RunInput } from './types.js';

const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
type Context = { sections: Document[]; header: Header; registry: Registry; pkg: HwpxPackage };
type Piece = RunInput & { base: number; composeElement?: Element };
const name = (node: Node) => node.localName || node.nodeName.split(':').pop();
const paragraphIds = new WeakMap<Document, { used: Set<number>; next: number }>();
function nextParagraphId(doc: Document): string {
  let state = paragraphIds.get(doc);
  if (!state) {
    const used = new Set<number>();
    for (const p of descendants(doc, 'p')) {
      const id = Number(p.getAttribute('id'));
      if (Number.isInteger(id) && id >= 0) used.add(id);
    }
    state = { used, next: 1 };
    paragraphIds.set(doc, state);
  }
  while (state.used.has(state.next)) state.next++;
  const id = state.next++;
  state.used.add(id);
  return String(id);
}
const anchorNames = new Set(['tbl', 'pic', 'equation', 'header', 'footer', 'footNote', 'endNote', 'fieldBegin', 'container', 'line', 'rect', 'ellipse', 'arc', 'polygon', 'curve', 'connectLine', 'ole', 'chart', 'video']);
function removeAnchors(node: Node): void {
  for (const child of children(node)) {
    if (anchorNames.has(name(child) || '')) node.removeChild(child);
    else if (name(child) !== 'secPr') removeAnchors(child);
  }
}
function children(node: Node, local?: string): Element[] {
  const out: Element[] = [];
  for (let n = node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!local || name(n) === local)) out.push(n as Element);
  return out;
}
function descendants(node: Node, local: string): Element[] {
  const out: Element[] = [];
  for (const child of children(node)) { if (name(child) === local) out.push(child); out.push(...descendants(child, local)); }
  return out;
}
function elem(doc: Document, local: string, attrs: Record<string, string | number> = {}): Element {
  const el = doc.createElementNS(HP, `hp:${local}`);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}
function attached(el: Element, ctx: Context): boolean {
  let root: Node = el;
  while (root.parentNode && root.parentNode.nodeType !== 9) root = root.parentNode;
  return ctx.sections.some(doc => doc.documentElement === root);
}
function required(ctx: Context, id: string, local: string): Element {
  const el = ctx.registry.get(id);
  if (!el || name(el) !== local || !attached(el, ctx)) throw new Error(`Invalid ${local} id: ${id}`);
  return el;
}
function num(el: Element | undefined, attr: string, fallback = 0): number {
  const v = el?.getAttribute(attr); return v == null || v === '' ? fallback : Number(v);
}
function clearLayout(p: Element): void { for (const el of children(p, 'linesegarray')) p.removeChild(el); }
function pieces(p: Element): Piece[] {
  const result: Piece[] = [];
  for (const run of children(p, 'run')) {
    const base = num(run, 'charPrIDRef');
    let text = '';
    const flush = () => { if (text) result.push({ text, base }); text = ''; };
    const visit = (node: Node, inText: boolean): void => {
      if (node.nodeType === 3 || node.nodeType === 4) { if (inText) text += node.nodeValue ?? ''; return; }
      if (node.nodeType !== 1) return;
      const el = node as Element, local = name(el);
      if (el.namespaceURI === HP) {
        if (local === 'compose') {
          flush();
          const compose = { composeText: el.getAttribute('composeText') ?? '', circleType: el.getAttribute('circleType') ?? '' };
          result.push({ text: composeDisplay(compose.composeText, compose.circleType), base, compose, composeElement: el });
          return;
        }
        if (local === 'tab') { text += '\t'; return; }
        if (local === 'lineBreak') { text += '\n'; return; }
        if (local === 't') inText = true;
        else if (!inText) return;
      } else if (!inText) return;
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, inText);
    };
    for (let child = run.firstChild; child; child = child.nextSibling) visit(child, false);
    flush();
  }
  return result;
}
function writeText(doc: Document, t: Element, text: string): void {
  for (const part of text.split(/([\t\n])/)) {
    if (part === '\t') t.appendChild(elem(doc, 'tab'));
    else if (part === '\n') t.appendChild(elem(doc, 'lineBreak'));
    else if (part) t.appendChild(doc.createTextNode(part));
  }
}
function setRuns(p: Element, inputs: (RunInput & { composeElement?: Element })[], ctx: Context): void {
  const doc = p.ownerDocument!;
  const old = children(p, 'run');
  const base = num(old[0], 'charPrIDRef');
  // Remove only text nodes; section properties, fields, and anchors remain untouched.
  let insertion: Node | null = null;
  let foundText = false;
  for (const run of old) {
    const texts = children(run, 't');
    if ((texts.length || children(run, 'compose').length) && !foundText) { insertion = run; foundText = true; }
    if (children(run, 'secPr').length || children(run, 'ctrl').length) insertion = run.nextSibling;
    for (const compose of children(run, 'compose')) run.removeChild(compose);
    for (const t of texts) {
      for (let child = t.firstChild; child;) {
        const next = child.nextSibling;
        if (child.nodeType === 3 || child.nodeType === 4 || name(child) === 'tab' || name(child) === 'lineBreak' || name(child) === 'compose') t.removeChild(child);
        child = next;
      }
      if (!t.firstChild) run.removeChild(t);
    }
  }
  for (const input of inputs.length ? inputs : [{ text: '' }]) {
    const b = input.base ?? base;
    const run = elem(doc, 'run', { charPrIDRef: input.style ? ctx.header.ensureCharPr(b, input.style) : b });
    if (input.compose) {
      if (input.text !== composeDisplay(input.compose.composeText, input.compose.circleType)) throw new Error('Compose text must match its display string');
      let compose = input.composeElement?.cloneNode(true);
      if (!compose) {
        compose = elem(doc, 'compose', { circleType: input.compose.circleType, charSz: '-3', composeType: 'SPREAD', charPrCnt: '10', composeText: input.compose.composeText });
        for (let i = 0; i < 10; i++) compose.appendChild(elem(doc, 'charPr', { prIDRef: i < input.compose.composeText.length ? run.getAttribute('charPrIDRef')! : '4294967295' }));
      }
      run.appendChild(compose);
    } else {
      const t = elem(doc, 't'); writeText(doc, t, input.text); run.appendChild(t);
    }
    p.insertBefore(run, insertion);
  }
  for (const run of old) if (!run.firstChild) p.removeChild(run);
  clearLayout(p);
}
function newParagraph(reference: Element): Element {
  const p = elem(reference.ownerDocument!, 'p', { id: nextParagraphId(reference.ownerDocument!), paraPrIDRef: reference.getAttribute('paraPrIDRef') || '0', styleIDRef: reference.getAttribute('styleIDRef') || '0', pageBreak: '0', columnBreak: '0', merged: '0' });
  p.appendChild(elem(reference.ownerDocument!, 'run', { charPrIDRef: num(children(reference, 'run')[0], 'charPrIDRef') }));
  return p;
}
function cellAt(table: Element, row: number, col: number): Element {
  for (const tr of children(table, 'tr')) for (const cell of children(tr, 'tc')) {
    const addr = children(cell, 'cellAddr')[0], span = children(cell, 'cellSpan')[0];
    const r = num(addr, 'rowAddr'), c = num(addr, 'colAddr');
    if (row >= r && row < r + num(span, 'rowSpan', 1) && col >= c && col < c + num(span, 'colSpan', 1)) return cell;
  }
  throw new Error(`No cell at ${row},${col}`);
}
function setCell(cell: Element, text: string, ctx: Context): void {
  const sub = children(cell, 'subList')[0];
  if (!sub) throw new Error('Cell has no subList');
  const paragraphs = children(sub, 'p');
  if (!paragraphs.length) throw new Error('Cell has no paragraph');
  const first = paragraphs[0];
  setRuns(first, [{ text: text.split('\n')[0] }], ctx);
  removeAnchors(first);
  for (const p of paragraphs.slice(1)) sub.removeChild(p);
  let previous = first;
  for (const line of text.split('\n').slice(1)) {
    const p = newParagraph(first); sub.insertBefore(p, previous.nextSibling); setRuns(p, [{ text: line }], ctx); ctx.registry.id(p, 'p'); previous = p;
  }
}
function checkIndex(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}: ${value}`);
}
function rowChange(table: Element, at: number, insert: boolean, ctx: Context): void {
  const rows = children(table, 'tr');
  checkIndex(at, 0, insert ? rows.length : rows.length - 1, 'row');
  if (!insert && rows.length === 1) throw new Error('Cannot delete the last row');
  for (const tr of rows) for (const cell of children(tr, 'tc')) {
    const addr = children(cell, 'cellAddr')[0], span = children(cell, 'cellSpan')[0];
    const start = num(addr, 'rowAddr'), end = start + num(span, 'rowSpan', 1);
    if (insert ? start < at && end > at : start <= at && end > at && end - start > 1) throw new Error('Row intersects a merged cell');
  }
  if (insert) {
    const source = rows[Math.max(0, at - 1)];
    const clone = source.cloneNode(true) as Element;
    for (const paragraph of descendants(clone, 'p')) paragraph.setAttribute('id', nextParagraphId(table.ownerDocument!));
    for (const cell of children(clone, 'tc')) {
      const span = children(cell, 'cellSpan')[0];
      if (num(span, 'rowSpan', 1) !== 1) throw new Error('Cannot copy a row containing a vertical merge');
      children(cell, 'cellAddr')[0].setAttribute('rowAddr', String(at));
      setCell(cell, '', ctx); ctx.registry.id(cell, 'c');
    }
    table.insertBefore(clone, rows[at] || null);
  } else table.removeChild(rows[at]);
  for (let i = insert ? at + 1 : at; i < rows.length + (insert ? 1 : -1); i++) {
    const tr = children(table, 'tr')[i];
    for (const cell of children(tr, 'tc')) children(cell, 'cellAddr')[0].setAttribute('rowAddr', String(i));
  }
  table.setAttribute('rowCnt', String(rows.length + (insert ? 1 : -1)));
  const sz = children(table, 'sz')[0];
  if (sz) {
    const source = insert ? rows[Math.max(0, at - 1)] : rows[at];
    const h = Math.max(0, ...children(source, 'tc').map(c => num(children(c, 'cellSz')[0], 'height')));
    sz.setAttribute('height', String(Math.max(0, num(sz, 'height') + (insert ? h : -h))));
  }
}
function makeTable(p: Element, rows: number, cols: number, data: string[][] | undefined, ctx: Context): Element {
  checkIndex(rows, 1, 10000, 'rows'); checkIndex(cols, 1, 10000, 'cols');
  const doc = p.ownerDocument!;
  let root: Node = p; while (root.parentNode && root.parentNode.nodeType !== 9) root = root.parentNode;
  const page = descendants(root, 'pagePr')[0], margin = page && children(page, 'margin')[0];
  const width = Math.max(1, num(page, 'width', 59528) - num(margin, 'left', 8504) - num(margin, 'right', 8504) - num(margin, 'gutter'));
  const border = ctx.header.ensureBorderFill();
  const table = elem(doc, 'tbl', { id: '0', zOrder: '0', numberingType: 'TABLE', textWrap: 'TOP_AND_BOTTOM', textFlow: 'BOTH_SIDES', lock: '0', dropcapstyle: 'None', pageBreak: 'CELL', repeatHeader: '0', rowCnt: rows, colCnt: cols, cellSpacing: '0', borderFillIDRef: border, noAdjust: '0' });
  table.appendChild(elem(doc, 'sz', { width, widthRelTo: 'ABSOLUTE', height: rows * 2400, heightRelTo: 'ABSOLUTE', protect: '0' }));
  table.appendChild(elem(doc, 'pos', { treatAsChar: '1', affectLSpacing: '0', flowWithText: '1', allowOverlap: '0', holdAnchorAndSO: '0', vertRelTo: 'PARA', horzRelTo: 'COLUMN', vertAlign: 'TOP', horzAlign: 'LEFT', vertOffset: '0', horzOffset: '0' }));
  table.appendChild(elem(doc, 'outMargin', { left: 0, right: 0, top: 0, bottom: 0 }));
  table.appendChild(elem(doc, 'inMargin', { left: 510, right: 510, top: 141, bottom: 141 }));
  for (let r = 0; r < rows; r++) {
    const tr = elem(doc, 'tr'); table.appendChild(tr);
    for (let c = 0; c < cols; c++) {
      const cell = elem(doc, 'tc', { name: '', header: 0, hasMargin: 0, protect: 0, editable: 0, dirty: 0, borderFillIDRef: border }); tr.appendChild(cell);
      const sub = elem(doc, 'subList', { id: '', textDirection: 'HORIZONTAL', lineWrap: 'BREAK', vertAlign: 'CENTER', linkListIDRef: 0, linkListNextIDRef: 0, textWidth: 0, textHeight: 0, hasTextRef: 0, hasNumRef: 0 }); cell.appendChild(sub);
      const cp = newParagraph(p); sub.appendChild(cp); ctx.registry.id(cell, 'c'); ctx.registry.id(cp, 'p');
      cell.appendChild(elem(doc, 'cellAddr', { colAddr: c, rowAddr: r }));
      cell.appendChild(elem(doc, 'cellSpan', { colSpan: 1, rowSpan: 1 }));
      cell.appendChild(elem(doc, 'cellSz', { width: Math.floor(width * (c + 1) / cols) - Math.floor(width * c / cols), height: 2400 }));
      cell.appendChild(elem(doc, 'cellMargin', { left: 510, right: 510, top: 141, bottom: 141 }));
      setCell(cell, data?.[r]?.[c] ?? '', ctx);
    }
  }
  return table;
}
function slicePieces(items: Piece[], start: number, end: number): Piece[] {
  const out: Piece[] = []; let pos = 0;
  for (const item of items) {
    const a = Math.max(0, start - pos), b = Math.min(item.text.length, end - pos);
    if (a < b) {
      if (item.compose && (a !== 0 || b !== item.text.length)) out.push({ text: item.text.slice(a, b), base: item.base, style: item.style });
      else out.push({ ...item, text: item.text.slice(a, b) });
    }
    pos += item.text.length;
  }
  return out;
}
function replaceInParagraph(p: Element, regex: RegExp, replacement: string, ctx: Context): number {
  const items = pieces(p), text = items.map(x => x.text).join('');
  const matches = [...text.matchAll(regex)]; if (!matches.length) return 0;
  const result: Piece[] = []; let previous = 0;
  for (const m of matches) {
    const pos = m.index!; result.push(...slicePieces(items, previous, pos));
    const base = slicePieces(items, pos, pos + Math.max(1, m[0].length))[0]?.base ?? items[0]?.base ?? 0;
    const value = replacement.replace(/\$([$&`']|\d{1,2}|<[^>]+>)/g, (token, key: string) => {
      if (key === '$') return '$'; if (key === '&') return m[0]; if (key === '`') return text.slice(0, pos); if (key === "'") return text.slice(pos + m[0].length);
      if (key[0] === '<') return m.groups ? (m.groups[key.slice(1, -1)] ?? '') : token;
      let n = Number(key); if (n > 0 && n < m.length) return m[n] ?? '';
      if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < m.length) return (m[Number(key[0])] ?? '') + key[1];
      return token;
    });
    result.push({ text: value, base }); previous = pos + m[0].length;
  }
  result.push(...slicePieces(items, previous, text.length)); setRuns(p, result, ctx); return matches.length;
}
export function applyOp(op: Op, ctx: Context): { created?: string; replaced?: number } {
  switch (op.op) {
    case 'setParagraph': setRuns(required(ctx, op.id, 'p'), op.runs, ctx); return {};
    case 'insertParagraph': {
      if (!!op.after === !!op.before) throw new Error('Specify exactly one of after and before');
      const neighbour = required(ctx, (op.after || op.before)!, 'p');
      const source = op.styleFrom ? required(ctx, op.styleFrom, 'p') : neighbour;
      const p = newParagraph(source); neighbour.parentNode!.insertBefore(p, op.after ? neighbour.nextSibling : neighbour);
      setRuns(p, op.runs ?? [{ text: '' }], ctx);
      if (op.align) p.setAttribute('paraPrIDRef', String(ctx.header.ensureParaPr(num(p, 'paraPrIDRef'), op.align)));
      return { created: ctx.registry.id(p, 'p') };
    }
    case 'deleteParagraph': {
      const p = required(ctx, op.id, 'p');
      if (children(p.parentNode!, 'p').length === 1) {
        setRuns(p, [{ text: '' }], ctx);
        removeAnchors(p);
      } else {
        const sibling = children(p.parentNode!, 'p').find(other => other !== p)!;
        for (const run of children(p, 'run')) {
          const keep = children(run).filter(child => name(child) === 'secPr' || (name(child) === 'ctrl' && children(child, 'colPr').length));
          if (keep.length) {
            const moved = elem(p.ownerDocument!, 'run', { charPrIDRef: num(run, 'charPrIDRef') });
            for (const child of keep) removeAnchors(child);
            for (const child of keep) {
              moved.appendChild(child);
            }
            sibling.insertBefore(moved, sibling.firstChild);
          }
        }
        p.parentNode!.removeChild(p);
      }
      return {};
    }
    case 'setAlign': {
      const p = required(ctx, op.id, 'p'); p.setAttribute('paraPrIDRef', String(ctx.header.ensureParaPr(num(p, 'paraPrIDRef'), op.align))); clearLayout(p); return {};
    }
    case 'styleRange': {
      const p = required(ctx, op.id, 'p'), items = pieces(p), length = items.reduce((n, x) => n + x.text.length, 0);
      checkIndex(op.start, 0, length, 'start'); checkIndex(op.end, op.start, length, 'end');
      if (op.start !== op.end) setRuns(p, [...slicePieces(items, 0, op.start), ...slicePieces(items, op.start, op.end).map(x => ({ ...x, style: op.style })), ...slicePieces(items, op.end, length)], ctx);
      return {};
    }
    case 'replaceText': {
      if (!op.find) throw new Error('Find text must not be empty');
      const pattern = op.regex ? op.find : op.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(pattern, `g${op.matchCase ? '' : 'i'}`);
      let roots: Node[] = ctx.sections;
      if (op.scope) { const root = ctx.registry.get(op.scope); if (!root || !attached(root, ctx) || !['p', 'tbl', 'sec'].includes(name(root)!)) throw new Error(`Invalid scope: ${op.scope}`); roots = [root]; }
      let replaced = 0;
      for (const root of roots) for (const p of [...(name(root) === 'p' ? [root as Element] : []), ...descendants(root, 'p')]) replaced += replaceInParagraph(p, regex, op.replace, ctx);
      return { replaced };
    }
    case 'setCellText': { const table = required(ctx, op.tableId, 'tbl'); setCell(cellAt(table, op.row, op.col), op.text, ctx); return {}; }
    case 'insertTable': {
      const previous = required(ctx, op.after, 'p'); const p = newParagraph(previous); previous.parentNode!.insertBefore(p, previous.nextSibling); ctx.registry.id(p, 'p');
      const table = makeTable(p, op.rows, op.cols, op.data, ctx); children(p, 'run')[0].appendChild(table); return { created: ctx.registry.id(table, 't') };
    }
    case 'insertPicture': {
      const target = required(ctx, op.paragraph, 'p');
      let p = target;
      if (pieces(target).some(piece => piece.text.length > 0)) {
        p = newParagraph(target);
        target.parentNode!.insertBefore(p, target.nextSibling);
        ctx.registry.id(p, 'p');
      }
      return { created: insertPicture(op, p, ctx.pkg, ctx.registry) };
    }
    case 'insertRow': rowChange(required(ctx, op.tableId, 'tbl'), op.at, true, ctx); return {};
    case 'deleteRow': rowChange(required(ctx, op.tableId, 'tbl'), op.row, false, ctx); return {};
    case 'deleteObject': {
      const el = ctx.registry.get(op.id); if (!el || !el.parentNode || !attached(el, ctx) || !/^[to]/.test(op.id)) throw new Error(`Invalid object id: ${op.id}`);
      let parent: Node | null = el.parentNode; while (parent && name(parent) !== 'p') parent = parent.parentNode;
      el.parentNode.removeChild(el); if (parent) clearLayout(parent as Element); return {};
    }
  }
}
