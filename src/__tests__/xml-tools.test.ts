import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { parseXml, XmlParseError } from '../xml/parse.js';
import { escapeXml } from '../xml/build.js';
import { XML_ENV, callInit, postedXml, setupEnv, stubFetch, textOf, xmlResponse } from './test-helpers.js';
import {
  FAILURE_RESPONSE, HTML_RESPONSE, ITEM_INQUIRY_RESPONSE, ORDER_STATUS_RESPONSE,
  ORDER_SUCCESS_RESPONSE, PRICE_AVAILABILITY_RESPONSE,
} from './xml-fixtures.js';

describe('XML parser', () => {
  it('parses attributes, entities, CDATA, comments and self-closing tags', () => {
    const n = parseXml(`<?xml version="1.0"?><!-- c --><A x="1 &amp; 2"><B/><C><![CDATA[<raw>&]]></C><D>a &lt;b&gt; &#65;&#x42;</D></A>`);
    expect(n.attrs.x).toBe('1 & 2');
    expect(n.children.map((c) => c.name)).toEqual(['B', 'C', 'D']);
    expect(n.children[1].text).toBe('<raw>&');
    expect(n.children[2].text).toBe('a <b> AB');
  });

  it.each([
    ['DOCTYPE/entity expansion', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
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

describe('XML tools', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    setupEnv(XML_ENV);
    fetchMock = stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('dandh_xml_get_price_availability', () => {
    it('posts form field xmlDoc to the dispatcher with the documented envelope', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(PRICE_AVAILABILITY_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'both', partNumbers: ['52T', 'STYLUSCOLOR880'] });
      expect(res.isError).toBeUndefined();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://www.dandh.com/dhXML/xmlDispatch');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(postedXml(fetchMock)).toBe(
        '<XMLFORMPOST><REQUEST>price-availability</REQUEST><LOGIN><USERID>xml-user</USERID><PASSWORD>xml-pass-do-not-log</PASSWORD></LOGIN>' +
          '<PARTNUM>52T</PARTNUM><PARTNUM>STYLUSCOLOR880</PARTNUM></XMLFORMPOST>',
      );
    });

    it('parses the response including item-level failures', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(PRICE_AVAILABILITY_RESPONSE));
      const out = JSON.parse(textOf(await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'both', partNumbers: ['52T'] })));
      expect(out.items[0]).toEqual({
        partNumber: '52T', unitPrice: 6.63, totalQuantity: 220,
        branches: [{ branch: 'California', quantity: 17 }, { branch: 'Harrisburg', quantity: 203 }],
      });
      expect(out.items[1].branches[0]).toEqual({ branch: 'California', quantity: 0, inStockDate: '01/15/11' });
      expect(out.items[2]).toEqual({ partNumber: '123ABC', message: 'Item not found' });
    });

    it.each([['price', 'price'], ['availability', 'availability']])('mode %s maps to REQUEST %s', async (mode, request) => {
      fetchMock.mockResolvedValueOnce(xmlResponse(PRICE_AVAILABILITY_RESPONSE));
      await dispatchToolCall('dandh_xml_get_price_availability', { mode, partNumbers: ['A'] });
      expect(postedXml(fetchMock)).toContain(`<REQUEST>${request}</REQUEST>`);
    });

    it('enforces caps: 50 for price/availability, 25 for both, before any network call', async () => {
      const n = (k: number) => Array.from({ length: k }, (_, i) => `P${i}`);
      fetchMock.mockImplementation(async () => xmlResponse(PRICE_AVAILABILITY_RESPONSE));
      expect((await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: n(50) })).isError).toBeUndefined();
      expect((await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'both', partNumbers: n(25) })).isError).toBeUndefined();
      fetchMock.mockClear();
      for (const [mode, k] of [['price', 51], ['availability', 51], ['both', 26]] as const) {
        const res = await dispatchToolCall('dandh_xml_get_price_availability', { mode, partNumbers: n(k) });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toMatch(new RegExp(`maximum is ${mode === 'both' ? 25 : 50}`));
      }
      expect((await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['X'.repeat(16)] })).isError).toBe(true);
      expect((await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'bogus', partNumbers: ['A'] })).isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('escapes user values and credentials in the request', async () => {
      setupEnv({ DANDH_XML_USER_CODE: 'u<ser', DANDH_XML_PASSWORD: 'p&ss"w>rd' });
      fetchMock.mockResolvedValueOnce(xmlResponse(PRICE_AVAILABILITY_RESPONSE));
      await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A&B</PARTNUM>'] });
      const xml = postedXml(fetchMock);
      expect(xml).toContain('<USERID>u&lt;ser</USERID>');
      expect(xml).toContain('<PASSWORD>p&amp;ss&quot;w&gt;rd</PASSWORD>');
      expect(xml).toContain('<PARTNUM>A&amp;B&lt;/PARTNUM&gt;</PARTNUM>');
      expect(() => parseXml(xml)).not.toThrow();
    });

    it('rejects control characters instead of sending them', async () => {
      const res = await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A\u0001'] });
      expect(res.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('dandh_xml_item_inquiry', () => {
    it('builds the request (DH default, quantity default 1) and parses the response', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(ITEM_INQUIRY_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: '01GP31302LR' });
      expect(postedXml(fetchMock)).toBe(
        '<XMLFORMPOST><REQUEST>itemInquiry</REQUEST><LOGIN><USERID>xml-user</USERID><PASSWORD>xml-pass-do-not-log</PASSWORD></LOGIN>' +
          '<PARTNUM>01GP31302LR</PARTNUM><LOOKUPTYPE>DH</LOOKUPTYPE><QUANTITY>1</QUANTITY></XMLFORMPOST>',
      );
      const { item } = JSON.parse(textOf(res));
      expect(item).toMatchObject({
        partNumber: '01GP31302LR', unitPrice: 39.72, estimatedRetailPrice: 45.5, rebateValue: 0,
        vendorItemNumber: '01G-P3-1302-LR', isNonStock: false, isFactoryDirect: false, freeFreight: true, restricted: false,
        totalQuantity: 33, branches: [{ branch: 'Harrisburg', quantity: 33 }],
      });
    });

    it('supports MFR lookup + quantity and validates inputs', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(ITEM_INQUIRY_RESPONSE));
      await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'MPN', lookupType: 'MFR', quantity: 25 });
      const xml = postedXml(fetchMock);
      expect(xml).toContain('<LOOKUPTYPE>MFR</LOOKUPTYPE><QUANTITY>25</QUANTITY>');
      fetchMock.mockClear();
      for (const args of [{ partNumber: 'A', lookupType: 'XX' }, { partNumber: 'A', quantity: 0 }, { partNumber: 'A', quantity: 100000 }, { partNumber: 'A'.repeat(51) }]) {
        expect((await dispatchToolCall('dandh_xml_item_inquiry', args)).isError).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('dandh_xml_get_order_status', () => {
    it('builds one STATUSREQUEST per lookup and parses milestones, backorders, packages, serials', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(ORDER_STATUS_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_get_order_status', { poNumbers: ['PO&1'], orderNumbers: ['1234567'], invoiceNumbers: ['7654321'] });
      expect(postedXml(fetchMock)).toContain(
        '<STATUSREQUEST><PONUM>PO&amp;1</PONUM></STATUSREQUEST><STATUSREQUEST><ORDERNUM>1234567</ORDERNUM></STATUSREQUEST><STATUSREQUEST><INVOICE>7654321</INVOICE></STATUSREQUEST>',
      );
      const { orders } = JSON.parse(textOf(res));
      expect(orders).toHaveLength(1);
      const o = orders[0];
      expect(o).toMatchObject({
        poNumber: 'ABC123456789', orderNumber: '1234567', invoice: '7654321', milestone: 'Shipped', branch: 'Chicago',
        invoiceTotal: { total: 945.66, subTotal: 945.66, tax: 0, environmentalHandling: 0, freight: 0, handling: 0 },
        soldTo: { name: 'Sold Co & Sons', state: 'PA' },
      });
      expect(o.items[1]).toMatchObject({ itemNumber: 'CEMT1B12S1', quantity: 0, quantityBackordered: 2, eta: '01/20/17', description: 'DualArm TV Mount 10 to 27&quot;' });
      expect(o.packages[0]).toMatchObject({ carrier: 'UPS', service: 'Ground', trackingNumber: '1Z999AA10123456784', shipped: true, items: [{ itemNumber: 'SCANMAKER5900', serialNumber: '99l267231123300051HS2311' }] });
    });

    it('requires at least one lookup and caps at 50 in total', async () => {
      expect((await dispatchToolCall('dandh_xml_get_order_status', {})).isError).toBe(true);
      const many = Array.from({ length: 30 }, (_, i) => String(i));
      expect((await dispatchToolCall('dandh_xml_get_order_status', { poNumbers: many, orderNumbers: many })).isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('dandh_xml_create_order', () => {
    const base = {
      poNumber: 'PO-777', shipCarrier: 'UPS', shipService: 'Ground', confirm: true,
      items: [{ partNumber: 'STYLUSCOLOR880', quantity: 5, branch: 'Harrisburg' }, { partNumber: '52T', quantity: 1 }],
    };

    /** Price lookups get the price fixture; the order POST gets `order()`. */
    function route(order: () => Response | Promise<Response>) {
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const doc = new URLSearchParams(init.body).get('xmlDoc') ?? '';
        return doc.includes('<REQUEST>price</REQUEST>') ? xmlResponse(PRICE_AVAILABILITY_RESPONSE) : order();
      });
    }
    const orderCalls = () => fetchMock.mock.calls.filter((c) => String(new URLSearchParams(c[1].body).get('xmlDoc')).includes('<REQUEST>orderEntry</REQUEST>'));
    const orderXml = () => new URLSearchParams(orderCalls()[0][1].body).get('xmlDoc') ?? '';

    it('builds the documented Order Entry document and returns the order number', async () => {
      route(() => xmlResponse(ORDER_SUCCESS_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_create_order', {
        ...base, partialShipmentAllowed: false, backorderAllowed: false, shipBillToAccount: '123', onlyBranch: 'Chicago', expectedShipDate: '03/15/2026',
      });
      expect(JSON.parse(textOf(res))).toMatchObject({ status: 'success', orderNumber: '5005560', poNumber: 'PO-777' });
      expect(orderXml()).toBe(
        '<XMLFORMPOST><REQUEST>orderEntry</REQUEST><LOGIN><USERID>xml-user</USERID><PASSWORD>xml-pass-do-not-log</PASSWORD></LOGIN>' +
          '<ORDERHEADER><ONLYBRANCH>Chicago</ONLYBRANCH><PARTSHIPALLOW>N</PARTSHIPALLOW><BACKORDERALLOW>N</BACKORDERALLOW>' +
          '<SHIPCARRIER>UPS</SHIPCARRIER><SHIPSERVICE>Ground</SHIPSERVICE><SHIPBILLTOACCOUNT>123</SHIPBILLTOACCOUNT>' +
          '<EXPECTEDSHIPDATE>03/15/2026</EXPECTEDSHIPDATE><PONUM>PO-777</PONUM></ORDERHEADER>' +
          '<ORDERITEMS><ITEM><PARTNUM>STYLUSCOLOR880</PARTNUM><QTY>5</QTY><BRANCH>Harrisburg</BRANCH></ITEM><ITEM><PARTNUM>52T</PARTNUM><QTY>1</QTY></ITEM></ORDERITEMS></XMLFORMPOST>',
      );
    });

    it('includes drop-ship, remarks (with hold note) and end-user data, all escaped', async () => {
      route(() => xmlResponse(ORDER_SUCCESS_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_create_order', {
        ...base,
        remarks: 'Leave at <dock> & call',
        shipTo: { name: 'Acme & Co', address: '1 Road', city: 'Austin', state: 'TX', zip: '78701-1234', dropShipPassword: 'ds-secret' },
        endUserData: { organization: 'End "User"', state: 'TX', zip: '78701', authQuoteNumber: 'Q1', updateType: 'Renewal', supportStartDate: '01/02/2026' },
      });
      const xml = orderXml();
      expect(xml).toContain('<DROPSHIPPW>ds-secret</DROPSHIPPW><SHIPTONAME>Acme &amp; Co</SHIPTONAME>');
      expect(xml).toContain('<REMARKS>Leave at &lt;dock&gt; &amp; call</REMARKS>');
      expect(xml).toContain('<ENDUSERDATA><ORGANIZATION>End &quot;User&quot;</ORGANIZATION><STATE>TX</STATE><ZIP>78701</ZIP><AUTHQUOTENUM>Q1</AUTHQUOTENUM><UPDATETYPE>Renewal</UPDATETYPE><SUPPORTSTARTDATE>01/02/2026</SUPPORTSTARTDATE></ENDUSERDATA>');
      expect(() => parseXml(xml)).not.toThrow();
      expect(textOf(res)).toMatch(/ON HOLD/);
    });

    it.each([
      ['bad carrier', { shipCarrier: 'DHL' }, /shipCarrier must be one of/],
      ['bad service', { shipService: 'Teleport' }, /shipService must be one of/],
      ['priority mail without USPS', { shipService: 'PriorityMail' }, /only valid with shipCarrier USPS/],
      ['bad branch (item)', { items: [{ partNumber: 'A', quantity: 1, branch: 'Toronto' }] }, /not a valid US branch/],
      ['bad onlyBranch', { onlyBranch: 'Mars' }, /not a valid US branch/],
      ['PO too long', { poNumber: 'P'.repeat(31) }, /at most 30/],
      ['remarks too long', { remarks: 'r'.repeat(59) }, /at most 58/],
      ['qty zero', { items: [{ partNumber: 'A', quantity: 0 }] }, /quantity/],
      ['qty too big', { items: [{ partNumber: 'A', quantity: 100000 }] }, /quantity/],
      ['partnum too long', { items: [{ partNumber: 'A'.repeat(16), quantity: 1 }] }, /at most 15/],
      ['no items', { items: [] }, /items/],
      ['bad ship date', { expectedShipDate: '2026-03-15' }, /MM\/DD\/YYYY/],
      ['partial drop ship', { shipTo: { name: 'A', address: 'B' } }, /requires city, state, zip/],
      ['bad zip', { shipTo: { name: 'A', address: 'B', city: 'C', state: 'TX', zip: 'ABC' } }, /ZIP/],
      ['bad updateType', { endUserData: { updateType: 'Sideways' } }, /updateType/],
      ['unknown end user key', { endUserData: { nope: 'x' } }, /Unknown field/],
    ])('validates locally, no network: %s', async (_n, patch, re) => {
      const res = await dispatchToolCall('dandh_xml_create_order', { ...base, ...patch });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(re);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('failure response: reports the D&H message, never retries', async () => {
      route(() => xmlResponse(FAILURE_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_create_order', base);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Duplicate PO number');
      expect(orderCalls()).toHaveLength(1);
      fetchMock.mockClear();
      route(() => new Response('', { status: 503 }));
      const r2 = await dispatchToolCall('dandh_xml_create_order', { ...base, poNumber: 'PO-778' });
      expect(textOf(r2)).toMatch(/may or may not have been placed.*PO-778/);
      expect(orderCalls()).toHaveLength(1);
      fetchMock.mockClear();
      route(() => { throw new Error('ECONNRESET'); });
      await dispatchToolCall('dandh_xml_create_order', { ...base, poNumber: 'PO-779' });
      expect(orderCalls()).toHaveLength(1);
    });

    it('HTML page response is reported as auth failure / maintenance, with order outcome note', async () => {
      route(() => xmlResponse(HTML_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_create_order', base);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/web page instead of XML.*sign-in was rejected.*maintenance/);
      expect(textOf(res)).toMatch(/dandh_xml_get_order_status for PO PO-777/);
    });

    describe('Canada', () => {
      beforeEach(() => setupEnv({ ...XML_ENV, DANDH_XML_COUNTRY: 'ca' }));

      it('posts to dandh.ca, validates CA branches and rejects EXPECTEDSHIPDATE', async () => {
        route(() => xmlResponse(ORDER_SUCCESS_RESPONSE));
        await dispatchToolCall('dandh_xml_create_order', { ...base, items: [{ partNumber: '52T', quantity: 1, branch: 'Toronto', price: 4.5 }] });
        expect(orderCalls()[0][0]).toBe('https://www.dandh.ca/dhXML/xmlDispatch');
        expect(orderXml()).toContain('<BRANCH>Toronto</BRANCH>');
        expect(orderXml()).not.toContain('EXPECTEDSHIPDATE');

        fetchMock.mockClear();
        const us = await dispatchToolCall('dandh_xml_create_order', { ...base, items: [{ partNumber: 'A', quantity: 1, branch: 'Chicago' }] });
        expect(textOf(us)).toMatch(/not a valid CA branch.*Toronto, Vancouver/);
        const date = await dispatchToolCall('dandh_xml_create_order', { ...base, expectedShipDate: '03/15/2026' });
        expect(textOf(date)).toMatch(/not supported for Canadian/);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('transport/response handling', () => {
    it('detects HTML sign-in pages on read requests', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(HTML_RESPONSE));
      const res = await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A'] });
      expect(textOf(res)).toMatch(/web page instead of XML/);
    });

    it('detects text/html content-type responses even without an <html> prefix', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Maintenance window', { status: 200, headers: { 'Content-Type': 'text/html' } }));
      expect(textOf(await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' }))).toMatch(/web page/);
    });

    it('surfaces STATUS failure messages and flags sign-in wording', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse('<XMLRESPONSE><STATUS>failure</STATUS><MESSAGE>Invalid login</MESSAGE></XMLRESPONSE>'));
      const res = await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' });
      expect(textOf(res)).toMatch(/possible sign-in problem.*Invalid login/);
    });

    it('retries read requests on 5xx but gives up after the limit', async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(xmlResponse(PRICE_AVAILABILITY_RESPONSE));
      expect((await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A'] })).isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('handles garbage XML', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse('<XMLRESPONSE><STATUS>success'));
      expect(textOf(await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' }))).toMatch(/unreadable XML/);
    });

    it('honours an https DANDH_XML_URL override on a D&H host and rejects anything else', async () => {
      process.env.DANDH_XML_URL = 'https://xml.dandh.com/x';
      fetchMock.mockResolvedValueOnce(xmlResponse(ITEM_INQUIRY_RESPONSE));
      await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://xml.dandh.com/x');
      fetchMock.mockClear();
      for (const bad of ['http://www.dandh.com/x', 'https://xml.example.test/x', 'https://dandh.com.evil.com/x']) {
        process.env.DANDH_XML_URL = bad;
        const res = await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toMatch(/Invalid DANDH_XML_URL/);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never follows redirects (redirect: "error" on every request)', async () => {
      fetchMock.mockResolvedValueOnce(xmlResponse(ITEM_INQUIRY_RESPONSE));
      await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' });
      expect(callInit(fetchMock, 0).redirect).toBe('error');
    });
  });
});
