import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { extractUnitPrice } from '../tools/rest.js';
import { REST_ENV, XML_ENV, callInit, callUrl, jsonResponse, queue, setupEnv, stubFetch, textOf, xmlResponse } from './test-helpers.js';
import { ORDER_SUCCESS_RESPONSE, PRICE_AVAILABILITY_RESPONSE, FAILURE_RESPONSE } from './xml-fixtures.js';

const isOrderPost = (c: unknown[]) => (c[1] as { method?: string })?.method === 'POST' && String(c[0]).endsWith('/salesOrders');
const restPosts = (m: ReturnType<typeof stubFetch>) => m.mock.calls.filter(isOrderPost);

describe('REST dandh_create_sales_order safety', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    setupEnv(REST_ENV);
    fetchMock = stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const line = (over: Record<string, unknown> = {}) => ({ itemId: 'ABC', orderQuantity: 2, unitPrice: 10, ...over });
  const order = (over: Record<string, unknown> = {}) => ({
    customerPurchaseOrder: 'PO-1',
    shipments: [{ branch: 'BR01', lines: [line()] }],
    ...over,
  });

  /** Token, then price lookups answer with {unitPrice: 12.5}, order POST answers {orderNumber: 1}. */
  function route(post: () => Response = () => jsonResponse({ orderNumber: 1 })) {
    fetchMock.mockImplementation(async (url: string, init: { method: string }) => {
      if (String(url).includes('/oauth/token')) return jsonResponse({ access_token: 'tok-1', expires_in: 3600 });
      if (init.method === 'POST') return post();
      return jsonResponse({ unitPrice: 12.5 });
    });
  }

  it('previews by default: nothing is POSTed, lines/total/caps are shown', async () => {
    route();
    const res = await dispatchToolCall('dandh_create_sales_order', order({ specialInstructions: 'call' }));
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(textOf(res));
    expect(out).toMatchObject({
      status: 'preview',
      placed: false,
      lineCount: 1,
      estimatedTotal: 20,
      limitsApplied: { DANDH_MAX_ORDER_LINES: 25, DANDH_MAX_LINE_QUANTITY: 100, DANDH_MAX_ORDER_VALUE: 5000, DANDH_MAX_UNIT_PRICE: 25000 },
    });
    expect(out.shipments[0]).toMatchObject({ branch: 'BR01', lines: [{ itemId: 'ABC', orderQuantity: 2, unitPrice: 10, priceSource: 'caller', lineTotal: 20 }] });
    expect(out.order.specialInstructionsPutOrderOnHold).toBe(true);
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('confirm:false and omitted confirm are both previews; only confirm:true posts', async () => {
    route();
    await dispatchToolCall('dandh_create_sales_order', order({ confirm: false }));
    expect(restPosts(fetchMock)).toHaveLength(0);
    const res = await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }));
    expect(JSON.parse(textOf(res))).toEqual({ orderNumber: 1 });
    expect(restPosts(fetchMock)).toHaveLength(1);
    // confirm is not forwarded to D&H
    expect(JSON.parse(restPosts(fetchMock)[0][1].body)).not.toHaveProperty('confirm');
  });

  it('previews do not reserve the PO', async () => {
    route();
    await dispatchToolCall('dandh_create_sales_order', order());
    await dispatchToolCall('dandh_create_sales_order', order());
    expect((await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }))).isError).toBeUndefined();
  });

  it('looks up the D&H price when unitPrice is omitted and uses it for the total', async () => {
    route();
    const res = await dispatchToolCall('dandh_create_sales_order', order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] }));
    const out = JSON.parse(textOf(res));
    expect(out.estimatedTotal).toBe(25);
    expect(out.shipments[0].lines[0]).toMatchObject({ unitPrice: 12.5, priceSource: 'D&H current price' });
    const get = fetchMock.mock.calls.find((c) => String(c[0]).includes('/items/ABC/price'))!;
    expect(new URL(get[0]).searchParams.get('quantity')).toBe('2');
  });

  it('preview shows "unknown" when the price cannot be determined; confirm refuses without posting', async () => {
    fetchMock.mockImplementation(async (url: string, init: { method: string }) => {
      if (String(url).includes('/oauth/token')) return jsonResponse({ access_token: 'tok-1', expires_in: 3600 });
      return init.method === 'POST' ? jsonResponse({}) : jsonResponse({ nothing: 'here' });
    });
    const o = order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] });
    const prev = JSON.parse(textOf(await dispatchToolCall('dandh_create_sales_order', o)));
    expect(prev.estimatedTotal).toBe('unknown');
    expect(prev.message).toMatch(/confirm: true would be refused/);
    const res = await dispatchToolCall('dandh_create_sales_order', { ...o, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/price of one or more lines could not be determined/);
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('confirm refuses when the price lookup itself fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/oauth/token') ? jsonResponse({ access_token: 't', expires_in: 3600 }) : jsonResponse({ message: 'nope' }, 404));
    const res = await dispatchToolCall('dandh_create_sales_order', order({ confirm: true, shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] }));
    expect(res.isError).toBe(true);
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('enforces the order value cap in preview and confirm', async () => {
    route();
    const big = order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 100, unitPrice: 72.3 })] }] });
    for (const confirm of [false, true]) {
      const res = await dispatchToolCall('dandh_create_sales_order', { ...big, confirm });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('Error: This order is over the $5,000.00 limit (estimated $7,230.00). Split it into smaller orders or ask an admin to raise DANDH_MAX_ORDER_VALUE.');
    }
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('enforces the line cap across all shipments', async () => {
    route();
    const lines = Array.from({ length: 16 }, (_, i) => line({ itemId: `I${i}` }));
    const res = await dispatchToolCall('dandh_create_sales_order', order({
      shipments: [{ branch: 'BR01', lines }, { branch: 'BR05', lines: lines.slice(0, 15) }],
    }));
    expect(textOf(res)).toMatch(/has 31 lines; the limit is 25\. Split it into smaller orders or ask an admin to raise DANDH_MAX_ORDER_LINES\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces the per-line quantity cap (REST orderQuantity)', async () => {
    const res = await dispatchToolCall('dandh_create_sales_order', order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 101 })] }] }));
    expect(textOf(res)).toMatch(/orderQuantity is 101; the per-line limit is 100.*DANDH_MAX_LINE_QUANTITY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps are configurable by env', async () => {
    route();
    process.env.DANDH_MAX_LINE_QUANTITY = '1000';
    process.env.DANDH_MAX_ORDER_VALUE = '100000';
    const res = await dispatchToolCall('dandh_create_sales_order', order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 500, unitPrice: 20 })] }] }));
    expect(JSON.parse(textOf(res)).estimatedTotal).toBe(10000);
  });

  it('a bad cap value is a clear config error, nothing is sent', async () => {
    process.env.DANDH_MAX_ORDER_VALUE = '-3';
    const res = await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }));
    expect(textOf(res)).toMatch(/Invalid DANDH_MAX_ORDER_VALUE/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [0, /greater than 0/],
    [-2, /greater than 0/],
    [1.234, /2 decimal places/],
    ['9.99', /must be a number/],
    [30000, /unit-price limit/],
  ])('validates unitPrice %s before any network call', async (price, re) => {
    const res = await dispatchToolCall('dandh_create_sales_order', order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: price })] }] }));
    expect(textOf(res)).toMatch(re);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('PO dedupe', () => {
    it('refuses a second confirmed order with the same PO (case-insensitive) and never names the account', async () => {
      route();
      expect((await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }))).isError).toBeUndefined();
      const dup = await dispatchToolCall('dandh_create_sales_order', order({ confirm: true, customerPurchaseOrder: ' po-1 ' }));
      expect(dup.isError).toBe(true);
      expect(textOf(dup)).toBe('Error: A PO with number po-1 was already placed from this connection. Check its status with dandh_list_order_tracking, or use a new PO number.');
      expect(textOf(dup)).not.toContain(REST_ENV.DANDH_ACCOUNT_NUMBER);
      expect(restPosts(fetchMock)).toHaveLength(1);
    });

    it('keeps the PO after a 5xx or a network error (outcome ambiguous)', async () => {
      route(() => jsonResponse({ message: 'boom' }, 503));
      await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }));
      expect(textOf(await dispatchToolCall('dandh_create_sales_order', order({ confirm: true })))).toMatch(/already placed/);

      route(() => { throw new Error('socket hang up'); });
      await dispatchToolCall('dandh_create_sales_order', order({ confirm: true, customerPurchaseOrder: 'PO-2' }));
      expect(textOf(await dispatchToolCall('dandh_create_sales_order', order({ confirm: true, customerPurchaseOrder: 'PO-2' })))).toMatch(/already placed/);
    });

    it('releases the PO after a definitive 4xx rejection', async () => {
      route(() => jsonResponse({ message: 'Invalid line' }, 400));
      expect((await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }))).isError).toBe(true);
      route();
      expect((await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }))).isError).toBeUndefined();
    });

    it('does not reserve when the order is refused locally (cap) before sending', async () => {
      route();
      const big = order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 100, unitPrice: 100 })] }] });
      await dispatchToolCall('dandh_create_sales_order', { ...big, confirm: true });
      expect((await dispatchToolCall('dandh_create_sales_order', order({ confirm: true }))).isError).toBeUndefined();
    });
  });

  describe('shipping.address validation', () => {
    const withAddress = (address: unknown) => order({ shipping: { address } });
    it('passes a clean address through (trimmed)', async () => {
      route();
      const res = await dispatchToolCall('dandh_create_sales_order', { ...withAddress({ name: ' Acme & Co. ', address1: '1 Main St #4/B', city: "O'Fallon", state: 'MO', postalCode: '63366-1234', country: 'US', attention: 'José Müller' }), confirm: true });
      expect(res.isError).toBeUndefined();
      expect(JSON.parse(restPosts(fetchMock)[0][1].body).shipping.address).toEqual({ name: 'Acme & Co.', address1: '1 Main St #4/B', city: "O'Fallon", state: 'MO', postalCode: '63366-1234', country: 'US', attention: 'José Müller' });
    });

    it.each([
      ['nested object', { name: { x: 1 } }, /must be a text value/],
      ['number value', { zip: 12345 }, /must be a text value/],
      ['array value', { name: ['a'] }, /must be a text value/],
      ['unknown key', { evil: 'x' }, /Unknown field\(s\) in shipping\.address: evil/],
      ['__proto__-ish key', JSON.parse('{"__proto__x":"a"}'), /Unknown field/],
      ['too long', { name: 'a'.repeat(61) }, /at most 60/],
      ['angle brackets', { name: '<script>' }, /characters that are not allowed/],
      ['control char', { name: 'a\u0007b' }, /control characters|not allowed/],
      ['quote', { name: 'a"b' }, /not allowed/],
      ['semicolon', { city: 'a;b' }, /not allowed/],
      ['newline', { city: 'a\nb' }, /control characters|not allowed/],
      ['too many keys', Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v'])), /maximum is 12/],
    ])('rejects %s before any network call', async (_n, address, re) => {
      const res = await dispatchToolCall('dandh_create_sales_order', { ...withAddress(address), confirm: true });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(re);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('rejects accountNumber/company as unknown fields', async () => {
    for (const k of ['accountNumber', 'company']) {
      const res = await dispatchToolCall('dandh_create_sales_order', order({ [k]: 'x', confirm: true }));
      expect(textOf(res)).toMatch(new RegExp(`Unknown field\\(s\\) in order: ${k}`));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses redirect: "error" on the token, price and order requests', async () => {
    route();
    await dispatchToolCall('dandh_create_sales_order', order({ confirm: true, shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] }));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of fetchMock.mock.calls) expect(c[1].redirect).toBe('error');
  });
});

describe('extractUnitPrice', () => {
  it.each([
    [{ unitPrice: 4.5 }, 4.5],
    [{ price: '$1,234.50' }, 1234.5],
    [{ elements: [{ customerPrice: 3 }] }, 3],
    [[{ UnitPrice: 2 }], 2],
    [{ data: { item: { yourPrice: 7 } } }, 7],
    [{ unitPrice: 0 }, undefined],
    [{ unitPrice: 'free' }, undefined],
    [{}, undefined],
    [null, undefined],
  ])('%j -> %s', (body, expected) => {
    expect(extractUnitPrice(body)).toBe(expected);
  });
});

describe('XML dandh_xml_create_order safety', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    setupEnv(XML_ENV);
    fetchMock = stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  const base = (over: Record<string, unknown> = {}) => ({
    poNumber: 'PO-9', shipCarrier: 'UPS', shipService: 'Ground',
    items: [{ partNumber: '52T', quantity: 2 }],
    ...over,
  });
  const doc = (c: unknown[]) => new URLSearchParams((c[1] as { body: string }).body).get('xmlDoc') ?? '';
  const orderCalls = () => fetchMock.mock.calls.filter((c) => doc(c).includes('<REQUEST>orderEntry</REQUEST>'));

  function route(order: () => Response = () => xmlResponse(ORDER_SUCCESS_RESPONSE), price: () => Response = () => xmlResponse(PRICE_AVAILABILITY_RESPONSE)) {
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) =>
      new URLSearchParams(init.body).get('xmlDoc')!.includes('<REQUEST>price</REQUEST>') ? price() : order());
  }

  it('previews by default using D&H prices; never sends orderEntry', async () => {
    route();
    const res = await dispatchToolCall('dandh_xml_create_order', base({ remarks: 'hold me', shipTo: { name: 'A', address: 'B', city: 'C', state: 'TX', zip: '78701', dropShipPassword: 'ds-secret-pw' } }));
    const out = JSON.parse(textOf(res));
    expect(out).toMatchObject({ status: 'preview', placed: false, lineCount: 1, estimatedTotal: 13.26 });
    expect(out.lines[0]).toMatchObject({ partNumber: '52T', quantity: 2, unitPrice: 6.63, priceSource: 'D&H current price', lineTotal: 13.26 });
    expect(out.order.remarksPutOrderOnHold).toBe(true);
    expect(out.order.shipTo).toMatchObject({ name: 'A', dropShipPasswordGiven: true });
    expect(textOf(res)).not.toContain('ds-secret-pw');
    expect(out.limitsApplied.DANDH_MAX_ORDER_VALUE).toBe(5000);
    expect(orderCalls()).toHaveLength(0);
  });

  it('uses the caller price without a lookup', async () => {
    route();
    const out = JSON.parse(textOf(await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: '52T', quantity: 2, price: 5 }] }))));
    expect(out.estimatedTotal).toBe(10);
    expect(out.lines[0].priceSource).toBe('caller');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown price: preview says so, confirm refuses without sending', async () => {
    route(undefined, () => xmlResponse('<XMLRESPONSE><ITEM><PARTNUM>52T</PARTNUM><MESSAGE>Item not found</MESSAGE></ITEM><STATUS>success</STATUS></XMLRESPONSE>'));
    const prev = JSON.parse(textOf(await dispatchToolCall('dandh_xml_create_order', base())));
    expect(prev.estimatedTotal).toBe('unknown');
    expect(prev.lines[0].unitPrice).toBe('unknown');
    expect(prev.message).toMatch(/confirm: true would be refused/);
    const res = await dispatchToolCall('dandh_xml_create_order', base({ confirm: true }));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/could not be determined/);
    expect(orderCalls()).toHaveLength(0);
  });

  it('enforces the value, line and quantity caps', async () => {
    route();
    const val = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'X', quantity: 100, price: 72.3 }], confirm: true }));
    expect(textOf(val)).toBe('Error: This order is over the $5,000.00 limit (estimated $7,230.00). Split it into smaller orders or ask an admin to raise DANDH_MAX_ORDER_VALUE.');
    const lines = await dispatchToolCall('dandh_xml_create_order', base({ items: Array.from({ length: 26 }, (_, i) => ({ partNumber: `P${i}`, quantity: 1, price: 1 })) }));
    expect(textOf(lines)).toMatch(/has 26 lines; the limit is 25\. Split it into smaller orders or ask an admin to raise DANDH_MAX_ORDER_LINES\./);
    const qty = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'P', quantity: 101, price: 1 }] }));
    expect(textOf(qty)).toMatch(/quantity is 101; the per-line limit is 100.*DANDH_MAX_LINE_QUANTITY/);
    expect(orderCalls()).toHaveLength(0);
  });

  it.each([
    [0, /greater than 0/],
    [-1, /greater than 0/],
    [2.555, /2 decimal places/],
    [Number.POSITIVE_INFINITY, /must be a number/],
    [25001, /unit-price limit/],
  ])('validates price %s', async (price, re) => {
    const res = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'P', quantity: 1, price }] }));
    expect(textOf(res)).toMatch(re);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PO dedupe: kept on success, 5xx and network error; released on an XML failure response', async () => {
    route();
    await dispatchToolCall('dandh_xml_create_order', base({ confirm: true }));
    const dup = await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'po-9' }));
    expect(textOf(dup)).toBe('Error: A PO with number po-9 was already placed from this connection. Check its status with dandh_xml_get_order_status, or use a new PO number.');
    expect(textOf(dup)).not.toContain('xml-user');
    expect(orderCalls()).toHaveLength(1);

    route(() => new Response('', { status: 503 }));
    await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'P5xx' }));
    expect(textOf(await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'P5xx' })))).toMatch(/already placed/);

    route(() => { throw new Error('ECONNRESET'); });
    await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'Pnet' }));
    expect(textOf(await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'Pnet' })))).toMatch(/already placed/);

    route(() => xmlResponse(FAILURE_RESPONSE));
    await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'Prej' }));
    route();
    expect((await dispatchToolCall('dandh_xml_create_order', base({ confirm: true, poNumber: 'Prej' }))).isError).toBeUndefined();
  });

  it('previews do not reserve the PO', async () => {
    route();
    await dispatchToolCall('dandh_xml_create_order', base());
    await dispatchToolCall('dandh_xml_create_order', base());
    expect((await dispatchToolCall('dandh_xml_create_order', base({ confirm: true }))).isError).toBeUndefined();
  });

  it('uses redirect: "error" on price and order requests', async () => {
    route();
    await dispatchToolCall('dandh_xml_create_order', base({ confirm: true }));
    expect(fetchMock.mock.calls.length).toBe(2);
    for (const c of fetchMock.mock.calls) expect(callInit(fetchMock, fetchMock.mock.calls.indexOf(c)).redirect).toBe('error');
  });

  describe('shipTo allow-list and lengths', () => {
    const ship = (over: Record<string, unknown> = {}) => ({ name: 'Acme Co', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', ...over });
    const run = (shipTo: Record<string, unknown>) => dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'P', quantity: 1, price: 1 }], shipTo, confirm: true }));

    it('accepts accented letters and . , \' - # / &', async () => {
      route();
      const res = await run(ship({ name: "José O'Brien-Müller", attention: 'Dept. #5, R&D', address: '12 Rue de l’Église'.replace('’', "'"), address2: 'Apt 4/B', city: 'São Paulo', dropShipPassword: 'p@$$ w0rd<>"!' }));
      expect(res.isError).toBeUndefined();
      expect(doc(orderCalls()[0])).toContain('<DROPSHIPPW>p@$$ w0rd&lt;&gt;&quot;!</DROPSHIPPW>');
    });

    it.each([
      ['name <', { name: 'A<B' }, /shipTo\.name contains characters that are not allowed/],
      ['name >', { name: 'A>B' }, /not allowed/],
      ['address ;', { address: '1 Main; DROP' }, /not allowed/],
      ['city quote', { city: 'Au"stin' }, /not allowed/],
      ['attention backtick', { attention: 'a`b' }, /not allowed/],
      ['control char', { name: 'A\u0001B' }, /control characters|not allowed/],
      ['name 26', { name: 'a'.repeat(26) }, /shipTo\.name|name must be at most 25/],
      ['attention 31', { attention: 'a'.repeat(31) }, /at most 30/],
      ['address 31', { address: 'a'.repeat(31) }, /at most 30/],
      ['address2 31', { address2: 'a'.repeat(31) }, /at most 30/],
      ['city 19', { city: 'a'.repeat(19) }, /at most 18/],
      ['state digits', { state: 'T1' }, /two-letter/],
      ['state 3', { state: 'TXX' }, /at most 2|two-letter/],
      ['state 1', { state: 'T' }, /two-letter/],
      ['zip 11', { zip: '1'.repeat(11) }, /at most 10/],
      ['password 31', { dropShipPassword: 'p'.repeat(31) }, /at most 30/],
      ['password control', { dropShipPassword: 'pa\u0000ss' }, /control characters/],
      ['password zero-width/format', { dropShipPassword: 'pa​ss' }, /non-printable/],
    ])('rejects %s without sending', async (_n, over, re) => {
      route();
      const res = await run(ship(over));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(re);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never echoes the drop-ship password in validation errors', async () => {
      const res = await run(ship({ dropShipPassword: 'secret-secret-secret-secret-secret-1' }));
      expect(textOf(res)).not.toContain('secret-secret');
    });
  });
});
