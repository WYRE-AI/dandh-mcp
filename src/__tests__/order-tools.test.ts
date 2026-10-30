import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { extractUnitPrice, interpretPoTracking } from '../tools/rest.js';
import { lookupPoStatus } from '../tools/xml.js';
import { clearTokenCache } from '../rest-client.js';
import { REST_ENV, XML_ENV, callInit, callUrl, jsonResponse, queue, setupEnv, stubFetch, textOf, withConfirmToken, xmlResponse } from './test-helpers.js';
import { ORDER_SUCCESS_RESPONSE, ORDER_STATUS_RESPONSE, PRICE_AVAILABILITY_RESPONSE, FAILURE_RESPONSE, HTML_RESPONSE } from './xml-fixtures.js';

const isOrderPost = (c: unknown[]) => (c[1] as { method?: string })?.method === 'POST' && String(c[0]).endsWith('/salesOrders');
const restPosts = (m: ReturnType<typeof stubFetch>) => m.mock.calls.filter(isOrderPost);

const PREVIEW_COPY =
  'Preview only: no order was sent to D&H (only price lookups). Show this to the user and, once they explicitly approve every line, quantity, branch and shipping choice, call again with the same order, confirm: true and the confirmToken below to place the order. The token expires in 30 minutes.';

describe('REST dandh_create_sales_order safety', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  /** What the pre-confirm PO lookup (GET .../salesOrders/tracking) answers. */
  let tracking: () => Response;
  /** When true the OAuth endpoint answers 503 (used to fail after the PO lookup, before the order POST). */
  let failToken = false;
  beforeEach(() => {
    failToken = false;
    setupEnv(REST_ENV);
    fetchMock = stubFetch();
    tracking = () => jsonResponse({ salesOrders: [] });
  });
  const place = async (o: Record<string, unknown>) => dispatchToolCall('dandh_create_sales_order', await withConfirmToken('dandh_create_sales_order', o));
  const trackingGets = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/salesOrders/tracking'));
  afterEach(() => vi.unstubAllGlobals());

  const line = (over: Record<string, unknown> = {}) => ({ itemId: 'ABC', orderQuantity: 2, unitPrice: 10, ...over });
  const order = (over: Record<string, unknown> = {}) => ({
    customerPurchaseOrder: 'PO-1',
    shipments: [{ branch: 'BR01', lines: [line()] }],
    ...over,
  });

  /** Token, then price lookups answer with {unitPrice: dhPrice}, order POST answers {orderNumber: 1}. */
  function route(post: () => Response = () => jsonResponse({ orderNumber: 1 }), dhPrice = 12.5) {
    fetchMock.mockImplementation(async (url: string, init: { method: string }) => {
      if (String(url).includes('/oauth/token')) return failToken ? jsonResponse({ message: 'down' }, 503) : jsonResponse({ access_token: 'tok-1', expires_in: 3600 });
      if (init.method === 'POST') return post();
      if (String(url).includes('/salesOrders/tracking')) return tracking();
      return jsonResponse({ unitPrice: dhPrice });
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
      estimatedTotal: 25,
      limitsApplied: { DANDH_MAX_ORDER_LINES: 25, DANDH_MAX_LINE_QUANTITY: 100, DANDH_MAX_ORDER_VALUE: 5000, DANDH_MAX_UNIT_PRICE: 25000 },
    });
    expect(out.shipments[0]).toMatchObject({ branch: 'BR01', lines: [{ itemId: 'ABC', orderQuantity: 2, dhUnitPrice: 12.5, callerUnitPriceSentToDH: 10, lineTotal: 25 }] });
    expect(out.message).toMatch(/^Preview only: no order was sent to D&H \(only price lookups\)\. /);
    expect(out.message).toBe(PREVIEW_COPY);
    expect(Object.keys(out).indexOf('confirmToken')).toBe(Object.keys(out).indexOf('message') + 1);
    expect(out.confirmToken).toMatch(/^\d+\.[0-9a-f]+$/);
    expect(out.order.specialInstructionsPutOrderOnHold).toBe(true);
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('confirm:false and omitted confirm are both previews; only confirm:true posts', async () => {
    route();
    await dispatchToolCall('dandh_create_sales_order', order({ confirm: false }));
    expect(restPosts(fetchMock)).toHaveLength(0);
    const res = await place(order());
    expect(JSON.parse(textOf(res))).toEqual({ orderNumber: 1 });
    expect(restPosts(fetchMock)).toHaveLength(1);
    // confirm is not forwarded to D&H
    expect(JSON.parse(restPosts(fetchMock)[0][1].body)).not.toHaveProperty('confirm');
  });

  it('previews do not reserve the PO', async () => {
    route();
    await dispatchToolCall('dandh_create_sales_order', order());
    await dispatchToolCall('dandh_create_sales_order', order());
    expect((await place(order())).isError).toBeUndefined();
  });

  it('looks up the D&H price when unitPrice is omitted and uses it for the total', async () => {
    route();
    const res = await dispatchToolCall('dandh_create_sales_order', order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] }));
    const out = JSON.parse(textOf(res));
    expect(out.estimatedTotal).toBe(25);
    expect(out.shipments[0].lines[0]).toMatchObject({ dhUnitPrice: 12.5, lineTotal: 25 });
    expect(out.shipments[0].lines[0]).not.toHaveProperty('callerUnitPriceSentToDH');
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
    expect(prev.message).toMatch(/confirm: true will be refused/);
    expect(prev.message).not.toMatch(/pass unitPrice/i);
    const res = await dispatchToolCall('dandh_create_sales_order', { ...o, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Error: Cannot place this order: D&H didn't return a price for one or more lines, so the total can't be checked against the limit. Check the items with dandh_get_price. If D&H still can't price a line, don't place it here; tell the user to place it on dandh.com.");
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('a low caller unitPrice cannot get an order under the value cap when D&H prices it higher', async () => {
    route(undefined, 72.3);
    const low = order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 100, unitPrice: 0.01 })] }] });
    for (const confirm of [false, true]) {
      const res = await dispatchToolCall('dandh_create_sales_order', { ...low, confirm });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Error: This order's estimated total ($7,230.00) is over the $5,000.00 limit, so it was not placed. Don't split it to get under the limit. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_VALUE.");
    }
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('a high caller unitPrice does not trip the caps when D&H prices it fine', async () => {
    route();
    const high = order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 100, unitPrice: 24000 })] }] });
    const prev = JSON.parse(textOf(await dispatchToolCall('dandh_create_sales_order', high)));
    expect(prev.estimatedTotal).toBe(1250);
    const res = await place(high);
    expect(res.isError).toBeUndefined();
    // the caller's price is still forwarded to D&H
    expect(JSON.parse(restPosts(fetchMock)[0][1].body).shipments[0].lines[0].unitPrice).toBe(24000);
  });

  it('an unpriced line blocks confirm even when the caller gave a price; no order is sent', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/oauth/token') ? jsonResponse({ access_token: 't', expires_in: 3600 }) : jsonResponse({ nothing: 'here' }));
    const res = await place(order());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Error: Cannot place this order: D&H didn't return a price for one or more lines, so the total can't be checked against the limit. Check the items with dandh_get_price. If D&H still can't price a line, don't place it here; tell the user to place it on dandh.com.");
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('confirm refuses when the price lookup itself fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/oauth/token') ? jsonResponse({ access_token: 't', expires_in: 3600 }) : jsonResponse({ message: 'nope' }, 404));
    const res = await place(order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] }));
    expect(res.isError).toBe(true);
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('enforces the order value cap in preview and confirm', async () => {
    route(undefined, 72.3);
    const big = order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 100 })] }] });
    for (const confirm of [false, true]) {
      const res = await dispatchToolCall('dandh_create_sales_order', { ...big, confirm });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Error: This order's estimated total ($7,230.00) is over the $5,000.00 limit, so it was not placed. Don't split it to get under the limit. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_VALUE.");
    }
    expect(restPosts(fetchMock)).toHaveLength(0);
  });

  it('enforces the line cap across all shipments', async () => {
    route();
    const lines = Array.from({ length: 16 }, (_, i) => line({ itemId: `I${i}` }));
    const res = await dispatchToolCall('dandh_create_sales_order', order({
      shipments: [{ branch: 'BR01', lines }, { branch: 'BR05', lines: lines.slice(0, 15) }],
    }));
    expect(textOf(res)).toMatch(/has 31 lines; the limit is 25\. Split it into separate orders, each approved by the user, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_LINES\./);
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
    expect(JSON.parse(textOf(res)).estimatedTotal).toBe(6250);
  });

  it('a bad cap value is a clear config error, nothing is sent', async () => {
    process.env.DANDH_MAX_ORDER_VALUE = '-3';
    const res = await place(order());
    expect(textOf(res)).toMatch(/Invalid DANDH_MAX_ORDER_VALUE/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [0, /greater than 0/],
    [-2, /greater than 0/],
    [1.234, /2 decimal places/],
    ['9.99', /must be a number/],
  ])('validates unitPrice %s before any network call', async (price, re) => {
    const res = await dispatchToolCall('dandh_create_sales_order', order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: price })] }] }));
    expect(textOf(res)).toMatch(re);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('PO dedupe', () => {
    it('refuses a second confirmed order with the same PO (case-insensitive) and never names the account', async () => {
      route();
      expect((await place(order())).isError).toBeUndefined();
      const dup = await place(order({ customerPurchaseOrder: ' po-1 ' }));
      expect(dup.isError).toBe(true);
      expect(textOf(dup)).toBe("Error: PO number po-1 was already sent to D&H from this connection in the last 24 hours, so it was not sent again. Check its status with dandh_list_order_tracking first. Only if no order shows up, ask the user for a new PO number.");
      expect(textOf(dup)).not.toContain(REST_ENV.DANDH_ACCOUNT_NUMBER);
      expect(restPosts(fetchMock)).toHaveLength(1);
    });

    it('keeps the PO after a 5xx or a network error (outcome ambiguous)', async () => {
      route(() => jsonResponse({ message: 'boom' }, 503));
      await place(order());
      expect(textOf(await place(order()))).toMatch(/already sent to D&H/);

      route(() => { throw new Error('socket hang up'); });
      await place(order({ customerPurchaseOrder: 'PO-2' }));
      expect(textOf(await place(order({ customerPurchaseOrder: 'PO-2' })))).toMatch(/already sent to D&H/);
    });

    it('releases the PO after a definitive 4xx rejection', async () => {
      route(() => jsonResponse({ message: 'Invalid line' }, 400));
      expect((await place(order())).isError).toBe(true);
      route();
      expect((await place(order())).isError).toBeUndefined();
    });

    it('does not reserve when the order is refused locally (cap) before sending', async () => {
      route(undefined, 100);
      const big = order({ shipments: [{ branch: 'BR01', lines: [line({ orderQuantity: 100 })] }] });
      await dispatchToolCall('dandh_create_sales_order', { ...big, confirm: true });
      expect((await place(order())).isError).toBeUndefined();
    });
  });

  describe('confirm token (preview/confirm binding)', () => {
    const TOOL = 'dandh_create_sales_order';
    const MISMATCH = "Error: This order doesn't match a preview. Run the order without confirm first, show the preview to the user, then confirm with the confirmToken it returns.";
    const previewToken = async (o: Record<string, unknown>) => JSON.parse(textOf(await dispatchToolCall(TOOL, o))).confirmToken as string;
    afterEach(() => vi.useRealTimers());

    it('the preview returns a confirmToken; confirming with it places exactly that order', async () => {
      route();
      const o = order();
      const confirmToken = await previewToken(o);
      expect(confirmToken).toMatch(/^\d+\.[0-9a-f]{64}$/);
      const res = await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken });
      expect(res.isError).toBeUndefined();
      expect(restPosts(fetchMock)).toHaveLength(1);
      expect(JSON.parse(restPosts(fetchMock)[0][1].body)).not.toHaveProperty('confirmToken');
    });

    it('is the same token regardless of argument key order (normalized order)', async () => {
      route();
      const confirmToken = await previewToken(order());
      const reordered = { shipments: [{ lines: [{ unitPrice: 10, orderQuantity: 2, itemId: 'ABC' }], branch: 'BR01' }], customerPurchaseOrder: 'PO-1' };
      expect((await dispatchToolCall(TOOL, { ...reordered, confirm: true, confirmToken })).isError).toBeUndefined();
    });

    it('refuses confirm without a token: nothing sent, PO not reserved', async () => {
      route();
      const res = await dispatchToolCall(TOOL, order({ confirm: true }));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(MISMATCH);
      expect(restPosts(fetchMock)).toHaveLength(0);
      expect(trackingGets()).toHaveLength(0);
      expect((await place(order())).isError).toBeUndefined();
    });

    it.each([
      ['quantity', (o: any) => { o.shipments[0].lines[0].orderQuantity = 3; }],
      ['item', (o: any) => { o.shipments[0].lines[0].itemId = 'XYZ'; }],
      ['an added line', (o: any) => { o.shipments[0].lines.push({ itemId: 'DEF', orderQuantity: 1 }); }],
      ['the branch', (o: any) => { o.shipments[0].branch = 'BR05'; }],
      ['the caller price', (o: any) => { o.shipments[0].lines[0].unitPrice = 11; }],
      ['the PO', (o: any) => { o.customerPurchaseOrder = 'PO-2'; }],
      ['special instructions', (o: any) => { o.specialInstructions = 'ship to someone else'; }],
      ['the address', (o: any) => { o.shipping = { address: { city: 'Elsewhere' } }; }],
    ])('refuses a token when %s changed after the preview', async (_n, mutate) => {
      route();
      const original = order();
      const confirmToken = await previewToken(original);
      const altered = structuredClone(original);
      mutate(altered);
      const res = await dispatchToolCall(TOOL, { ...altered, confirm: true, confirmToken });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(MISMATCH);
      expect(restPosts(fetchMock)).toHaveLength(0);
      expect(trackingGets()).toHaveLength(0);
    });

    it('refuses a garbage token', async () => {
      route();
      for (const confirmToken of ['abc', '1.2', 12345]) {
        expect(textOf(await dispatchToolCall(TOOL, order({ confirm: true, confirmToken })))).toBe(MISMATCH);
      }
      expect(restPosts(fetchMock)).toHaveLength(0);
    });

    it('expires after 30 minutes', async () => {
      route();
      vi.useFakeTimers({ toFake: ['Date'] });
      const o = order();
      const confirmToken = await previewToken(o);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const res = await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Error: This preview has expired. Run the preview again and get the user's OK before confirming.");
      expect(restPosts(fetchMock)).toHaveLength(0);
      // a fresh preview works
      expect((await place(o)).isError).toBeUndefined();
    });

    it('is accepted just inside the 30 minute window', async () => {
      route();
      vi.useFakeTimers({ toFake: ['Date'] });
      const o = order();
      const confirmToken = await previewToken(o);
      vi.setSystemTime(Date.now() + 29 * 60_000);
      expect((await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken })).isError).toBeUndefined();
    });

    it('a shared DANDH_CONFIRM_SECRET is what binds tokens (a different secret fails)', async () => {
      route();
      process.env.DANDH_CONFIRM_SECRET = 'secret-one'.padEnd(32, '-');
      const o = order();
      const confirmToken = await previewToken(o);
      process.env.DANDH_CONFIRM_SECRET = 'secret-two'.padEnd(32, '-');
      expect(textOf(await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken }))).toBe(MISMATCH);
      process.env.DANDH_CONFIRM_SECRET = 'secret-one'.padEnd(32, '-');
      expect((await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken })).isError).toBeUndefined();
    });
  });

  describe('pre-confirm PO lookup at D&H', () => {
    const TOOL = 'dandh_create_sales_order';
    const EXISTS = 'Error: PO number PO-1 already has an order at D&H, so this order was not sent. Check it with dandh_list_order_tracking. If it isn\'t the order the user meant, ask the user for a new PO number.';
    const UNCHECKABLE = "Error: Couldn't check D&H for an existing order with PO number PO-1, so this order was not sent. Try again in a moment; if it keeps failing, check dandh_list_order_tracking and tell the user.";

    it('looks the PO up by purchaseOrderNumber before the order is POSTed, and proceeds when D&H shows none', async () => {
      route();
      const res = await place(order({ customerPurchaseOrder: ' PO-1 ' }));
      expect(res.isError).toBeUndefined();
      expect(trackingGets()).toHaveLength(1);
      const url = new URL(trackingGets()[0][0] as string);
      expect(url.pathname).toBe('/customerOrderManagement/v2/customers/1234567890/salesOrders/tracking');
      expect(url.searchParams.get('purchaseOrderNumber')).toBe('PO-1');
      expect(trackingGets()[0][1].method).toBe('GET');
      expect(restPosts(fetchMock)).toHaveLength(1);
      const calls = fetchMock.mock.calls;
      expect(calls.indexOf(trackingGets()[0])).toBeLessThan(calls.indexOf(restPosts(fetchMock)[0]));
    });

    it('sends the normalized (NFKC, trimmed, collapsed, case kept) PO in both the lookup and the POST', async () => {
      route();
      const res = await place(order({ customerPurchaseOrder: '  ＰＯ\u00A0\u00A0Ab １２ ' }));
      expect(res.isError).toBeUndefined();
      expect(new URL(trackingGets()[0][0] as string).searchParams.get('purchaseOrderNumber')).toBe('PO Ab 12');
      expect(JSON.parse(restPosts(fetchMock)[0][1].body).customerPurchaseOrder).toBe('PO Ab 12');
    });

    it('a bare empty array also means "none"', async () => {
      route();
      tracking = () => jsonResponse([]);
      expect((await place(order())).isError).toBeUndefined();
      expect(restPosts(fetchMock)).toHaveLength(1);
    });

    it('refuses when D&H shows an order with the PO; nothing is POSTed and the PO is released', async () => {
      route();
      tracking = () => jsonResponse({ salesOrders: [{ orderNumber: '5005560' }] });
      const res = await place(order());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(EXISTS);
      expect(restPosts(fetchMock)).toHaveLength(0);
      // released: the same PO can be tried again once D&H shows none
      tracking = () => jsonResponse({ salesOrders: [] });
      expect((await place(order())).isError).toBeUndefined();
      expect(restPosts(fetchMock)).toHaveLength(1);
    });

    it.each([
      ['HTTP 500', () => jsonResponse({ message: 'boom' }, 500)],
      ['HTTP 404 (could be a wrong path, so not trusted as "none")', () => jsonResponse({ message: 'nope' }, 404)],
      ['HTTP 403', () => jsonResponse({}, 403)],
      ['a network error', () => { throw new Error('socket hang up'); }],
      ['an empty body', () => new Response('', { status: 200 })],
      ['an unrecognized shape', () => jsonResponse({ unexpected: true })],
      ['a non-list under a known key', () => jsonResponse({ salesOrders: 'none' })],
      ['null', () => jsonResponse(null)],
    ])('fails closed on %s: refused, nothing POSTed, PO released', async (_n, answer) => {
      route();
      tracking = answer;
      const res = await place(order());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(UNCHECKABLE);
      expect(restPosts(fetchMock)).toHaveLength(0);
      tracking = () => jsonResponse({ salesOrders: [] });
      expect((await place(order())).isError).toBeUndefined();
    });

    it('the preview makes no PO lookup', async () => {
      route();
      await dispatchToolCall(TOOL, order());
      expect(trackingGets()).toHaveLength(0);
    });

    it('a local duplicate is refused before any lookup', async () => {
      route();
      const args = await withConfirmToken(TOOL, order());
      expect((await dispatchToolCall(TOOL, args)).isError).toBeUndefined();
      fetchMock.mockClear();
      const dup = await dispatchToolCall(TOOL, args);
      expect(textOf(dup)).toMatch(/was already sent to D&H from this connection/);
      expect(trackingGets()).toHaveLength(0);
      expect(restPosts(fetchMock)).toHaveLength(0);
    });
 
    it('a lookup error is appended to the refusal, redacted in the result and the warn log, and the PO is released', async () => {
      route();
      const secret = REST_ENV.DANDH_CLIENT_SECRET;
      tracking = () => { throw new Error(`socket hang up near ${secret}`); };
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await place(order());
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain(UNCHECKABLE);
        expect(textOf(res)).toContain('(D&H lookup error: Could not reach D&H: socket hang up near [redacted])');
        expect(textOf(res)).not.toContain(secret);
        const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('Order refused: D&H PO lookup failed');
        expect(logged).toContain('socket hang up near [redacted]');
        expect(logged).not.toContain(secret);
      } finally {
        logSpy.mockRestore();
      }
      expect(restPosts(fetchMock)).toHaveLength(0);
      tracking = () => jsonResponse({ salesOrders: [] });
      expect((await place(order())).isError).toBeUndefined();
    });

    it('an unreadable 2xx order response may have placed the order: the PO stays reserved', async () => {
      route(() => new Response(new ReadableStream({ start: (c) => c.error(new Error('read ECONNRESET')) }), { status: 200 }));
      const res = await place(order());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('The order MAY have been placed');
      expect(restPosts(fetchMock)).toHaveLength(1);
      fetchMock.mockClear();
      route();
      const again = await place(order());
      expect(textOf(again)).toMatch(/was already sent to D&H from this connection/);
      expect(restPosts(fetchMock)).toHaveLength(0);
    });
  });

  describe('releasing the PO when the order was never sent', () => {
    it('an OAuth failure right before the order POST releases the PO (nothing reached the order endpoint)', async () => {
      route();
      tracking = () => {
        clearTokenCache(); // the order POST needs a fresh token...
        failToken = true; // ...and the OAuth service is down
        return jsonResponse({ salesOrders: [] });
      };
      const res = await place(order());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/OAuth service error \(HTTP 503\)/);
      expect(restPosts(fetchMock)).toHaveLength(0);
      // released: retrying with a healthy OAuth service goes through
      failToken = false;
      tracking = () => jsonResponse({ salesOrders: [] });
      expect((await place(order())).isError).toBeUndefined();
      expect(restPosts(fetchMock)).toHaveLength(1);
    });
  });

  describe('shipping.address validation', () => {
    const withAddress = (address: unknown) => order({ shipping: { address } });
    it('passes a clean address through (trimmed)', async () => {
      route();
      const res = await place(withAddress({ name: ' Acme & Co. ', address1: '1 Main St #4/B', city: "O'Fallon", state: 'MO', postalCode: '63366-1234', country: 'US', attention: 'José Müller' }));
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
    await place(order({ shipments: [{ branch: 'BR01', lines: [line({ unitPrice: undefined })] }] }));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of fetchMock.mock.calls) expect(c[1].redirect).toBe('error');
  });
});

