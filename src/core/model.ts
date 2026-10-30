import type { Document, Element, Node } from '@xmldom/xmldom';
import type { Header } from './header.js';
import type { Registry } from './registry.js';
import type { Anchored, CharStyle, OpaqueObject, PageSetup, Paragraph, Section, Table, TableCell, TextRun } from './types.js';

const MM = 25.4 / 7200;
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';

function children(parent: Node, name?: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const el = node as Element;
      if (!name || (el.localName === name && el.namespaceURI === HP)) result.push(el);
    }
  }
  return result;
}
function child(parent: Node, name: string): Element | undefined {
  return children(parent, name)[0];
}
function descendant(parent: Element, name: string): Element | undefined {
  const nodes = parent.getElementsByTagNameNS(HP, name);
  return nodes.length ? nodes.item(0) ?? undefined : undefined;
}
function number(el: Element | undefined, attr: string, fallback = 0): number {
  const value = el?.getAttribute(attr);
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function mm(el: Element | undefined, attr: string): number { return number(el, attr) * MM; }

const defaultStyle: CharStyle = { charPrId: 0, font: '', sizePt: 10, bold: false, italic: false, underline: false, strike: false, color: '#000000', highlight: null };

function pageSetup(root: Element): PageSetup {
  const page = descendant(root, 'pagePr');
  const margin = page && child(page, 'margin');
  return {
    widthMm: mm(page, 'width'), heightMm: mm(page, 'height'),
    landscape: page?.getAttribute('landscape') === 'NARROWLY',
    margins: { left: mm(margin, 'left'), right: mm(margin, 'right'), top: mm(margin, 'top'), bottom: mm(margin, 'bottom'), header: mm(margin, 'header'), footer: mm(margin, 'footer'), gutter: mm(margin, 'gutter') },
  };
}

const objectTypes: Record<string, [OpaqueObject['objectType'], string]> = {
  pic: ['picture', '그림'], equation: ['equation', '수식'],
  header: ['header', '머리말'], footer: ['footer', '꼬리말'],
  footNote: ['footnote', '각주'], endNote: ['footnote', '미주'],
  fieldBegin: ['field', '필드'],
  container: ['shape', '도형'], line: ['shape', '도형'], rect: ['shape', '도형'],
  ellipse: ['shape', '도형'], arc: ['shape', '도형'], polygon: ['shape', '도형'],
  curve: ['shape', '도형'], connectLine: ['shape', '도형'], textart: ['shape', '글맵시'],
  ole: ['shape', '개체'], chart: ['other', '차트'], video: ['other', '동영상'],
};

export function buildSections(sectionDocs: Document[], header: Header, registry: Registry): Section[] {
  function object(el: Element): OpaqueObject {
    const [objectType, baseLabel] = objectTypes[el.localName ?? ''] ?? ['other', '개체'];
    const size = child(el, 'sz') ?? child(el, 'curSz');
    const image = el.getElementsByTagNameNS('http://www.hancom.co.kr/hwpml/2011/core', 'img').item(0);
    const binId = image?.getAttribute('binaryItemIDRef') || undefined;
    const result: OpaqueObject = { kind: 'object', id: registry.id(el, 'o'), objectType, label: binId ? `${baseLabel} (${binId})` : baseLabel };
    if (size?.hasAttribute('width')) result.widthMm = mm(size, 'width');
    if (size?.hasAttribute('height')) result.heightMm = mm(size, 'height');
    if (binId) result.binId = binId;
    return result;
  }

  function table(el: Element): Table {
    const id = registry.id(el, 't');
    const rowCount = number(el, 'rowCnt');
    const colCount = number(el, 'colCnt');
    const rows: TableCell[][] = Array.from({ length: rowCount }, () => []);
    for (const [rowIndex, tr] of children(el, 'tr').entries()) {
      for (const [colIndex, tc] of children(tr, 'tc').entries()) {
        const addr = child(tc, 'cellAddr'), span = child(tc, 'cellSpan'), size = child(tc, 'cellSz');
        const row = number(addr, 'rowAddr', rowIndex), col = number(addr, 'colAddr', colIndex);
        const cellId = registry.id(tc, 'c');
        const subList = child(tc, 'subList');
        const cell: TableCell = { id: cellId, row, col, rowSpan: number(span, 'rowSpan', 1), colSpan: number(span, 'colSpan', 1), widthMm: mm(size, 'width'), heightMm: mm(size, 'height'), paragraphs: subList ? children(subList, 'p').map(paragraph) : [] };
        while (rows.length <= row) rows.push([]);
        rows[row].push(cell);
      }
    }
    return { kind: 'table', id, rowCount, colCount, widthMm: mm(child(el, 'sz'), 'width'), rows };
  }

  function paragraph(el: Element): Paragraph {
    const id = registry.id(el, 'p');
    const paraPrId = number(el, 'paraPrIDRef'), styleId = number(el, 'styleIDRef');
    const runs: TextRun[] = [], anchors: Anchored[] = [];
    for (const run of children(el, 'run')) {
      const charPrId = number(run, 'charPrIDRef');
      const style = header.styles.get(charPrId) ?? { ...defaultStyle, charPrId };
      let text = '', hasText = false;
      function visit(node: Node, inText: boolean): void {
        if (node.nodeType === 3 || node.nodeType === 4) {
          if (inText) text += node.nodeValue ?? '';
          return;
        }
        if (node.nodeType !== 1) return;
        const current = node as Element;
        const name = current.localName ?? '';
        if (current.namespaceURI === HP) {
          if (name === 'tbl') { anchors.push(table(current)); return; }
          if (objectTypes[name]) { anchors.push(object(current)); return; }
          if (name === 'secPr' || name === 'linesegarray') return;
          if (name === 'tab') { text += '\t'; hasText = true; return; }
          if (name === 'lineBreak') { text += '\n'; hasText = true; return; }
          if (name === 't') { inText = true; hasText = true; }
        }
        for (let n = current.firstChild; n; n = n.nextSibling) visit(n, inText);
      }
      for (let n = run.firstChild; n; n = n.nextSibling) visit(n, false);
      if (hasText) {
        const previous = runs[runs.length - 1];
        if (previous?.style.charPrId === charPrId) previous.text += text;
        else runs.push({ text, style });
      }
    }
    return { kind: 'p', id, paraPrId, styleId, styleName: header.styleNames.get(styleId) ?? '', align: header.paraAlign.get(paraPrId) ?? 'left', pageBreakBefore: el.getAttribute('pageBreak') === '1', runs, anchors };
  }

  return sectionDocs.map(doc => {
    const root = doc.documentElement;
    if (!root) throw new Error('Section XML has no document element');
    return { id: registry.id(root, 's'), page: pageSetup(root), paragraphs: children(root, 'p').map(paragraph) };
  });
}
