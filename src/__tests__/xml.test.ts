import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultToolset, resetToolsets } from '../tools/index.js';
import { escapeXml } from '../xml/build.js';
import { parseXml, XmlParseError } from '../xml/parse.js';
import {
  FAKE_XML_PASSWORD,
  FAKE_XML_USER,
  XML_ENV,
  XML_URL,
  mockDandh,
  postedXml,
  setEnv,
  textOf,
  xmlResponse,
  xmlRoute,
} from './helpers.js';
import { FAILURE_RESPONSE, HTML_RESPONSE, ITEM_INQUIRY_RESPONSE, ORDER_STATUS_RESPONSE, PRICE_AVAILABILITY_RESPONSE } from './xml-fixtures.js';

beforeEach(() => {
  setEnv(XML_ENV);
  resetToolsets();
});
afterEach(() => vi.unstubAllGlobals());

const call = (name: string, args: Record<string, unknown> = {}) => getDefaultToolset().dispatch(name, args);
const LOGIN = `<LOGIN><USERID>${FAKE_XML_USER}</USERID><PASSWORD>${FAKE_XML_PASSWORD}</PASSWORD></LOGIN>`;

describe('XML parser', () => {
  it('parses attributes, entities, CDATA, comments and self-closing tags', () => {
    const n = parseXml(`<?xml version="1.0"?><!-- c --><A x="1 &amp; 2"><B/><C><![CDATA[<raw>&]]></C><D>a &lt;b&gt; &#65;&#x42;</D></A>`);
    expect(n.attrs.x).toBe('1 & 2');
    expect(n.children.map((c) => c.name)).toEqual(['B', 'C', 'D']);
    expect(n.children[1].text).toBe('<raw>&');
    expect(n.children[2].text).toBe('a <b> AB');
  });

  it.each([
    ['DOCTYPE/entity expansion (XXE)', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'],
    ['mismatched tags', '<a><b></a></b>'],
    ['unclosed', '<a><b>'],
    ['garbage', 'not xml'],
    ['two roots', '<a/><b/>'],
  ])('rejects %s', (_n, doc) => {
    expect(() => parseXml(doc)).toThrow(XmlParseError);
  });

  it('escapes all five special characters', () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;');
  });
});

