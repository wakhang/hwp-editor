import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { converterAvailable, convertHwpToHwpx } from '../../src/convert/index.js';

const root = resolve(import.meta.dirname, '../..');
// Source-file launch needs jdk.compiler (full JDK); conversion itself uses the bundled jlink runtime.
const java = join(root, 'vendor/jdk/Contents/Home/bin/java');
const jar = join(root, 'vendor/hwp2hwpx-cli.jar');
const files = readdirSync(join(root, 'fixtures/hwp')).filter(name => name.endsWith('.hwp'))
  .map(name => join(root, 'fixtures/hwp', name));
const privateFixture = join(root, 'fixtures/private/contest.hwp');
if (existsSync(privateFixture)) files.push(privateFixture);

describe('HWP conversion', () => {
  it('reports availability', async () => {
    expect(await converterAvailable()).toEqual({ ok: true });
  });
  for (const file of files) {
    it(`converts ${file}`, async () => {
      const source = execFileSync(java, ['-cp', jar, join(root, 'test/convert/ExtractText.java'), file], { encoding: 'utf8' });
      const start = performance.now();
      const bytes = await convertHwpToHwpx(file);
      console.log(`${file}: ${Math.round(performance.now() - start)}ms`);
      if (file.endsWith('/contest.hwp')) console.log(`contest source first 200: ${source.slice(0, 200)}`);
      const zip = unzipSync(bytes);
      expect(strFromU8(zip.mimetype)).toBe('application/hwp+zip');
      expect(zip['Contents/header.xml']).toBeDefined();
      expect(zip['Contents/section0.xml']).toBeDefined();
      const section = strFromU8(zip['Contents/section0.xml']);
      const xml = new DOMParser({ onError: level => { if (level !== 'warning') throw new Error('Malformed section XML'); } }).parseFromString(section, 'application/xml');
      const text = xml.documentElement?.textContent ?? '';
      const korean = source.match(/[가-힣]{2,}/g) ?? [];
      if (korean.length) expect(korean.some(word => text.includes(word))).toBe(true);
    }, 60_000);
  }
});
