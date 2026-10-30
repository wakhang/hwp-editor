import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { newDocument, openDocument } from '../../src/core/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');

describe('insertPicture', () => {
  it('inserts, exposes, saves and reopens binary data with undo and redo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-picture-'));
    try {
      const doc = newDocument(), paragraph = doc.model().sections[0].paragraphs[0].id;
      const id = doc.apply([{ op: 'insertPicture', paragraph, data: png.toString('base64'), widthMm: 40 }]).created[0];
      expect(doc.model().sections[0].paragraphs).toHaveLength(1);
      const object = doc.model().sections[0].paragraphs[0].anchors[0];
      expect(object).toMatchObject({ kind: 'object', id, objectType: 'picture', widthMm: expect.closeTo(40, 1), heightMm: expect.closeTo(40, 1) });
      if (object.kind !== 'object' || !object.binId) throw new Error('Missing picture binary');
      expect(doc.getBinary(object.binId)).toEqual({ data: png, mime: 'image/png' });
      expect(doc.outline()).toContain(`[${id} ${object.label} 40×40mm]`);
      expect(doc.undo()).toBe(true);
      expect(doc.getBinary(object.binId)).toBeNull();
      expect(doc.model().dirty).toBe(false);
      expect(doc.redo()).toBe(true);
      expect(doc.model().sections[0].paragraphs[0].anchors[0].id).toBe(id);
      const target = join(dir, 'picture.hwpx'); await doc.save(target);
      const entries = unzipSync(await readFile(target));
      expect(entries[`BinData/${object.binId}.png`]).toEqual(new Uint8Array(png));
      expect(new TextDecoder().decode(entries['Contents/content.hpf'])).toContain(`<opf:item id="${object.binId}" href="BinData/${object.binId}.png" media-type="image/png" isEmbeded="1"/>`);
      const reopened = await openDocument(target);
      const picture = reopened.model().sections[0].paragraphs[0].anchors[0];
      expect(picture).toMatchObject({ kind: 'object', objectType: 'picture', binId: object.binId });
      expect(reopened.getBinary(object.binId)?.data).toEqual(new Uint8Array(png));
      expect(doc.undo()).toBe(true); expect(doc.model().dirty).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('inserts a picture-only paragraph after text, preserving formatting and undoing the paragraph', async () => {
    const doc = newDocument(), first = doc.model().sections[0].paragraphs[0];
    const id = doc.apply([{ op: 'insertParagraph', after: first.id, runs: [{ text: '☑', compose: { circleType: 'SHAPE_RECTANGLE', composeText: '✓' }, style: { bold: true } }] }]).created[0];
    const original = doc.model().sections[0].paragraphs[1];
    const result = doc.apply([{ op: 'insertPicture', paragraph: id, data: png.toString('base64') }]);
    const paragraphs = doc.model().sections[0].paragraphs;
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[1].runs[0].text).toBe('☑');
    expect(paragraphs[1].anchors).toHaveLength(0);
    expect(paragraphs[2]).toMatchObject({ paraPrId: original.paraPrId, styleId: original.styleId });
    expect(paragraphs[2].id).not.toBe(original.id);
    expect(paragraphs[2].runs.every(run => run.text === '')).toBe(true);
    expect(paragraphs[2].anchors[0].id).toBe(result.created[0]);
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-picture-paragraph-'));
    try {
      const path = join(dir, 'picture.hwpx');
      await doc.save(path);
      const xml = new TextDecoder().decode(unzipSync(await readFile(path))['Contents/section0.xml']);
      expect(xml).toContain(`<hp:run charPrIDRef="${original.runs[0].style.charPrId}"><hp:pic`);
    } finally { await rm(dir, { recursive: true, force: true }); }
    expect(doc.undo()).toBe(true);
    expect(doc.model().sections[0].paragraphs).toHaveLength(2);
    expect(doc.redo()).toBe(true);
    expect(doc.model().sections[0].paragraphs[2].anchors[0].id).toBe(result.created[0]);
  });
  it('fits pictures inside cells and loads from a path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-picture-cell-'));
    try {
      const path = join(dir, 'image.png'); await writeFile(path, png);
      const doc = newDocument(), p = doc.model().sections[0].paragraphs[0].id;
      doc.apply([{ op: 'insertTable', after: p, rows: 1, cols: 2 }]);
      const table = doc.model().sections[0].paragraphs.flatMap(x => x.anchors).find(x => x.kind === 'table');
      if (!table || table.kind !== 'table') throw new Error('Missing table');
      const cell = table.rows[0][0];
      doc.apply([{ op: 'insertPicture', paragraph: cell.paragraphs[0].id, path, widthMm: 1000, heightMm: 500 }]);
      const current = doc.model().sections[0].paragraphs.flatMap(x => x.anchors).find(x => x.kind === 'table');
      if (!current || current.kind !== 'table') throw new Error('Missing table');
      const pic = current.rows[0][0].paragraphs[0].anchors[0];
      if (pic.kind !== 'object' || pic.widthMm === undefined || pic.heightMm === undefined) throw new Error('Missing picture dimensions');
      expect(pic.widthMm).toBeLessThanOrEqual(cell.widthMm - cell.paddingMm.left - cell.paddingMm.right + 0.004);
      expect(pic.widthMm / pic.heightMm).toBeCloseTo(2, 2);
      expect(doc.outline()).toContain(`${table.id} r0c0/`);
      expect(doc.outline()).toContain(`[${pic.id} ${pic.label}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('detects JPEG, GIF and BMP dimensions and preserves aspect when height is supplied', () => {
    const gif = Buffer.from('47494638396120001000', 'hex');
    const bmp = Buffer.alloc(26); bmp.write('BM'); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(32, 18); bmp.writeInt32LE(-16, 22);
    const jpeg = Buffer.from('ffd8ffc0000b080010002001011100ffd9', 'hex');
    for (const [data, mime] of [[gif, 'image/gif'], [bmp, 'image/bmp'], [jpeg, 'image/jpeg']] as const) {
      const doc = newDocument(), paragraph = doc.model().sections[0].paragraphs[0].id;
      doc.apply([{ op: 'insertPicture', paragraph, data: data.toString('base64'), heightMm: 20 }]);
      const picture = doc.model().sections[0].paragraphs[0].anchors[0];
      if (picture.kind !== 'object' || !picture.binId) throw new Error('Missing picture');
      expect(picture.widthMm).toBeCloseTo(40, 1);
      expect(picture.heightMm).toBeCloseTo(20, 1);
      expect(doc.getBinary(picture.binId)?.mime).toBe(mime);
    }
  });
  it('rolls back binary additions on failure and rejects invalid inputs', () => {
    const doc = newDocument(), paragraph = doc.model().sections[0].paragraphs[0].id;
    expect(() => doc.apply([{ op: 'insertPicture', paragraph, data: png.toString('base64') }, { op: 'deleteParagraph', id: 'bad' }])).toThrow();
    expect(doc.getBinary('image1')).toBeNull();
    expect(doc.model().dirty).toBe(false);
    for (const data of ['', 'invalid!', Buffer.from('not an image').toString('base64')]) expect(() => doc.apply([{ op: 'insertPicture', paragraph, data }])).toThrow();
    expect(() => doc.apply([{ op: 'insertPicture', paragraph, data: png.toString('base64'), widthMm: 0 }])).toThrow();
    expect(doc.apply([{ op: 'insertPicture', paragraph, data: png.toString('base64') }]).created).toHaveLength(1);
  });
});
