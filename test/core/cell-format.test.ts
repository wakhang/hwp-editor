import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { Header } from '../../src/core/header.js';
import { buildSections } from '../../src/core/model.js';
import { Registry } from '../../src/core/registry.js';

const parser = new DOMParser();
const headerXml = `<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
  <hh:borderFills itemCnt="2">
    <hh:borderFill id="1"><hh:topBorder type="SOLID" width="0.12 mm" color="#123456"/><hh:rightBorder type="DASH" width="0.5 mm" color="#abcdef"/><hh:bottomBorder type="NONE"/><hh:leftBorder type="DOT" width="0.2 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="#ffcc00"/></hc:fillBrush></hh:borderFill>
    <hh:borderFill id="2"><hc:fillBrush><hc:winBrush faceColor="none"/></hc:fillBrush></hh:borderFill>
  </hh:borderFills>
</hh:head>`;
const sectionXml = `<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p><hp:run><hp:tbl rowCnt="1" colCnt="3"><hp:inMargin left="7200" right="3600" top="0" bottom="720"/><hp:tr>
    <hp:tc borderFillIDRef="1" hasMargin="1"><hp:subList vertAlign="BOTTOM"/><hp:cellAddr rowAddr="0" colAddr="0"/><hp:cellMargin left="720" right="1440" top="2160" bottom="2880"/></hp:tc>
    <hp:tc borderFillIDRef="2" hasMargin="0"><hp:subList vertAlign="CENTER"/><hp:cellAddr rowAddr="0" colAddr="1"/><hp:cellMargin left="1"/></hp:tc>
    <hp:tc borderFillIDRef="999" hasMargin="1"><hp:subList/><hp:cellAddr rowAddr="0" colAddr="2"/></hp:tc>
  </hp:tr></hp:tbl></hp:run></hp:p>
</hp:sec>`;

describe('table cell formatting', () => {
  it('resolves borders, backgrounds, alignment and inherited or local margins', () => {
    const header = new Header(parser.parseFromString(headerXml, 'application/xml'));
    const section = parser.parseFromString(sectionXml, 'application/xml');
    const table = buildSections([section], header, new Registry([section]))[0].paragraphs[0].anchors[0];
    if (table.kind !== 'table') throw new Error('expected table');
    const [first, second, third] = table.rows[0];
    expect(first.border).toEqual({ top: { type: 'SOLID', widthMm: 0.12, color: '#123456' }, right: { type: 'DASH', widthMm: 0.5, color: '#abcdef' }, bottom: null, left: { type: 'DOT', widthMm: 0.2, color: '#000000' } });
    expect(first.background).toBe('#ffcc00');
    expect(first.paddingMm.left).toBeCloseTo(2.54);
    expect(first.paddingMm.right).toBeCloseTo(5.08);
    expect(first.paddingMm.top).toBeCloseTo(7.62);
    expect(first.paddingMm.bottom).toBeCloseTo(10.16);
    expect(first.vAlign).toBe('bottom');
    expect(second.border).toEqual({ top: null, right: null, bottom: null, left: null });
    expect(second.background).toBeNull();
    expect(second.paddingMm.left).toBeCloseTo(25.4);
    expect(second.paddingMm.right).toBeCloseTo(12.7);
    expect(second.paddingMm.top).toBe(0);
    expect(second.paddingMm.bottom).toBeCloseTo(2.54);
    expect(second.vAlign).toBe('center');
    expect(third).toMatchObject({ background: null, vAlign: 'top', border: { top: null, right: null, bottom: null, left: null }, paddingMm: { left: 0, right: 0, top: 0, bottom: 0 } });
  });

  it('registers newly created border fills immediately', () => {
    const header = new Header(parser.parseFromString(headerXml, 'application/xml'));
    const id = header.ensureBorderFill();
    expect(header.borderFills.get(id)?.border.top).toEqual({ type: 'SOLID', widthMm: 0.1, color: '#000000' });
  });
});
