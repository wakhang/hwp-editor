import type { DocModel, Paragraph } from '../core/types.js';

export function summarizeModel(model: DocModel) {
  let paragraphs = 0;
  let tables = 0;
  const visit = (items: Paragraph[]) => {
    for (const paragraph of items) {
      paragraphs++;
      for (const anchor of paragraph.anchors) {
        if (anchor.kind !== 'table') continue;
        tables++;
        for (const row of anchor.rows) for (const cell of row) visit(cell.paragraphs);
      }
    }
  };
  for (const section of model.sections) visit(section.paragraphs);
  const { docId, path, sourcePath, sourceFormat, revision } = model;
  return { docId, path, sourcePath, sourceFormat, revision, paragraphs, tables };
}