describe('dandh_xml_get_price_availability', () => {
  it('form-POSTs xmlDoc to the fixed dispatcher with the documented envelope', async () => {
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(PRICE_AVAILABILITY_RESPONSE))]);
    const res = await call('dandh_xml_get_price_availability', { mode: 'both', partNumbers: ['52T', 'STYLUSCOLOR880'] });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe(XML_URL);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].redirect).toBe('manual');
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(postedXml(calls[0])).toBe(
      `<XMLFORMPOST><REQUEST>price-availability</REQUEST>${LOGIN}<PARTNUM>52T</PARTNUM><PARTNUM>STYLUSCOLOR880</PARTNUM></XMLFORMPOST>`,
    );
  });

  it('parses the response including item-level failures', async () => {
    mockDandh([xmlRoute(() => xmlResponse(PRICE_AVAILABILITY_RESPONSE))]);
    const out = JSON.parse(textOf(await call('dandh_xml_get_price_availability', { mode: 'both', partNumbers: ['52T'] })));
    expect(out.items[0]).toEqual({
      partNumber: '52T',
      unitPrice: 6.63,
      totalQuantity: 220,
      branches: [
        { branch: 'California', quantity: 17 },
        { branch: 'Harrisburg', quantity: 203 },
      ],
    });
    expect(out.items[1].branches[0]).toEqual({ branch: 'California', quantity: 0, inStockDate: '01/15/11' });
    expect(out.items[2]).toEqual({ partNumber: '123ABC', message: 'Item not found' });
  });

  it.each([
    ['price', 'price'],
    ['availability', 'availability'],
  ])('mode %s maps to REQUEST %s', async (mode, request) => {
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(PRICE_AVAILABILITY_RESPONSE))]);
    await call('dandh_xml_get_price_availability', { mode, partNumbers: ['A'] });
    expect(postedXml(calls[0])).toContain(`<REQUEST>${request}</REQUEST>`);
  });

  it('caps: 50 for price/availability, 25 for both; validates enum and length, all before any network call', async () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => `P${i}`);
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(PRICE_AVAILABILITY_RESPONSE))]);
    expect((await call('dandh_xml_get_price_availability', { mode: 'price', partNumbers: n(50) })).isError).toBeFalsy();
    expect((await call('dandh_xml_get_price_availability', { mode: 'both', partNumbers: n(25) })).isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    for (const [mode, k] of [['price', 51], ['availability', 51], ['both', 26]] as const) {
      const res = await call('dandh_xml_get_price_availability', { mode, partNumbers: n(k) });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(new RegExp(`maximum is ${mode === 'both' ? 25 : 50}`));
    }
    expect((await call('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['X'.repeat(16)] })).isError).toBe(true);
    expect(textOf(await call('dandh_xml_get_price_availability', { mode: 'bogus', partNumbers: ['A'] }))).toMatch(/mode.*one of/);
    expect(calls).toHaveLength(2);
  });

  it('escapes user values and credentials in the request', async () => {
    setEnv({ DANDH_XML_USER_CODE: 'u<ser', DANDH_XML_PASSWORD: 'p&ss"w>rd' });
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(PRICE_AVAILABILITY_RESPONSE))]);
    await call('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A&B</PART'] });
    const xml = postedXml(calls[0]);
    expect(xml).toContain('<USERID>u&lt;ser</USERID>');
    expect(xml).toContain('<PASSWORD>p&amp;ss&quot;w&gt;rd</PASSWORD>');
    expect(xml).toContain('<PARTNUM>A&amp;B&lt;/PART</PARTNUM>');
    expect(() => parseXml(xml)).not.toThrow();
  });

  it('rejects control characters instead of sending them', async () => {
    const { fetchMock } = mockDandh([]);
    const res = await call('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A\u0001'] });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dandh_xml_item_inquiry', () => {
  it('builds the request (DH default, quantity default 1) and parses the response', async () => {
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(ITEM_INQUIRY_RESPONSE))]);
    const res = await call('dandh_xml_item_inquiry', { partNumber: '01GP31302LR' });
    expect(postedXml(calls[0])).toBe(
      `<XMLFORMPOST><REQUEST>itemInquiry</REQUEST>${LOGIN}<PARTNUM>01GP31302LR</PARTNUM><LOOKUPTYPE>DH</LOOKUPTYPE><QUANTITY>1</QUANTITY></XMLFORMPOST>`,
    );
    expect(JSON.parse(textOf(res)).item).toMatchObject({
      partNumber: '01GP31302LR',
      unitPrice: 39.72,
      estimatedRetailPrice: 45.5,
      vendorItemNumber: '01G-P3-1302-LR',
      freeFreight: true,
      totalQuantity: 33,
      branches: [{ branch: 'Harrisburg', quantity: 33 }],
    });
  });

  it('supports MFR lookup + quantity and validates inputs', async () => {
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(ITEM_INQUIRY_RESPONSE))]);
    await call('dandh_xml_item_inquiry', { partNumber: 'MPN', lookupType: 'MFR', quantity: 25 });
    expect(postedXml(calls[0])).toContain('<LOOKUPTYPE>MFR</LOOKUPTYPE><QUANTITY>25</QUANTITY>');
    for (const args of [{ partNumber: 'A', lookupType: 'XX' }, { partNumber: 'A', quantity: 0 }, { partNumber: 'A'.repeat(51) }, {}]) {
      expect((await call('dandh_xml_item_inquiry', args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });
});