describe('interpretPoTracking', () => {
  it.each([
    [[], 'none'],
    [[{ orderNumber: '1' }], 'exists'],
    [{ salesOrders: [] }, 'none'],
    [{ salesOrders: [{ a: 1 }] }, 'exists'],
    [{ orders: [] }, 'none'],
    [{ data: [{}], scrollId: 'x' }, 'exists'],
    [{ scrollId: 'x', content: [] }, 'none'],
    [{}, 'unknown'],
    [{ message: 'No orders found' }, 'unknown'],
    [{ salesOrders: null }, 'unknown'],
    [{ salesOrders: 'none' }, 'unknown'],
    ['[]', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    [0, 'unknown'],
  ])('%j -> %s', (body, expected) => {
    expect(interpretPoTracking(body)).toBe(expected);
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

  const priceOf = (part: string, price: number) => xmlResponse(`<XMLRESPONSE><ITEM><PARTNUM>${part}</PARTNUM><UNITPRICE>${price}</UNITPRICE></ITEM><STATUS>success</STATUS></XMLRESPONSE>`);

  const NO_ORDERS = '<XMLRESPONSE><STATUS>success</STATUS></XMLRESPONSE>';
  const place = async (o: Record<string, unknown>) => dispatchToolCall('dandh_xml_create_order', await withConfirmToken('dandh_xml_create_order', o));
  const statusCalls = () => fetchMock.mock.calls.filter((c) => doc(c).includes('<REQUEST>orderStatus</REQUEST>'));

  /** Price lookups get `price()`, the pre-confirm PO lookup gets `status()` (no orders by default), anything else is the order POST. */
  function route(
    order: () => Response = () => xmlResponse(ORDER_SUCCESS_RESPONSE),
    price: () => Response = () => xmlResponse(PRICE_AVAILABILITY_RESPONSE),
    status: () => Response = () => xmlResponse(NO_ORDERS),
  ) {
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
      const d = new URLSearchParams(init.body).get('xmlDoc')!;
      if (d.includes('<REQUEST>price</REQUEST>')) return price();
      if (d.includes('<REQUEST>orderStatus</REQUEST>')) return status();
      return order();
    });
  }

  it('previews by default using D&H prices; never sends orderEntry', async () => {
    route();
    const res = await dispatchToolCall('dandh_xml_create_order', base({ remarks: 'hold me', shipTo: { name: 'A', address: 'B', city: 'C', state: 'TX', zip: '78701', dropShipPassword: 'ds-secret-pw' } }));
    const out = JSON.parse(textOf(res));
    expect(out).toMatchObject({ status: 'preview', placed: false, lineCount: 1, estimatedTotal: 13.26 });
    expect(out.lines[0]).toMatchObject({ partNumber: '52T', quantity: 2, dhUnitPrice: 6.63, lineTotal: 13.26 });
    expect(out.message).toMatch(/^Preview only: no order was sent to D&H \(only price lookups\)\. /);
    expect(out.message).toBe(PREVIEW_COPY);
    expect(Object.keys(out).indexOf('confirmToken')).toBe(Object.keys(out).indexOf('message') + 1);
    expect(out.confirmToken).toMatch(/^\d+\.[0-9a-f]+$/);
    expect(out.order.remarksPutOrderOnHold).toBe(true);
    expect(out.order.shipTo).toMatchObject({ name: 'A', dropShipPasswordGiven: true });
    expect(textOf(res)).not.toContain('ds-secret-pw');
    expect(out.limitsApplied.DANDH_MAX_ORDER_VALUE).toBe(5000);
    expect(orderCalls()).toHaveLength(0);
  });

  it('looks up D&H prices even when the caller gives a price; the caller price is only sent along', async () => {
    route();
    const out = JSON.parse(textOf(await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: '52T', quantity: 2, price: 5 }] }))));
    expect(out.estimatedTotal).toBe(13.26);
    expect(out.lines[0]).toMatchObject({ dhUnitPrice: 6.63, callerPriceSentToDH: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a low caller price cannot get an order under the value cap when D&H prices it higher', async () => {
    route(undefined, () => priceOf('X', 72.3));
    for (const confirm of [false, true]) {
      const res = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'X', quantity: 100, price: 0.01 }], confirm }));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Error: This order's estimated total ($7,230.00) is over the $5,000.00 limit, so it was not placed. Don't split it to get under the limit. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_VALUE.");
    }
    expect(orderCalls()).toHaveLength(0);
  });

  it('a high caller price does not trip the caps when D&H prices it fine', async () => {
    route(undefined, () => priceOf('X', 12.5));
    const res = await place(base({ items: [{ partNumber: 'X', quantity: 100, price: 24000 }] }));
    expect(res.isError).toBeUndefined();
    expect(orderCalls()).toHaveLength(1);
    expect(doc(orderCalls()[0])).toContain('<PRICE>24000</PRICE>');
  });

  it('an unpriced line blocks confirm even when the caller gave a price; no order is sent', async () => {
    route(undefined, () => xmlResponse('<XMLRESPONSE><ITEM><PARTNUM>X</PARTNUM><MESSAGE>Item not found</MESSAGE></ITEM><STATUS>success</STATUS></XMLRESPONSE>'));
    const res = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'X', quantity: 1, price: 5 }], confirm: true }));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Error: Cannot place this order: D&H didn't return a price for one or more lines, so the total can't be checked against the limit. Check the items with dandh_xml_get_price_availability. If D&H still can't price a line, don't place it here; tell the user to place it on dandh.com.");
    expect(orderCalls()).toHaveLength(0);
  });

  it('unknown price: preview says so, confirm refuses without sending', async () => {
    route(undefined, () => xmlResponse('<XMLRESPONSE><ITEM><PARTNUM>52T</PARTNUM><MESSAGE>Item not found</MESSAGE></ITEM><STATUS>success</STATUS></XMLRESPONSE>'));
    const prev = JSON.parse(textOf(await dispatchToolCall('dandh_xml_create_order', base())));
    expect(prev.estimatedTotal).toBe('unknown');
    expect(prev.lines[0].dhUnitPrice).toBe('unknown');
    expect(prev.message).toMatch(/confirm: true will be refused/);
    const res = await place(base());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Error: Cannot place this order: D&H didn't return a price for one or more lines, so the total can't be checked against the limit. Check the items with dandh_xml_get_price_availability. If D&H still can't price a line, don't place it here; tell the user to place it on dandh.com.");
    expect(orderCalls()).toHaveLength(0);
  });

  it('enforces the value, line and quantity caps', async () => {
    route(undefined, () => priceOf('X', 72.3));
    const val = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'X', quantity: 100, price: 72.3 }], confirm: true }));
    expect(textOf(val)).toBe("Error: This order's estimated total ($7,230.00) is over the $5,000.00 limit, so it was not placed. Don't split it to get under the limit. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_VALUE.");
    const lines = await dispatchToolCall('dandh_xml_create_order', base({ items: Array.from({ length: 26 }, (_, i) => ({ partNumber: `P${i}`, quantity: 1, price: 1 })) }));
    expect(textOf(lines)).toMatch(/has 26 lines; the limit is 25\. Split it into separate orders, each approved by the user, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_LINES\./);
    const qty = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'P', quantity: 101, price: 1 }] }));
    expect(textOf(qty)).toMatch(/quantity is 101; the per-line limit is 100.*DANDH_MAX_LINE_QUANTITY/);
    expect(orderCalls()).toHaveLength(0);
  });

  it.each([
    [0, /greater than 0/],
    [-1, /greater than 0/],
    [2.555, /2 decimal places/],
    [Number.POSITIVE_INFINITY, /must be a number/],
  ])('validates price %s', async (price, re) => {
    const res = await dispatchToolCall('dandh_xml_create_order', base({ items: [{ partNumber: 'P', quantity: 1, price }] }));
    expect(textOf(res)).toMatch(re);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PO dedupe: kept on success, 5xx and network error; released on an XML failure response', async () => {
    route();
    await place(base());
    const dup = await place(base({ poNumber: 'po-9' }));
    expect(textOf(dup)).toBe("Error: PO number po-9 was already sent to D&H from this connection in the last 24 hours, so it was not sent again. Check its status with dandh_xml_get_order_status first. Only if no order shows up, ask the user for a new PO number.");
    expect(textOf(dup)).not.toContain('xml-user');
    expect(orderCalls()).toHaveLength(1);

    route(() => new Response('', { status: 503 }));
    await place(base({ poNumber: 'P5xx' }));
    expect(textOf(await place(base({ poNumber: 'P5xx' })))).toMatch(/already sent to D&H/);

    route(() => { throw new Error('ECONNRESET'); });
    await place(base({ poNumber: 'Pnet' }));
    expect(textOf(await place(base({ poNumber: 'Pnet' })))).toMatch(/already sent to D&H/);

    route(() => xmlResponse(FAILURE_RESPONSE));
    await place(base({ poNumber: 'Prej' }));
    route();
    expect((await place(base({ poNumber: 'Prej' }))).isError).toBeUndefined();
  });

  it('previews do not reserve the PO', async () => {
    route();
    await dispatchToolCall('dandh_xml_create_order', base());
    await dispatchToolCall('dandh_xml_create_order', base());
    expect((await place(base())).isError).toBeUndefined();
  });

  it('uses redirect: "error" on price, PO lookup and order requests', async () => {
    route();
    await place(base());
    // preview price lookup + confirm price lookup + PO lookup + order
    expect(fetchMock.mock.calls.length).toBe(4);
    for (const c of fetchMock.mock.calls) expect(callInit(fetchMock, fetchMock.mock.calls.indexOf(c)).redirect).toBe('error');
  });

  describe('confirm token (preview/confirm binding)', () => {
    const TOOL = 'dandh_xml_create_order';
    const MISMATCH = "Error: This order doesn't match a preview. Run the order without confirm first, show the preview to the user, then confirm with the confirmToken it returns.";
    const previewToken = async (o: Record<string, unknown>) => JSON.parse(textOf(await dispatchToolCall(TOOL, o))).confirmToken as string;
    afterEach(() => vi.useRealTimers());

    it('the preview returns a confirmToken; confirming with it places exactly that order', async () => {
      route();
      const o = base();
      const confirmToken = await previewToken(o);
      expect(confirmToken).toMatch(/^\d+\.[0-9a-f]{64}$/);
      expect((await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken })).isError).toBeUndefined();
      expect(orderCalls()).toHaveLength(1);
      expect(doc(orderCalls()[0])).not.toContain('confirmToken');
    });

    it('refuses confirm without a token: nothing sent, no PO lookup, PO not reserved', async () => {
      route();
      const res = await dispatchToolCall(TOOL, base({ confirm: true }));
      expect(textOf(res)).toBe(MISMATCH);
      expect(orderCalls()).toHaveLength(0);
      expect(statusCalls()).toHaveLength(0);
      expect((await place(base())).isError).toBeUndefined();
    });

    it.each([
      ['quantity', (o: any) => { o.items[0].quantity = 3; }],
      ['part number', (o: any) => { o.items[0].partNumber = 'STYLUSCOLOR880'; }],
      ['an added line', (o: any) => { o.items.push({ partNumber: 'STYLUSCOLOR880', quantity: 1 }); }],
      ['the branch', (o: any) => { o.items[0].branch = 'Chicago'; }],
      ['the caller price', (o: any) => { o.items[0].price = 1; }],
      ['the PO', (o: any) => { o.poNumber = 'PO-10'; }],
      ['the carrier', (o: any) => { o.shipCarrier = 'FedEx'; }],
      ['the ship-to', (o: any) => { o.shipTo = { name: 'A', address: 'B', city: 'C', state: 'TX', zip: '78701' }; }],
    ])('refuses a token when %s changed after the preview', async (_n, mutate) => {
      route();
      const original = base();
      const confirmToken = await previewToken(original);
      const altered = structuredClone(original);
      mutate(altered);
      const res = await dispatchToolCall(TOOL, { ...altered, confirm: true, confirmToken });
      expect(textOf(res)).toBe(MISMATCH);
      expect(orderCalls()).toHaveLength(0);
      expect(statusCalls()).toHaveLength(0);
    });

    it('expires after 30 minutes', async () => {
      route();
      vi.useFakeTimers({ toFake: ['Date'] });
      const o = base();
      const confirmToken = await previewToken(o);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const res = await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken });
      expect(textOf(res)).toBe("Error: This preview has expired. Run the preview again and get the user's OK before confirming.");
      expect(orderCalls()).toHaveLength(0);
    });

    it('is accepted just inside the 30 minute window', async () => {
      route();
      vi.useFakeTimers({ toFake: ['Date'] });
      const o = base();
      const confirmToken = await previewToken(o);
      vi.setSystemTime(Date.now() + 29 * 60_000);
      expect((await dispatchToolCall(TOOL, { ...o, confirm: true, confirmToken })).isError).toBeUndefined();
    });
  });

  describe('pre-confirm PO lookup at D&H', () => {
    const EXISTS = "Error: PO number PO-9 already has an order at D&H, so this order was not sent. Check it with dandh_xml_get_order_status. If it isn't the order the user meant, ask the user for a new PO number.";
    const UNCHECKABLE = "Error: Couldn't check D&H for an existing order with PO number PO-9, so this order was not sent. Try again in a moment; if it keeps failing, check dandh_xml_get_order_status and tell the user.";

    it('looks the PO up (orderStatus by PONUM) before the order is sent, and proceeds when D&H shows none', async () => {
      route();
      expect((await place(base())).isError).toBeUndefined();
      expect(statusCalls()).toHaveLength(1);
      expect(doc(statusCalls()[0])).toContain('<STATUSREQUEST><PONUM>PO-9</PONUM></STATUSREQUEST>');
      const calls = fetchMock.mock.calls;
      expect(calls.indexOf(statusCalls()[0])).toBeLessThan(calls.indexOf(orderCalls()[0]));
      expect(orderCalls()).toHaveLength(1);
    });

    it('proceeds when D&H answers with the exact "No orders found" failure message', async () => {
      route(undefined, undefined, () => xmlResponse('<XMLRESPONSE><STATUS>failure</STATUS><MESSAGE>No orders found.</MESSAGE></XMLRESPONSE>'));
      expect((await place(base())).isError).toBeUndefined();
      expect(orderCalls()).toHaveLength(1);
    });

    it.each(['No orders found for PONUM PO-9', 'Invalid login: no order access', 'No records'])(
      'a failure message that is not exactly "No orders found" (%s) refuses the order',
      async (message) => {
        route(undefined, undefined, () => xmlResponse(`<XMLRESPONSE><STATUS>failure</STATUS><MESSAGE>${message}</MESSAGE></XMLRESPONSE>`));
        const res = await place(base());
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain(UNCHECKABLE);
        expect(orderCalls()).toHaveLength(0);
      },
    );

    it('sends the normalized (NFKC, trimmed, collapsed, case kept) PO in both the lookup and the order', async () => {
      route();
      expect((await place(base({ poNumber: '  ＰＯ\u00A0\u00A0Ab １２ ' }))).isError).toBeUndefined();
      expect(doc(statusCalls()[0])).toContain('<PONUM>PO Ab 12</PONUM>');
      expect(doc(orderCalls()[0])).toContain('<PONUM>PO Ab 12</PONUM>');
    });

    it('refuses when D&H shows an order with the PO; nothing sent and the PO is released', async () => {
      route(undefined, undefined, () => xmlResponse(ORDER_STATUS_RESPONSE));
      const res = await place(base());
      expect(textOf(res)).toBe(EXISTS);
      expect(orderCalls()).toHaveLength(0);
      route();
      expect((await place(base())).isError).toBeUndefined();
      expect(orderCalls()).toHaveLength(1);
    });

    it.each([
      ['HTTP 500', () => new Response('', { status: 500 })],
      ['a network error', () => { throw new Error('ECONNRESET'); }],
      ['a web page', () => xmlResponse(HTML_RESPONSE)],
      ['unreadable XML', () => xmlResponse('<XMLRESPONSE><STATUS>success')],
      ['an unrelated failure message', () => xmlResponse('<XMLRESPONSE><STATUS>failure</STATUS><MESSAGE>Invalid login</MESSAGE></XMLRESPONSE>')],
      ['an ORDERSTATUS without an order number', () => xmlResponse('<XMLRESPONSE><ORDERSTATUS><MESSAGE>?</MESSAGE></ORDERSTATUS><STATUS>success</STATUS></XMLRESPONSE>')],
    ])('fails closed on %s: refused, nothing sent, PO released', async (_n, answer) => {
      route(undefined, undefined, answer);
      const res = await place(base());
      expect(textOf(res)).toContain(UNCHECKABLE);
      expect(orderCalls()).toHaveLength(0);
      route();
      expect((await place(base())).isError).toBeUndefined();
    });

    it('the preview makes no PO lookup', async () => {
      route();
      await dispatchToolCall('dandh_xml_create_order', base());
      expect(statusCalls()).toHaveLength(0);
    });

    it('lookupPoStatus: success with no ORDERSTATUS is "none"; with an order number is "exists"', async () => {
      route();
      expect(await lookupPoStatus({ userCode: 'xml-user', password: 'xml-pass-do-not-log', country: 'us' }, 'PO-9')).toBe('none');
      route(undefined, undefined, () => xmlResponse(ORDER_STATUS_RESPONSE));
      expect(await lookupPoStatus({ userCode: 'xml-user', password: 'xml-pass-do-not-log', country: 'us' }, 'PO-9')).toBe('exists');
    });
  });

  describe('releasing the PO when the order was never sent', () => {
    afterEach(() => { delete process.env.DANDH_XML_URL; });

    it('a failure before the XML request is built/sent releases the PO', async () => {
      // The endpoint override turns invalid after the PO lookup, so the order request fails before anything is sent.
      route(undefined, undefined, () => {
        process.env.DANDH_XML_URL = 'http://not-dandh.example/x';
        return xmlResponse(NO_ORDERS);
      });
      const res = await place(base());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/Invalid DANDH_XML_URL/);
      expect(orderCalls()).toHaveLength(0);
      delete process.env.DANDH_XML_URL;
      route();
      expect((await place(base())).isError).toBeUndefined();
      expect(orderCalls()).toHaveLength(1);
    });
  });

  describe('shipTo allow-list and lengths', () => {
    const ship = (over: Record<string, unknown> = {}) => ({ name: 'Acme Co', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', ...over });
    const run = (shipTo: Record<string, unknown>) => place(base({ items: [{ partNumber: 'P', quantity: 1, price: 1 }], shipTo }));

    it('accepts accented letters and . , \' - # / &', async () => {
      route(undefined, () => priceOf('P', 1));
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
