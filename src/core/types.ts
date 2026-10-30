// Contract shared by core, server, MCP, CLI and UI. Change only with docs/SPEC.md.
// Units: lengths in the model are millimetres (HWPUNIT = 1/7200 inch; mm = hu * 25.4 / 7200).

export type Id = string; // session-scoped, e.g. "p12", "t3", "o5", "s0". Not persisted to the file.

export type Align = 'left' | 'right' | 'center' | 'justify' | 'distribute';

export interface CharStyle {
  charPrId: number; // hh:charPr id this run uses
  font: string; // HANGUL font face, e.g. "함초롬바탕"
  sizePt: number; // charPr height / 100
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string; // "#rrggbb"
  highlight: string | null; // shadeColor "#rrggbb" or null when "none"
}

/** 글자 겹치기 (hp:compose), e.g. a checked box = circleType "SHAPE_RECTANGLE" + composeText "✓". */
export interface ComposeChar {
  composeText: string; // hp:compose composeText
  circleType: string; // hp:compose circleType, e.g. "SHAPE_RECTANGLE", "SHAPE_CIRCLE", "CHAR"
}

/**
 * Text of one hp:run. Tabs are "\t", hp:lineBreak is "\n".
 * A compose run is its own TextRun (never merged): `text` is one display string counted in offsets —
 * "☑" when circleType contains "RECTANGLE" and composeText is a check mark (✓ ✔ √ v V), otherwise composeText.
 */
export interface TextRun {
  text: string;
  style: CharStyle;
  compose?: ComposeChar;
}

export interface Paragraph {
  kind: 'p';
  id: Id;
  paraPrId: number;
  styleId: number;
  styleName: string; // hh:style name, e.g. "바탕글"
  align: Align;
  pageBreakBefore: boolean; // hp:p pageBreak="1"
  runs: TextRun[]; // text runs only, in order; controls/objects are in `anchors`
  anchors: Anchored[]; // tables/pictures/shapes anchored in this paragraph, in document order
}

/** One cell edge from hh:borderFill. */
export interface BorderLine {
  type: string; // hh:*Border type: "SOLID", "DASH", "DOT", "DOUBLE_SLIM", ... ("NONE" is reported as null)
  widthMm: number; // parsed from e.g. "0.12 mm"
  color: string; // "#rrggbb"
}

export interface TableCell {
  id: Id;
  row: number; // hp:cellAddr rowAddr
  col: number; // hp:cellAddr colAddr
  rowSpan: number;
  colSpan: number;
  widthMm: number;
  heightMm: number;
  /** Resolved from hp:tc borderFillIDRef. null edge = no line. */
  border: { top: BorderLine | null; right: BorderLine | null; bottom: BorderLine | null; left: BorderLine | null };
  background: string | null; // hc:fillBrush/hc:winBrush faceColor "#rrggbb"; null when none/transparent
  vAlign: 'top' | 'center' | 'bottom'; // hp:subList vertAlign
  paddingMm: { left: number; right: number; top: number; bottom: number }; // hp:cellMargin (table inMargin when hasMargin="0")
  paragraphs: Paragraph[]; // hp:subList paragraphs (may themselves anchor nested tables)
}

export interface Table {
  kind: 'table';
  id: Id;
  rowCount: number;
  colCount: number;
  widthMm: number;
  /** rows[r] lists the cells whose top-left is in row r (merged-over positions are absent). */
  rows: TableCell[][];
}

export interface OpaqueObject {
  kind: 'object';
  id: Id;
  objectType: 'picture' | 'shape' | 'equation' | 'header' | 'footer' | 'footnote' | 'field' | 'other';
  label: string; // human readable, e.g. "그림 (image1.png)", "수식"
  widthMm?: number;
  heightMm?: number;
  binId?: string; // picture: BinData item id, fetch via Session.getBinary
}

export type Anchored = Table | OpaqueObject;

export interface PageSetup {
  widthMm: number;
  heightMm: number;
  landscape: boolean;
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number; gutter: number };
}

export interface Section {
  id: Id;
  page: PageSetup;
  paragraphs: Paragraph[];
}