describe('dandh_xml_get_order_status', () => {
  it('builds one STATUSREQUEST per lookup and parses milestones, backorders, packages, serials', async () => {
    const { calls } = mockDandh([xmlRoute(() => xmlResponse(ORDER_STATUS_RESPONSE))]);
    const res = await call('dandh_xml_get_order_status', { poNumbers: ['ABC123456789'], orderNumbers: ['1234567'], invoiceNumbers: ['7654321'] });
    expect(postedXml(calls[0])).toBe(
      `<XMLFORMPOST><REQUEST>orderStatus</REQUEST>${LOGIN}` +
        '<STATUSREQUEST><PONUM>ABC123456789</PONUM></STATUSREQUEST><STATUSREQUEST><ORDERNUM>1234567</ORDERNUM></STATUSREQUEST>' +
        '<STATUSREQUEST><INVOICE>7654321</INVOICE></STATUSREQUEST></XMLFORMPOST>',
    );
    const [order] = JSON.parse(textOf(res)).orders;
    expect(order).toMatchObject({ orderNumber: '1234567', milestone: 'Shipped', invoiceTotal: { total: 945.66, subTotal: 945.66 } });
    expect(order.items[1]).toMatchObject({ itemNumber: 'CEMT1B12S1', quantityBackordered: 2, eta: '01/20/17' });
    expect(order.packages[0]).toMatchObject({ trackingNumber: '1Z999AA10123456784', shipped: true, items: [{ itemNumber: 'SCANMAKER5900', serialNumber: '99l267231123300051HS2311' }] });
  });

  it('requires at least one lookup and caps at 50 in total', async () => {
    const { fetchMock } = mockDandh([]);
    expect((await call('dandh_xml_get_order_status', {})).isError).toBe(true);
    const n = (k: number) => Array.from({ length: k }, (_, i) => `${i}`);
    const res = await call('dandh_xml_get_order_status', { poNumbers: n(30), orderNumbers: n(21) });
    expect(textOf(res)).toMatch(/maximum 50/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('XML transport', () => {
  it('Canadian credentials post to the fixed dandh.ca dispatcher', async () => {
    setEnv({ ...XML_ENV, DANDH_XML_COUNTRY: 'ca' });
    const { calls } = mockDandh([(c) => (c.url.href === 'https://www.dandh.ca/dhXML/xmlDispatch' ? xmlResponse(PRICE_AVAILABILITY_RESPONSE) : undefined)]);
    expect((await call('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A'] })).isError).toBeFalsy();
    expect(calls.map((c) => c.url.href)).toEqual(['https://www.dandh.ca/dhXML/xmlDispatch']);
  });

  it('a redirect is refused, not followed', async () => {
    const { calls } = mockDandh([xmlRoute(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/' } }))]);
    const res = await call('dandh_xml_item_inquiry', { partNumber: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/redirect \(HTTP 302\); refusing to follow it/);
    expect(calls).toHaveLength(1);
  });

  it('an HTML sign-in page is reported as a sign-in problem', async () => {
    mockDandh([xmlRoute(() => new Response(HTML_RESPONSE, { status: 200, headers: { 'content-type': 'text/html' } }))]);
    const res = await call('dandh_xml_item_inquiry', { partNumber: 'A' });
    expect(textOf(res)).toMatch(/web page instead of XML/);
  });

  it('a STATUS failure surfaces the D&H message', async () => {
    mockDandh([xmlRoute(() => xmlResponse(FAILURE_RESPONSE))]);
    const res = await call('dandh_xml_get_order_status', { poNumbers: ['X'] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/D&H XML request failed: Invalid order number/);
  });

  it('a 5xx is reported once, never retried, with the request id', async () => {
    const { calls } = mockDandh([xmlRoute(() => new Response('down', { status: 503, headers: { 'x-request-id': 'xml-req-9' } }))]);
    const res = await call('dandh_xml_item_inquiry', { partNumber: 'A' });
    expect(textOf(res)).toMatch(/HTTP 503.*request id: xml-req-9/);
    expect(calls).toHaveLength(1);
  });

  it('garbage XML is an error', async () => {
    mockDandh([xmlRoute(() => xmlResponse('<XMLRESPONSE><ITEM>'))]);
    expect(textOf(await call('dandh_xml_item_inquiry', { partNumber: 'A' }))).toMatch(/unreadable XML/);
  });
});
