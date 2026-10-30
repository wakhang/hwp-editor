import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import type { CharStyle, DocModel, Paragraph, Table } from '../../src/core/types.js';
import { diff } from '../src/diff.js';
import { modelToDoc, schema as editorSchema } from '../src/model.js';

const style: CharStyle = { charPrId: 1, font: '바탕', sizePt: 10, bold: false, italic: false,
  underline: false, strike: false, color: '#000000', highlight: null };
const schema = new Schema({
  nodes: {
    doc: { content: 'section+' },
    section: { content: '(paragraph | table)*', attrs: { id: { default: null } } },
    paragraph: { content: 'text*', attrs: { id: { default: null }, align: { default: 'left' } } },
    table: { content: 'table_row+' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph+', attrs: { id: { default: null } } },
    text: {},
  },
  marks: { cs: { attrs: Object.fromEntries(Object.keys(style).map(key => [key, {}])) } },
});
const paragraph = (id: string, text: string): Paragraph => ({ kind: 'p', id, paraPrId: 0, styleId: 0,
  styleName: '', align: 'left', pageBreakBefore: false, runs: [{ text, style }], anchors: [] });
const model = (paragraphs: Paragraph[]): DocModel => ({ docId: 'd', path: null, sourcePath: null,
  sourceFormat: 'new', revision: 0, dirty: false, sections: [{ id: 's0', page: { widthMm: 210, heightMm: 297, landscape: false,
    margins: { left: 0, right: 0, top: 0, bottom: 0, header: 0, footer: 0, gutter: 0 } }, paragraphs }], fonts: [], styles: [] });
const p = (id: string | null, text: string, attrs: Partial<CharStyle> = {}) => schema.node('paragraph', { id }, text ? [schema.text(text, [schema.mark('cs', { ...style, ...attrs })])] : []);
const doc = (...children: PMNode[]) => schema.node('doc', null, [schema.node('section', { id: 's0' }, children)]);

describe('paragraph diff', () => {
  it('writes edited text without changing its style', () => {
    const result = diff(model([paragraph('p1', '안녕')]), doc(p('p1', '안녕하세요')));
    expect(result.ops).toEqual([{ op: 'setParagraph', id: 'p1', runs: [{ text: '안녕하세요', base: 1 }] }]);
    expect(result.inserted).toEqual([]);
  });

  it('splits a paragraph and reports the new paragraph position', () => {
    const result = diff(model([paragraph('p1', 'abcd')]), doc(p('p1', 'ab'), p(null, 'cd')));
    expect(result.ops).toEqual([
      expect.objectContaining({ op: 'setParagraph', id: 'p1' }),
      expect.objectContaining({ op: 'insertParagraph', after: 'p1', runs: [expect.objectContaining({ text: 'cd' })] }),
    ]);
    expect(result.inserted).toEqual([{ index: 1, pos: 5 }]);
  });

  it('sends formatting changes as run styles', () => {
    const result = diff(model([paragraph('p1', '굵게')]), doc(p('p1', '굵게', { bold: true })));
    expect(result.ops).toEqual([{ op: 'setParagraph', id: 'p1', runs: [expect.objectContaining({ text: '굵게', style: expect.objectContaining({ bold: true }) })] }]);
  });

  it('deletes removed paragraphs', () => {
    const result = diff(model([paragraph('p1', '하나'), paragraph('p2', '둘')]), doc(p('p1', '하나')));
    expect(result.ops).toEqual([{ op: 'deleteParagraph', id: 'p2' }]);
  });

  it('inserts consecutive new paragraphs in document order', () => {
    const result = diff(model([paragraph('p1', 'a')]), doc(p('p1', 'a'), p(null, 'b'), p(null, 'c')));
    expect(result.ops.map(op => op.op === 'insertParagraph' && [op.after, op.runs?.[0].text])).toEqual([['p1', 'c'], ['p1', 'b']]);
    expect(result.inserted).toEqual([{ index: 0, pos: 7 }, { index: 1, pos: 4 }]);
  });

  it('diffs paragraphs inside table cells independently', () => {
    const host = paragraph('p1', '');
    host.anchors = [{ kind: 'table', id: 't1', rowCount: 1, colCount: 1, widthMm: 10,
      rows: [[{ id: 'c1', row: 0, col: 0, rowSpan: 1, colSpan: 1, widthMm: 10, heightMm: 10, paragraphs: [paragraph('p2', '셀')] }]] } as Table];
    const table = schema.node('table', null, [schema.node('table_row', null, [schema.node('table_cell', { id: 'c1' }, [p('p2', '변경')])])]);
    const edited = schema.node('doc', null, [schema.node('section', { id: 's0' }, [p('p1', ''), table])]);
    expect(diff(model([host]), edited).ops).toEqual([expect.objectContaining({ op: 'setParagraph', id: 'p2' })]);
  });
});

describe('form rendering and sync', () => {
  it('keeps compose atoms in order when editing and removes them when deleted', () => {
    const source = paragraph('p1', '');
    const compose = { composeText: '✓', circleType: 'SHAPE_RECTANGLE' };
    source.runs = [{ text: '☑', compose, style }, { text: ' 개인', style }];
    const snapshot = model([source]);
    const original = modelToDoc(snapshot);
    expect(diff(snapshot, original).ops).toEqual([]);
    const pNode = original.firstChild!.firstChild!;
    expect(pNode.firstChild!.type.name).toBe('compose');
    expect(editorSchema.nodes.compose.spec.toDOM!(pNode.firstChild!)).toEqual(
      ['span', expect.objectContaining({ class: 'hwp-compose', contenteditable: 'false' }), '☑']);
    const edited = original.copy(original.content.replaceChild(0, original.firstChild!.copy(
      original.firstChild!.content.replaceChild(0, pNode.copy(pNode.content.addToEnd(
        editorSchema.text(' 추가', [editorSchema.marks.cs.create(style)])))))));
    expect(diff(snapshot, edited).ops).toEqual([{ op: 'setParagraph', id: 'p1', runs: [
      { text: '☑', compose, base: 1 }, { text: ' 개인 추가', base: 1 },
    ] }]);
    const removed = original.copy(original.content.replaceChild(0, original.firstChild!.copy(
      original.firstChild!.content.replaceChild(0, pNode.copy(pNode.content.cut(1))))));
    expect(diff(snapshot, removed).ops).toEqual([{ op: 'setParagraph', id: 'p1', runs: [{ text: ' 개인', base: 1 }] }]);
  });

  it('maps cell borders, fill, alignment, padding and dimensions to DOM styles', () => {
    const host = paragraph('p1', '');
    host.anchors = [{ kind: 'table', id: 't1', rowCount: 1, colCount: 1, widthMm: 40, rows: [[{
      id: 'c1', row: 0, col: 0, rowSpan: 1, colSpan: 1, widthMm: 40, heightMm: 12,
      border: { top: { type: 'SOLID', widthMm: 0.05, color: '#123456' }, right: { type: 'DASH_DOT', widthMm: 0.2, color: '#abcdef' },
        bottom: { type: 'DOUBLE_SLIM', widthMm: 0.3, color: '#000000' }, left: null },
      background: '#eeeeee', vAlign: 'center', paddingMm: { top: 1, right: 2, bottom: 3, left: 4 }, paragraphs: [paragraph('p2', '셀')],
    }]] }];
    const cell = modelToDoc(model([host])).firstChild!.child(1).firstChild!.firstChild!;
    const dom = editorSchema.nodes.table_cell.spec.toDOM!(cell) as [string, { style: string }, number];
    expect(dom[1].style).toContain('width: 40mm');
    expect(dom[1].style).toContain('border-top: 0.1mm solid #123456');
    expect(dom[1].style).toContain('border-right: 0.2mm dashed #abcdef');
    expect(dom[1].style).toContain('border-bottom: max(0.3mm, 3px) double #000000');
    expect(dom[1].style).toContain('border-left: none');
    expect(dom[1].style).toContain('background-color: #eeeeee');
    expect(dom[1].style).toContain('vertical-align: middle');
    expect(dom[1].style).toContain('padding: 1mm 2mm 3mm 4mm');
    expect(dom[1].style).toContain('min-height: 12mm');
  });
});
