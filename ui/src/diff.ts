import type { Node as PMNode } from 'prosemirror-model';
import type { Align, CharStyle, DocModel, Op, Paragraph, RunInput, StylePatch, TableCell } from '../../src/core/types.js';

export interface ParagraphDiff {
  ops: Op[];
  /** Document positions corresponding to insertParagraph operations, indexed by operation index. */
  inserted: { index: number; pos: number }[];
}

type CurrentParagraph = { node: PMNode; pos: number };

function stylePatch(style: CharStyle, base?: CharStyle): StylePatch {
  const patch: StylePatch = {};
  for (const key of ['font', 'sizePt', 'bold', 'italic', 'underline', 'strike', 'color', 'highlight'] as const) {
    if (!base || style[key] !== base[key]) Object.assign(patch, { [key]: style[key] });
  }
  return patch;
}

function runsOf(node: PMNode, styles: Map<number, CharStyle>, fallback?: CharStyle): RunInput[] {
  const runs: RunInput[] = [];
  node.forEach(child => {
    const text = child.isText ? child.text ?? '' : child.type.name === 'hard_break' ? '\n' : '';
    if (!text) return;
    const style = (child.marks.find(mark => mark.type.name === 'cs')?.attrs as CharStyle | undefined) ?? fallback;
    const patch = style && stylePatch(style, styles.get(style.charPrId));
    const run: RunInput = style ? { text, base: style.charPrId, ...(patch && Object.keys(patch).length ? { style: patch } : {}) } : { text };
    const previous = runs[runs.length - 1];
    if (previous && previous.base === run.base && JSON.stringify(previous.style) === JSON.stringify(run.style)) previous.text += text;
    else runs.push(run);
  });
  return runs;
}

function comparableRuns(node: PMNode, fallback?: CharStyle) {
  const runs: { text: string; style?: StylePatch }[] = [];
  node.forEach(child => {
    if (!child.isText || !child.text) return;
    const style = (child.marks.find(mark => mark.type.name === 'cs')?.attrs as CharStyle | undefined) ?? fallback;
    const patch = style && stylePatch(style);
    const previous = runs[runs.length - 1];
    if (previous && JSON.stringify(previous.style) === JSON.stringify(patch)) previous.text += child.text;
    else runs.push({ text: child.text, ...(patch ? { style: patch } : {}) });
  });
  return runs;
}

function comparableOriginal(paragraph: Paragraph) {
  const runs: { text: string; style: StylePatch }[] = [];
  for (const run of paragraph.runs) {
    if (!run.text) continue;
    const style = stylePatch(run.style);
    const previous = runs[runs.length - 1];
    if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) previous.text += run.text;
    else runs.push({ text: run.text, style });
  }
  return runs;
}

/** Compare the core snapshot with its edited ProseMirror representation. */
export function diff(model: DocModel, doc: PMNode): ParagraphDiff {
  const ops: Op[] = [];
  const inserted: ParagraphDiff['inserted'] = [];
  const cells = new Map<string, TableCell>();
  const styles = new Map<number, CharStyle>();
  function collectCells(paragraphs: Paragraph[]): void {
    for (const paragraph of paragraphs) {
      for (const run of paragraph.runs) styles.set(run.style.charPrId, run.style);
      for (const anchor of paragraph.anchors) {
      if (anchor.kind !== 'table') continue;
      for (const row of anchor.rows) for (const cell of row) {
        cells.set(cell.id, cell);
        collectCells(cell.paragraphs);
      }
      }
    }
  }
  for (const section of model.sections) collectCells(section.paragraphs);

  function compare(old: Paragraph[], current: CurrentParagraph[]): void {
    const originals = new Map(old.map(p => [p.id, p]));
    const retained = new Set(current.map(p => p.node.attrs.id).filter((id): id is string => typeof id === 'string' && originals.has(id)));
    for (const { node } of current) {
      const previous = originals.get(node.attrs.id);
      if (!previous) continue;
      const runs = runsOf(node, styles, previous.runs[0]?.style);
      if (JSON.stringify(comparableRuns(node, previous.runs[0]?.style)) !== JSON.stringify(comparableOriginal(previous))) ops.push({ op: 'setParagraph', id: previous.id, runs });
      if (node.attrs.align !== previous.align) ops.push({ op: 'setAlign', id: previous.id, align: node.attrs.align as Align });
    }
    for (let i = 0; i < current.length;) {
      if (current[i].node.attrs.id != null) { i++; continue; }
      let end = i + 1;
      while (end < current.length && current[end].node.attrs.id == null) end++;
      const next = current.slice(end).find(p => retained.has(p.node.attrs.id));
      const prior = current.slice(0, i).reverse().find(p => retained.has(p.node.attrs.id));
      // When all old paragraphs were replaced, insert before one that will be deleted.
      const neighbour = next?.node.attrs.id ?? prior?.node.attrs.id ?? old[0]?.id;
      if (!neighbour) throw new Error('문단을 삽입할 기준 문단이 없습니다.');
      const before = !!next || !prior;
      const group = current.slice(i, end);
      if (!before) group.reverse();
      for (const item of group) {
        const index = ops.length;
        ops.push({ op: 'insertParagraph', ...(before ? { before: neighbour } : { after: neighbour }),
          runs: runsOf(item.node, styles), align: item.node.attrs.align as Align });
        inserted.push({ index, pos: item.pos });
      }
      i = end;
    }
    for (const paragraph of old) if (!retained.has(paragraph.id)) ops.push({ op: 'deleteParagraph', id: paragraph.id });
  }

  function visitContainer(node: PMNode, pos: number, old: Paragraph[]): void {
    const paragraphs: CurrentParagraph[] = [];
    node.forEach((child, offset) => {
      const childPos = pos + 1 + offset;
      if (child.type.name === 'paragraph') paragraphs.push({ node: child, pos: childPos });
      else visitNested(child, childPos);
    });
    compare(old, paragraphs);
  }
  function visitNested(node: PMNode, pos: number): void {
    if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
      const cell = cells.get(node.attrs.id);
      if (cell) visitContainer(node, pos, cell.paragraphs);
      return;
    }
    node.forEach((child, offset) => visitNested(child, pos + 1 + offset));
  }
  let sectionIndex = 0;
  doc.forEach((section, offset) => {
    if (section.type.name !== 'section') return;
    const original = model.sections[sectionIndex++];
    if (original) visitContainer(section, offset, original.paragraphs);
  });
  return { ops, inserted };
}
