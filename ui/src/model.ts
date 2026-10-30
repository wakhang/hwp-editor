import { Schema, type DOMOutputSpec, type MarkSpec, type Node as ProseMirrorNode, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import type { CharStyle, DocModel, OpaqueObject, PageSetup, Paragraph, Table, TableCell } from '../../src/core/types.js';

/** Resolve a BinData id to an authenticated URL suitable for an image element. */
export type ImageUrl = (binId: string) => string;

const charStyleDefaults: CharStyle = {
  charPrId: 0, font: '', sizePt: 10, bold: false, italic: false,
  underline: false, strike: false, color: '#000000', highlight: null,
};

const cs: MarkSpec = {
  attrs: Object.fromEntries(Object.entries(charStyleDefaults).map(([key, value]) => [key, { default: value }])),
  parseDOM: [{ tag: 'span[data-char-style]', getAttrs: dom => {
    try { return JSON.parse((dom as HTMLElement).getAttribute('data-char-style') || '{}'); }
    catch { return false; }
  } }],
  toDOM(mark): DOMOutputSpec {
    const s = mark.attrs as CharStyle;
    const decorations = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ');
    const family = ['함초롬바탕', '바탕', '명조'].includes(s.font) ? '"AppleMyungjo", serif' : '"Apple SD Gothic Neo", sans-serif';
    const style = [
      `font-family: ${family}`,
      `font-size: ${s.sizePt}pt`,
      s.bold && 'font-weight: bold',
      s.italic && 'font-style: italic',
      decorations && `text-decoration: ${decorations}`,
      s.color && `color: ${s.color}`,
      s.highlight && `background-color: ${s.highlight}`,
      'white-space: pre-wrap',
    ].filter(Boolean).join('; ');
    return ['span', { 'data-char-style': JSON.stringify(s), title: s.font, style }, 0];
  },
};

function pageStyle(page: PageSetup | null): string {
  if (!page) return '';
  const m = page.margins;
  return `box-sizing: border-box; width: ${page.widthMm}mm; min-height: ${page.heightMm}mm; padding: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`;
}

const section: NodeSpec = {
  content: 'block+',
  attrs: { id: { default: null }, page: { default: null } },
  parseDOM: [{ tag: 'section[data-section-id]', getAttrs: dom => {
    const el = dom as HTMLElement;
    let page: PageSetup | null = null;
    try { page = JSON.parse(el.getAttribute('data-page') || 'null'); } catch { /* external HTML */ }
    return { id: el.getAttribute('data-section-id'), page };
  } }],
  toDOM(node): DOMOutputSpec {
    return ['section', { 'data-section-id': node.attrs.id, 'data-page': JSON.stringify(node.attrs.page), style: pageStyle(node.attrs.page) }, 0];
  },
};

const paragraph: NodeSpec = {
  group: 'block', content: 'inline*',
  attrs: {
    id: { default: null }, align: { default: 'left' }, paraPrId: { default: null },
    styleId: { default: null }, styleName: { default: '' }, pageBreakBefore: { default: false },
  },
  parseDOM: [{ tag: 'p', getAttrs: dom => {
    const el = dom as HTMLElement;
    const numberAttr = (name: string) => el.hasAttribute(name) ? Number(el.getAttribute(name)) : null;
    return { id: el.getAttribute('data-paragraph-id'), align: el.getAttribute('data-align') || 'left',
      paraPrId: numberAttr('data-para-pr-id'), styleId: numberAttr('data-style-id'),
      styleName: el.getAttribute('data-style-name') || '', pageBreakBefore: el.getAttribute('data-page-break-before') === 'true' };
  } }],
  toDOM(node): DOMOutputSpec {
    const a = node.attrs;
    return ['p', { 'data-paragraph-id': a.id, 'data-align': a.align, 'data-para-pr-id': a.paraPrId,
      'data-style-id': a.styleId, 'data-style-name': a.styleName, 'data-page-break-before': String(a.pageBreakBefore),
      style: `text-align: ${a.align === 'distribute' ? 'justify' : a.align}; white-space: pre-wrap` }, 0];
  },
};

const objectAttrs = {
  id: { default: null }, anchorId: { default: null }, objectType: { default: 'other' },
  label: { default: '' }, widthMm: { default: null }, heightMm: { default: null }, binId: { default: null },
};

function objectDOMAttrs(attrs: Record<string, unknown>): Record<string, string> {
  return { 'data-object': JSON.stringify(attrs), contenteditable: 'false' };
}

function parseObject(dom: HTMLElement): Record<string, unknown> | false {
  try { return JSON.parse(dom.getAttribute('data-object') || '{}'); } catch { return false; }
}

const opaqueObject: NodeSpec = {
  group: 'block', atom: true, selectable: true, attrs: objectAttrs,
  parseDOM: [{ tag: 'div[data-hwp-object]', getAttrs: dom => parseObject(dom as HTMLElement) }],
  toDOM(node): DOMOutputSpec {
    return ['div', { ...objectDOMAttrs(node.attrs), 'data-hwp-object': '', class: 'hwp-object' }, node.attrs.label || '개체'];
  },
};

const image: NodeSpec = {
  group: 'block', atom: true, selectable: true,
  attrs: { ...objectAttrs, src: { default: null } },
  parseDOM: [{ tag: 'div[data-hwp-image]', getAttrs: dom => parseObject(dom as HTMLElement) }],
  toDOM(node): DOMOutputSpec {
    const a = node.attrs;
    const attrs = { ...objectDOMAttrs(a), 'data-hwp-image': '', class: 'hwp-image' };
    if (!a.src) return ['div', attrs, a.label || '그림'];
    const style = [a.widthMm != null && `width: ${a.widthMm}mm`, a.heightMm != null && `height: ${a.heightMm}mm`].filter(Boolean).join('; ');
    return ['div', attrs, ['img', { src: a.src, alt: a.label || '그림', style }]];
  },
};

const cells = tableNodes({
  tableGroup: 'block', cellContent: 'block+',
  cellAttributes: {
    id: { default: null }, row: { default: null }, col: { default: null },
    widthMm: { default: null, setDOMAttr(value, attrs) { if (value != null) attrs.style = `${attrs.style ?? ''}width: ${value}mm;`; } }, heightMm: { default: null },
  },
});

// Tables are anchored to a paragraph, independently of the editable cell contents.
cells.table = { ...cells.table, attrs: { id: { default: null }, anchorId: { default: null }, widthMm: { default: null }, rowCount: { default: null }, colCount: { default: null } },
  toDOM(node): DOMOutputSpec {
    return ['table', { 'data-table-id': node.attrs.id, 'data-anchor-id': node.attrs.anchorId,
      style: node.attrs.widthMm != null ? `width: ${node.attrs.widthMm}mm` : '' }, ['tbody', 0]];
  },
};

export const schema = new Schema({
  nodes: { doc: { content: 'section+' }, section, paragraph, text: { group: 'inline' }, ...cells, opaque_object: opaqueObject, image },
  marks: { cs },
});

/** Convert one model paragraph and its anchored blocks, preserving anchor order. */
export function paragraphToNodes(paragraphModel: Paragraph, imageUrl?: ImageUrl): ProseMirrorNode[] {
  const { id, align, paraPrId, styleId, styleName, pageBreakBefore } = paragraphModel;
  const content = paragraphModel.runs.filter(run => run.text.length > 0).map(run =>
    schema.text(run.text, [schema.marks.cs.create(run.style)]));
  const p = schema.nodes.paragraph.create({ id, align, paraPrId, styleId, styleName, pageBreakBefore }, content);
  return [p, ...paragraphModel.anchors.map(anchor => anchor.kind === 'table'
    ? tableToNode(anchor, id, imageUrl) : objectToNode(anchor, id, imageUrl))];
}

function cellToNode(cell: TableCell, imageUrl?: ImageUrl): ProseMirrorNode {
  const content = cell.paragraphs.flatMap(p => paragraphToNodes(p, imageUrl));
  return schema.nodes.table_cell.create({ id: cell.id, row: cell.row, col: cell.col,
    colspan: cell.colSpan, rowspan: cell.rowSpan, widthMm: cell.widthMm, heightMm: cell.heightMm },
    content.length ? content : [schema.nodes.paragraph.create()]);
}

export function tableToNode(table: Table, anchorId: string, imageUrl?: ImageUrl): ProseMirrorNode {
  const rows = table.rows.map(row => schema.nodes.table_row.create(null,
    [...row].sort((a, b) => a.col - b.col).map(cell => cellToNode(cell, imageUrl))));
  return schema.nodes.table.create({ id: table.id, anchorId, widthMm: table.widthMm,
    rowCount: table.rowCount, colCount: table.colCount }, rows);
}

export function objectToNode(object: OpaqueObject, anchorId: string, imageUrl?: ImageUrl): ProseMirrorNode {
  const attrs = { id: object.id, anchorId, objectType: object.objectType, label: object.label,
    widthMm: object.widthMm ?? null, heightMm: object.heightMm ?? null, binId: object.binId ?? null };
  return object.objectType === 'picture'
    ? schema.nodes.image.create({ ...attrs, src: object.binId && imageUrl ? imageUrl(object.binId) : null })
    : schema.nodes.opaque_object.create(attrs);
}

/** Build a fresh ProseMirror document without mutating the core model. */
export function modelToDoc(model: DocModel, imageUrl?: ImageUrl): ProseMirrorNode {
  const sections = model.sections.map(sectionModel => {
    const content = sectionModel.paragraphs.flatMap(p => paragraphToNodes(p, imageUrl));
    return schema.nodes.section.create({ id: sectionModel.id, page: sectionModel.page },
      content.length ? content : [schema.nodes.paragraph.create()]);
  });
  return schema.nodes.doc.create(null, sections.length ? sections : [schema.nodes.section.create(null, [schema.nodes.paragraph.create()])]);
}
