import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { newDocument, openDocument, OpError } from '../../src/core/index.js';

const fixtureDir = join(process.cwd(), 'fixtures/hwpx');
describe('HWPX core', () => {
  it('opens and round-trips every fixture without changing other entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-core-'));
    try {
      for (const file of (await readdir(fixtureDir)).filter(f => f.endsWith('.hwpx'))) {
        const source = join(fixtureDir, file), target = join(dir, file);
        const session = await openDocument(source);
        expect(session.model().sections.length).toBeGreaterThan(0);
        await session.save(target);
        const reopened = await openDocument(target);
        expect(reopened.outline()).toBe(session.outline());
        expect(reopened.plainText()).toBe(session.plainText());
        const zip = await readFile(target);
        expect(zip.readUInt16LE(8)).toBe(0);
        expect(zip.subarray(30, 30 + zip.readUInt16LE(26)).toString()).toBe('mimetype');
        const original = unzipSync(await readFile(source)), saved = unzipSync(zip);
        expect(Object.keys(saved).sort()).toEqual(Object.keys(original).sort());
        for (const key of Object.keys(original)) expect(saved[key]).toEqual(original[key]);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('models sample table and embedded picture', async () => {
    const tableDoc = await openDocument(join(fixtureDir, 'SimpleTable.hwpx'));
    const table = tableDoc.model().sections.flatMap(s => s.paragraphs).flatMap(p => p.anchors).find(a => a.kind === 'table');
    expect(table).toMatchObject({ kind: 'table', rowCount: 3, colCount: 3 });
    const picDoc = await openDocument(join(fixtureDir, 'SimplePicture.hwpx'));
    const pic = picDoc.model().sections.flatMap(s => s.paragraphs).flatMap(p => p.anchors).find(a => a.kind === 'object' && a.objectType === 'picture');
    expect(pic && 'binId' in pic && pic.binId).toBeTruthy();
    if (pic && 'binId' in pic && pic.binId) expect(picDoc.getBinary(pic.binId)?.mime).toMatch(/^image\/(png|jpeg)$/);
  });
  it('applies atomically and preserves ids through undo and redo', () => {
    const doc = newDocument();
    const p = doc.model().sections[0].paragraphs[0];
    const before = doc.outline();
    expect(() => doc.apply([{ op: 'setParagraph', id: p.id, runs: [{ text: 'changed' }] }, { op: 'deleteParagraph', id: 'missing' }])).toThrow(OpError);
    expect(doc.outline()).toBe(before);
    doc.apply([{ op: 'setParagraph', id: p.id, runs: [{ text: 'hello' }] }]);
    expect(doc.model().revision).toBe(1);
    expect(doc.undo()).toBe(true);
    expect(doc.outline()).toBe(before);
    expect(doc.model().sections[0].paragraphs[0].id).toBe(p.id);
    expect(doc.redo()).toBe(true);
    expect(doc.outline()).toContain('hello');
    expect(doc.model().revision).toBe(3);
  });
  it('writes styled paragraphs and tables and reopens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-edit-'));
    try {
      const doc = newDocument(), first = doc.model().sections[0].paragraphs[0].id;
      doc.apply([{ op: 'setParagraph', id: first, runs: [{ text: 'Hello', style: { bold: true, font: 'TestFont' } }] }]);
      const inserted = doc.apply([{ op: 'insertParagraph', after: first, runs: [{ text: 'World' }] }]).created[0];
      doc.apply([{ op: 'insertTable', after: inserted, rows: 2, cols: 2, data: [['a', 'b'], ['c', 'd']] }]);
      const path = join(dir, 'edited.hwpx');
      await doc.save(path);
      const reopened = await openDocument(path);
      expect(reopened.plainText()).toContain('Hello');
      expect(reopened.plainText()).toContain('World');
      expect(reopened.model().fonts).toContain('TestFont');
      expect(reopened.model().sections[0].paragraphs[0].runs[0].style.bold).toBe(true);
      expect(reopened.model().sections[0].paragraphs.flatMap(p => p.anchors).some(a => a.kind === 'table' && a.rowCount === 2 && a.colCount === 2)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('edits text, styles, alignment, cells, rows, and anchors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-ops-'));
    try {
      const doc = newDocument();
      const p = doc.model().sections[0].paragraphs[0].id;
      doc.apply([{ op: 'setParagraph', id: p, runs: [{ text: 'ab' }, { text: 'cd', style: { italic: true } }] }]);
      expect(doc.apply([{ op: 'replaceText', find: 'bc', replace: 'X' }]).replaced).toBe(1);
      expect(doc.plainText()).toBe('aXd');
      doc.apply([{ op: 'styleRange', id: p, start: 1, end: 2, style: { bold: true } }, { op: 'setAlign', id: p, align: 'center' }]);
      expect(doc.model().sections[0].paragraphs[0].align).toBe('center');
      expect(doc.model().sections[0].paragraphs[0].runs.find(r => r.text === 'X')?.style.bold).toBe(true);
      const inserted = doc.apply([{ op: 'insertParagraph', before: p, runs: [{ text: 'first' }] }]).created[0];
      doc.apply([{ op: 'deleteParagraph', id: inserted }]);
      const table = doc.apply([{ op: 'insertTable', after: p, rows: 2, cols: 2 }]).created[0];
      doc.apply([{ op: 'setCellText', tableId: table, row: 0, col: 1, text: 'line1\nline2' }, { op: 'insertRow', tableId: table, at: 1 }]);
      expect(doc.plainText()).toContain('line1\nline2');
      doc.apply([{ op: 'deleteRow', tableId: table, row: 1 }]);
      const path = join(dir, 'ops.hwpx');
      await doc.save(path);
      const reopened = await openDocument(path);
      expect(reopened.plainText()).toBe(doc.plainText());
      expect(reopened.model().sections[0].paragraphs[0].align).toBe('center');
      doc.apply([{ op: 'deleteObject', id: table }]);
      expect(doc.model().sections[0].paragraphs.flatMap(x => x.anchors).some(a => a.kind === 'table')).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
