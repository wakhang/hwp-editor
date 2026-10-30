import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import type { CharStyle, DocModel, Paragraph, Table } from '../../src/core/types.js';
import { diff } from '../src/diff.js';

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
  sourceFormat: 'new', revision: 0, dirty: false, sections: [{ id: 's0', page: {} as DocModel['sections'][number]['page'], paragraphs }], fonts: [], styles: [] });
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
