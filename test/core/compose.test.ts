import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { newDocument, openDocument } from '../../src/core/index.js';

const checkbox = { composeText: '✓', circleType: 'SHAPE_RECTANGLE' };

describe('compose runs', () => {
  it('writes, models and round-trips compose runs in text order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-compose-'));
    try {
      const doc = newDocument(), id = doc.model().sections[0].paragraphs[0].id;
      doc.apply([{ op: 'setParagraph', id, runs: [
        { text: 'before' }, { text: '☑', compose: checkbox }, { text: 'after' },
        { text: 'ab', compose: { composeText: 'ab', circleType: 'CHAR' } },
      ] }]);
      const runs = doc.model().sections[0].paragraphs[0].runs;
      expect(runs.map(r => r.text)).toEqual(['before', '☑', 'after', 'ab']);
      expect(runs[1].compose).toEqual(checkbox);
      expect(doc.plainText()).toBe('before☑afterab');
      const path = join(dir, 'compose.hwpx');
      await doc.save(path);
      const xml = new TextDecoder().decode(unzipSync(await readFile(path))['Contents/section0.xml']);
      const compose = /<hp:run charPrIDRef="(\d+)"><hp:compose circleType="SHAPE_RECTANGLE" charSz="-3" composeType="SPREAD" charPrCnt="10" composeText="✓">([\s\S]*?)<\/hp:compose><\/hp:run>/.exec(xml);
      expect(compose).not.toBeNull();
      expect(compose![2]).toBe(`<hp:charPr prIDRef="${compose![1]}"/>` + '<hp:charPr prIDRef="4294967295"/>'.repeat(9));
      const multi = /<hp:run charPrIDRef="(\d+)"><hp:compose circleType="CHAR" charSz="-3" composeType="SPREAD" charPrCnt="10" composeText="ab">([\s\S]*?)<\/hp:compose><\/hp:run>/.exec(xml);
      expect(multi).not.toBeNull();
      expect(multi![2]).toBe(`<hp:charPr prIDRef="${multi![1]}"/>`.repeat(2) + '<hp:charPr prIDRef="4294967295"/>'.repeat(8));
      const reopened = await openDocument(path);
      expect(reopened.model().sections[0].paragraphs[0].runs.map(r => [r.text, r.compose])).toEqual(runs.map(r => [r.text, r.compose]));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('preserves unaffected compose runs when styling or replacing text using display offsets', () => {
    const doc = newDocument(), id = doc.model().sections[0].paragraphs[0].id;
    doc.apply([{ op: 'setParagraph', id, runs: [{ text: 'a' }, { text: '☑', compose: checkbox }, { text: 'bc' }] }]);
    doc.apply([{ op: 'styleRange', id, start: 1, end: 2, style: { bold: true } }]);
    let runs = doc.model().sections[0].paragraphs[0].runs;
    expect(runs.map(r => r.text)).toEqual(['a', '☑', 'bc']);
    expect(runs[1]).toMatchObject({ compose: checkbox, style: { bold: true } });
    doc.apply([{ op: 'replaceText', find: 'bc', replace: 'z' }]);
    runs = doc.model().sections[0].paragraphs[0].runs;
    expect(runs.map(r => r.text)).toEqual(['a', '☑', 'z']);
    expect(runs[1].compose).toEqual(checkbox);
    doc.apply([{ op: 'replaceText', find: '☑', replace: 'X' }]);
    expect(doc.plainText()).toBe('aXz');
    expect(doc.model().sections[0].paragraphs[0].runs.every(r => !r.compose)).toBe(true);
  });

  it('writes plain text when compose is omitted and rejects mismatched display text', () => {
    const doc = newDocument(), id = doc.model().sections[0].paragraphs[0].id;
    doc.apply([{ op: 'setParagraph', id, runs: [{ text: '☑', compose: checkbox }] }]);
    expect(() => doc.apply([{ op: 'setParagraph', id, runs: [{ text: '✓', compose: checkbox }] }])).toThrow();
    doc.apply([{ op: 'setParagraph', id, runs: [{ text: '☑' }] }]);
    expect(doc.model().sections[0].paragraphs[0].runs[0].compose).toBeUndefined();
  });
});