export interface DocModel {
  docId: string;
  path: string | null; // current save target (.hwpx); null for new unsaved docs
  sourcePath: string | null; // file that was opened (.hwp or .hwpx)
  sourceFormat: 'hwpx' | 'hwp' | 'new';
  revision: number; // +1 per applied op batch / undo / redo
  dirty: boolean;
  sections: Section[];
  fonts: string[]; // HANGUL font faces available in the header
  styles: { id: number; name: string }[];
}

// ---------------------------------------------------------------- ops

export interface StylePatch {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sizePt?: number;
  color?: string; // "#rrggbb"
  highlight?: string | null;
  font?: string; // HANGUL face; added to fontfaces when missing
}

/** Run to write. `base` = charPrId to start from (default: first run's charPr of the target paragraph). */
export interface RunInput {
  text: string;
  base?: number;
  style?: StylePatch;
  /** Write a 글자 겹치기 instead of plain text; `text` must be the display string from TextRun. */
  compose?: ComposeChar;
}

export type Op =
  | { op: 'setParagraph'; id: Id; runs: RunInput[] } // replace text runs, keep anchors
  | { op: 'insertParagraph'; after?: Id; before?: Id; runs?: RunInput[]; align?: Align; styleFrom?: Id } // exactly one of after/before; inherits paraPr/style from styleFrom ?? neighbour
  | { op: 'deleteParagraph'; id: Id } // deletes anchors too; last paragraph of a section/cell is cleared instead
  | { op: 'setAlign'; id: Id; align: Align }
  | { op: 'styleRange'; id: Id; start: number; end: number; style: StylePatch } // char offsets in concatenated run text
  | { op: 'replaceText'; find: string; replace: string; regex?: boolean; matchCase?: boolean; scope?: Id } // scope = paragraph/table/section id; default whole doc
  | { op: 'setCellText'; tableId: Id; row: number; col: number; text: string } // "\n" splits into paragraphs
  | { op: 'insertTable'; after: Id; rows: number; cols: number; data?: string[][] } // new paragraph after `after` anchoring the table, full text width
  | { op: 'insertRow'; tableId: Id; at: number } // copies row at-1 (or 0) formatting; rejects when merges cross
  | { op: 'deleteRow'; tableId: Id; row: number } // rejects when merges cross
  | { op: 'deleteObject'; id: Id } // removes a table/object anchor
  /**
   * Inline picture (treatAsChar). Empty paragraph `paragraph` → picture goes into it; paragraph with text → a new
   * paragraph (same paraPr/style/charPr) is inserted right after it holding only the picture (so the text line is not
   * stretched by justification). `paragraph` may be inside a table cell.
   * Exactly one of `path` (file readable by the server process) or `data` (base64). PNG, JPEG, GIF, BMP.
   * Size: widthMm/heightMm when given (one given → keep aspect); else pixels at 96 dpi.
   * Always shrunk (aspect kept) to fit the available width: cell width minus padding, or section text width.
   */
  | { op: 'insertPicture'; paragraph: Id; path?: string; data?: string; widthMm?: number; heightMm?: number };

export interface OpResult {
  revision: number;
  /** ids created by the batch, in op order (insertParagraph → paragraph id, insertTable → table id, insertPicture → object id). */
  created: Id[];
  /** replaceText: number of replacements, summed. */
  replaced: number;
}

export class OpError extends Error {
  constructor(public opIndex: number, message: string) {
    super(`op[${opIndex}]: ${message}`);
  }
}

export interface FindHit {
  paragraphId: Id;
  start: number;
  end: number;
  context: string; // paragraph text, trimmed to ~80 chars around the hit
  tableId?: Id; // when inside a table cell
  cell?: { row: number; col: number };
}

/** In-memory editable document. Implemented in src/core/session.ts. */
export interface DocSession {
  readonly docId: string;
  model(): DocModel;
  /** Atomic: all ops apply or none (state restored on OpError). */
  apply(ops: Op[]): OpResult;
  undo(): boolean;
  redo(): boolean;
  find(query: string, opts?: { regex?: boolean; matchCase?: boolean }): FindHit[];
  /** Plain text with ids, one line per paragraph: "[p12] text"; tables as "[t3 r0c1/p40] text". */
  outline(opts?: { from?: Id; limit?: number }): string;
  plainText(): string;
  getBinary(binId: string): { data: Uint8Array; mime: string } | null;
  /** Write HWPX. Default target = model().path; error when null. Updates path, clears dirty. */
  save(targetPath?: string): Promise<string>;
}
