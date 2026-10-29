import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { REST_ENV, callInit, callUrl, jsonResponse, queue, setupEnv, stubFetch, textOf, withConfirmToken } from './test-helpers.js';

const BASE = '/customerOrderManagement/v2/customers/1234567890';

describe('REST tools', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    setupEnv(REST_ENV);
    fetchMock = stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function get(name: string, args: Record<string, unknown>, body: unknown = { ok: true }) {
    // The OAuth token is cached after the first call in a test.
    if (fetchMock.mock.calls.length === 0) queue(fetchMock, jsonResponse(body));
    else fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const res = await dispatchToolCall(name, args);
    const last = fetchMock.mock.calls.length - 1;
    return { res, url: callUrl(fetchMock, last), init: callInit(fetchMock, last) };
  }

  it.each([
    ['dandh_get_item', {}, '/items/AB%2FC%20D', {}],
    ['dandh_get_price', { quantity: 5 }, '/items/AB%2FC%20D/price', { quantity: '5' }],
    ['dandh_get_availability', {}, '/items/AB%2FC%20D/availability', {}],
    ['dandh_get_price_and_availability', { quantity: 3 }, '/items/AB%2FC%20D/priceAndAvailability', { quantity: '3' }],
  ])('%s: GET path + query, itemId URL-encoded', async (name, extra, path, query) => {
    const { res, url, init } = await get(name, { itemId: 'AB/C D', ...extra });
    expect(res.isError).toBeUndefined();
    expect(init.method).toBe('GET');
    expect(url.href).toContain(`${BASE}${path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
    expect(JSON.parse(textOf(res))).toEqual({ ok: true });
  });

  it.each([
    ['dandh_get_prices_bulk', '/items/price/bulk'],
    ['dandh_get_availability_bulk', '/items/availability/bulk'],
    ['dandh_get_price_and_availability_bulk', '/items/priceAndAvailability/bulk'],
  ])('%s: bulk path and CSV query', async (name, path) => {
    const { url } = await get(name, { items: ['A', 'B'], customerItemNumbers: ['X'] });
    expect(url.pathname).toBe(`${BASE}${path}`);
    expect(url.searchParams.get('items')).toBe('A,B');
    expect(url.searchParams.get('customerItemNumbers')).toBe('X');
  });

  it.each([
    'dandh_get_prices_bulk', 'dandh_get_availability_bulk', 'dandh_get_price_and_availability_bulk',
  ])('%s caps at 50 items before any network call', async (name) => {
    queue(fetchMock, jsonResponse({}));
    const ok = await dispatchToolCall(name, { items: Array.from({ length: 50 }, (_, i) => `I${i}`) });
    expect(ok.isError).toBeUndefined();
    fetchMock.mockClear();
    const over = await dispatchToolCall(name, { items: Array.from({ length: 51 }, (_, i) => `I${i}`) });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toMatch(/maximum is 50|maximum 50/);
    const split = await dispatchToolCall(name, { items: Array.from({ length: 30 }, (_, i) => `I${i}`), customerItemNumbers: Array.from({ length: 21 }, (_, i) => `C${i}`) });
    expect(split.isError).toBe(true);
    expect((await dispatchToolCall(name, {})).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('search requires exactly one identifier type', async () => {
    fetchMock.mockClear();
    for (const args of [{}, { vendorItemId: 'A', universalProductCode: '1' }, { items: ['A'], customerItemNumber: 'B' }]) {
      const res = await dispatchToolCall('dandh_search_items', args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/exactly one/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const { url } = await get('dandh_search_items', { vendorItemId: 'MPN-1', pageSize: 10, scrollId: 'sc1' });
    expect(url.pathname).toBe(`${BASE}/items`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ vendorItemId: 'MPN-1', pageSize: '10', scrollId: 'sc1' });
  });

  it('search accepts one list identifier as CSV', async () => {
    const { url } = await get('dandh_search_items', { vendorItemIds: ['M1', 'M2'] });
    expect(url.searchParams.get('vendorItemIds')).toBe('M1,M2');
  });

  it('surfaces scrollId from the body and from the x-scroll-id header without looping', async () => {
    queue(fetchMock, jsonResponse({ elements: [1], scrollId: 'body-s', hasNext: true }));
    expect(JSON.parse(textOf(await dispatchToolCall('dandh_list_carriers', {}))).scrollId).toBe('body-s');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(jsonResponse([{ c: 1 }], 200, { 'x-scroll-id': 'hdr-s' }));
    expect(JSON.parse(textOf(await dispatchToolCall('dandh_list_carriers', { shipMode: 'GROUND' })))).toEqual({ elements: [{ c: 1 }], scrollId: 'hdr-s' });
    expect(callUrl(fetchMock, 2).pathname).toBe(`${BASE}/carriers`);
    expect(callUrl(fetchMock, 2).searchParams.get('shipMode')).toBe('GROUND');
  });

  it('order tracking: single and list', async () => {
    const one = await get('dandh_get_order_tracking', { orderId: '123/4' });
    expect(one.url.href).toContain(`${BASE}/salesOrders/123%2F4/tracking`);
    const list = await get('dandh_list_order_tracking', { purchaseOrderNumber: 'PO-1' });
    expect(list.url.pathname).toBe(`${BASE}/salesOrders/tracking`);
    expect(list.url.searchParams.get('purchaseOrderNumber')).toBe('PO-1');
    const bad = await dispatchToolCall('dandh_list_order_tracking', { orderNumber: '1', invoiceNumber: '2' });
    expect(bad.isError).toBe(true);
  });
});

describe('dandh_create_sales_order', () => {
  const TOOL = 'dandh_create_sales_order';
  let fetchMock: ReturnType<typeof stubFetch>;
  let tokenQueued: boolean;
  beforeEach(() => {
    setupEnv(REST_ENV);
    fetchMock = stubFetch();
    tokenQueued = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  const price = () => jsonResponse({ unitPrice: 9.5 });
  /** Runs the preview (OAuth token + price lookup) and returns the confirm args. The fetch log is cleared afterwards. */
  async function confirmable(o: Record<string, unknown>) {
    if (!tokenQueued) queue(fetchMock, price());
    else fetchMock.mockResolvedValueOnce(price());
    tokenQueued = true;
    const args = await withConfirmToken(TOOL, o);
    fetchMock.mockClear();
    return args;
  }
  /** Queues what a confirm makes: price lookup, PO lookup (no orders), then the given order POST outcome. */
  function queueConfirm(post: Response | Error) {
    fetchMock.mockResolvedValueOnce(price());
    fetchMock.mockResolvedValueOnce(jsonResponse({ salesOrders: [] }));
    if (post instanceof Error) fetchMock.mockRejectedValueOnce(post);
    else fetchMock.mockResolvedValueOnce(post);
  }

  const order = {
    customerPurchaseOrder: 'PO-100',
    specialInstructions: 'call first',
    shipping: { carrier: 'UPS', serviceType: 'GROUND', allowBackOrder: false },
    shipments: [{ branch: 'BR05', lines: [{ itemId: 'ABC', orderQuantity: 2, unitPrice: 9.5 }] }],
  };

  it('POSTs the expected body', async () => {
    const args = await confirmable(order);
    queueConfirm(jsonResponse({ orderNumber: 1 }));
    const res = await dispatchToolCall(TOOL, args);
    expect(res.isError).toBeUndefined();
    const init = callInit(fetchMock, 2);
    expect(init.method).toBe('POST');
    expect(callUrl(fetchMock, 2).pathname).toBe(`${BASE}/salesOrders`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(order);
  });

  it('never retries on 5xx or after a network error', async () => {
    const args = await confirmable(order);
    queueConfirm(jsonResponse({ message: 'boom' }, 503));
    const res = await dispatchToolCall(TOOL, args);
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // price, PO lookup, one order POST

    fetchMock.mockClear();
    const args2 = await confirmable({ ...order, customerPurchaseOrder: 'PO-101' });
    queueConfirm(new Error('socket hang up'));
    const net = await dispatchToolCall(TOOL, args2);
    expect(textOf(net)).toMatch(/MAY have been placed/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a POST after a 401 (token is dropped, order not re-sent)', async () => {
    const args = await confirmable(order);
    queueConfirm(jsonResponse({}, 401));
    const res = await dispatchToolCall(TOOL, args);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/NOT retried automatically/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('explains a duplicate-PO 400', async () => {
    const args = await confirmable(order);
    queueConfirm(jsonResponse({ message: 'Duplicate PO' }, 400));
    const res = await dispatchToolCall(TOOL, args);
    expect(textOf(res)).toMatch(/Duplicate PO[\s\S]*PO numbers must be unique/);
  });

  it.each([
    ['bad branch', { shipments: [{ branch: 'BR99', lines: [{ itemId: 'A', orderQuantity: 1 }] }] }, /branch "BR99"/],
    ['no shipments', { shipments: [] }, /shipments/],
    ['zero qty', { shipments: [{ branch: 'BR01', lines: [{ itemId: 'A', orderQuantity: 0 }] }] }, /orderQuantity/],
    ['no lines', { shipments: [{ branch: 'BR01', lines: [] }] }, /lines/],
    ['carrier without service', { shipping: { carrier: 'UPS' } }, /together/],
    ['missing PO', { customerPurchaseOrder: '' }, /customerPurchaseOrder is required/],
    ['unknown key', { surprise: 1 }, /Unknown field/],
    ['accountNumber override', { accountNumber: '0987654321' }, /Unknown field\(s\) in order: accountNumber/],
    ['company override', { company: 'ca' }, /Unknown field\(s\) in order: company/],
    ['enrollDevices is no longer accepted', { enrollDevices: true }, /Unknown field/],
  ])('validates locally before any network call: %s', async (_n, patch, re) => {
    const res = await dispatchToolCall('dandh_create_sales_order', { ...order, ...patch, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(re);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
