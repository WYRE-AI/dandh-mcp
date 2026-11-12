import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokenCache } from '../rest-client.js';
import { getDefaultToolset, resetToolsets } from '../tools/index.js';
import {
  API_ORIGIN,
  BASE_PATH,
  REST_ENV,
  apiRoute,
  jsonResponse,
  mockDandh,
  setEnv,
  textOf,
  tokenRoute,
  type RecordedCall,
} from './helpers.js';

beforeEach(() => {
  setEnv(REST_ENV);
  clearTokenCache();
  resetToolsets();
});
afterEach(() => vi.unstubAllGlobals());

const call = (name: string, args: Record<string, unknown> = {}) => getDefaultToolset().dispatch(name, args);

/** Mocks D&H (token + one API answer) and returns the API calls made. */
function mockApi(respond: (c: RecordedCall) => Response = () => jsonResponse({ ok: true })) {
  const { calls } = mockDandh([tokenRoute, apiRoute(respond)]);
  return () => calls.filter((c) => c.url.origin === API_ORIGIN);
}

describe('REST endpoints: one GET per tool, exact path and query', () => {
  it.each([
    ['dandh_get_item', { itemId: 'ABC' }, '/items/ABC', {}],
    ['dandh_get_price', { itemId: 'ABC', quantity: 5 }, '/items/ABC/price', { quantity: '5' }],
    ['dandh_get_availability', { itemId: 'ABC' }, '/items/ABC/availability', {}],
    ['dandh_get_price_and_availability', { itemId: 'ABC', quantity: 3 }, '/items/ABC/priceAndAvailability', { quantity: '3' }],
    ['dandh_get_prices_bulk', { items: ['A'] }, '/items/price/bulk', { items: 'A' }],
    ['dandh_get_availability_bulk', { customerItemNumbers: ['X'] }, '/items/availability/bulk', { customerItemNumbers: 'X' }],
    ['dandh_get_price_and_availability_bulk', { items: ['A'], customerItemNumbers: ['X'] }, '/items/priceAndAvailability/bulk', { items: 'A', customerItemNumbers: 'X' }],
    ['dandh_search_items', { vendorItemId: 'MPN-1' }, '/items', { vendorItemId: 'MPN-1' }],
    ['dandh_search_items', { universalProductCode: '012345678905' }, '/items', { universalProductCode: '012345678905' }],
    ['dandh_list_carriers', { shipMode: 'parcel' }, '/carriers', { shipMode: 'parcel' }],
    ['dandh_get_order_tracking', { orderId: '7000123' }, '/salesOrders/7000123/tracking', {}],
    ['dandh_list_order_tracking', { purchaseOrderNumber: 'PO-1' }, '/salesOrders/tracking', { purchaseOrderNumber: 'PO-1' }],
  ])('%s %j', async (name, args, path, query) => {
    const apiCalls = mockApi();
    const res = await call(name, args);
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(apiCalls()).toHaveLength(1);
    const [c] = apiCalls();
    expect(c.method).toBe('GET');
    expect(c.url.pathname).toBe(`${BASE_PATH}${path}`);
    expect(Object.fromEntries(c.url.searchParams)).toEqual(query);
  });

  it('end-to-end read: item detail comes back as JSON text', async () => {
    mockApi(() => jsonResponse({ itemId: 'ABC', description: 'Widget', vendorItemId: 'MPN-1' }));
    const res = await call('dandh_get_item', { itemId: 'ABC' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ itemId: 'ABC', description: 'Widget', vendorItemId: 'MPN-1' });
  });
});

describe('path parameters', () => {
  it.each([
    ['space and hash', 'AB C#1', '/items/AB%20C%231'],
    ['question mark', 'A?x=1', '/items/A%3Fx%3D1'],
    ['plus and ampersand', 'A+B&C', '/items/A%2BB%26C'],
  ])('percent-encodes %s', async (_n, itemId, path) => {
    const apiCalls = mockApi();
    await call('dandh_get_item', { itemId });
    expect(apiCalls()[0].url.pathname).toBe(`${BASE_PATH}${path}`);
  });

  it.each([
    ['..'],
    ['.'],
    ['../salesOrders'],
    ['a/b'],
    ['a\\b'],
    ['%2e%2e'],
    ['a%2Fb'],
    ['a%5cb'],
    ['line\nbreak'],
    ['nul\u0000'],
    [''],
    ['   '],
  ])('rejects itemId %j before any network call', async (itemId) => {
    const { fetchMock } = mockDandh([tokenRoute, apiRoute(() => jsonResponse({}))]);
    const res = await call('dandh_get_item', { itemId });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/itemId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a traversal orderId too', async () => {
    const { fetchMock } = mockDandh([tokenRoute]);
    const res = await call('dandh_get_order_tracking', { orderId: '../../items' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/orderId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the account number always comes from the credentials, never from arguments', async () => {
    const apiCalls = mockApi();
    await call('dandh_get_item', { itemId: 'ABC', accountNumber: '0000000000', company: 'ca' });
    expect(apiCalls()[0].url.pathname).toBe(`${BASE_PATH}/items/ABC`);
    expect(apiCalls()[0].headers['dandh-tenant']).toBe('dhus');
  });
});

describe('array parameters', () => {
  // D&H's wire format for lists is UNCONFIRMED (the portal Swagger is
  // login-walled). Lists go out as repeated plain keys (items=A&items=B), the
  // form the only reference (n8n-nodes-dandh, an array in `qs`) and common
  // Java/JAX-RS list binding accept; never bracketed (items[]=).
  it('are sent as repeated plain keys, without brackets', async () => {
    const apiCalls = mockApi();
    await call('dandh_search_items', { vendorItemIds: ['M1', 'M2', 'M3'] });
    const url = apiCalls()[0].url;
    expect(url.search).toBe('?vendorItemIds=M1&vendorItemIds=M2&vendorItemIds=M3');
  });

  it('bulk lookups send each item as its own key', async () => {
    const apiCalls = mockApi();
    await call('dandh_get_price_and_availability_bulk', { items: ['A', 'B'], customerItemNumbers: ['X'] });
    expect(apiCalls()[0].url.search).toBe('?items=A&items=B&customerItemNumbers=X');
  });

  it('reject entries containing a comma (they would split into two items)', async () => {
    const { fetchMock } = mockDandh([tokenRoute]);
    const res = await call('dandh_get_prices_bulk', { items: ['A,B'] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/items\[0\]/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['dandh_get_prices_bulk', 'dandh_get_availability_bulk', 'dandh_get_price_and_availability_bulk'])(
    '%s: at most 50 items across items + customerItemNumbers, at least one',
    async (name) => {
      const n = (k: number, p: string) => Array.from({ length: k }, (_, i) => `${p}${i}`);
      const apiCalls = mockApi();
      expect((await call(name, { items: n(50, 'I') })).isError).toBeFalsy();
      expect(apiCalls()).toHaveLength(1);
      for (const args of [{ items: n(51, 'I') }, { items: n(30, 'I'), customerItemNumbers: n(21, 'C') }, {}, { items: [] }]) {
        const res = await call(name, args);
        expect(res.isError, JSON.stringify(args)).toBe(true);
      }
      expect(apiCalls()).toHaveLength(1);
    },
  );
});

describe('pagination is passed through, never auto-paged', () => {
  it('forwards scrollId and pageSize and returns the next scrollId from the body', async () => {
    const apiCalls = mockApi(() => jsonResponse({ elements: [{ itemId: 'A' }], scrollId: 'next-2', hasNext: true }));
    const res = await call('dandh_search_items', { vendorItemId: 'MPN', pageSize: 25, scrollId: 'page-1' });
    expect(Object.fromEntries(apiCalls()[0].url.searchParams)).toEqual({ vendorItemId: 'MPN', pageSize: '25', scrollId: 'page-1' });
    expect(JSON.parse(textOf(res))).toMatchObject({ scrollId: 'next-2', hasNext: true });
    expect(apiCalls()).toHaveLength(1);
  });

  it('surfaces an x-scroll-id header when the body has none', async () => {
    mockApi(() => jsonResponse([{ carrier: 'UPS' }], 200, { 'x-scroll-id': 'hdr-3' }));
    const res = await call('dandh_list_carriers', {});
    expect(JSON.parse(textOf(res))).toEqual({ elements: [{ carrier: 'UPS' }], scrollId: 'hdr-3' });
  });

  describe('a page larger than the output cap keeps its paging fields', () => {
    const elements = Array.from({ length: 100 }, (_, i) => ({ itemId: `ITEM${i}`, description: 'x'.repeat(650) }));

    it.each([
      ['x-scroll-id header', () => jsonResponse(elements, 200, { 'x-scroll-id': 'NEXT-PAGE-ID' })],
      ['body fields after elements', () => jsonResponse({ elements, scrollId: 'NEXT-PAGE-ID', hasNext: true })],
    ])('%s', async (_n, respond) => {
      mockApi(respond);
      const text = textOf(await call('dandh_list_carriers', { pageSize: 100 }));
      expect(text).toMatch(/truncated/);
      expect(text.startsWith('{"scrollId":"NEXT-PAGE-ID"')).toBe(true);
    });

    it('hasNext comes first too', async () => {
      mockApi(() => jsonResponse({ elements, hasNext: false }));
      const text = textOf(await call('dandh_list_carriers', {}));
      expect(text.startsWith('{"hasNext":false')).toBe(true);
    });
  });

  it('advertises pageSize without a maximum, since larger values are capped rather than rejected', () => {
    for (const name of ['dandh_search_items', 'dandh_list_carriers', 'dandh_list_order_tracking']) {
      const tool = getDefaultToolset().tools.find((t) => t.name === name)!;
      const pageSize = (tool.inputSchema.properties as Record<string, Record<string, unknown>>).pageSize;
      expect(pageSize).toMatchObject({ type: 'integer', minimum: 1 });
      expect(pageSize).not.toHaveProperty('maximum');
      expect(pageSize.description).toMatch(/capped/);
    }
  });

  it('caps pageSize at 100 and rejects values below 1', async () => {
    const apiCalls = mockApi();
    await call('dandh_list_order_tracking', { invoiceNumber: 'INV-1', pageSize: 5000 });
    expect(apiCalls()[0].url.searchParams.get('pageSize')).toBe('100');
    const res = await call('dandh_list_order_tracking', { invoiceNumber: 'INV-1', pageSize: 0 });
    expect(res.isError).toBe(true);
    expect(apiCalls()).toHaveLength(1);
  });
});

describe('argument validation before any network call', () => {
  it.each([
    ['dandh_search_items', {}, /exactly one of/],
    ['dandh_search_items', { vendorItemId: 'A', universalProductCode: '1' }, /exactly one of/],
    ['dandh_search_items', { items: ['A'], customerItemNumber: 'B' }, /exactly one of/],
    ['dandh_list_order_tracking', { orderNumber: '1', invoiceNumber: '2' }, /exactly one of/],
    ['dandh_list_order_tracking', {}, /exactly one of/],
    ['dandh_list_carriers', { shipMode: 'boat' }, /shipMode.*one of: parcel, lessThanTruckload, fullTruckload/],
    ['dandh_get_price', { itemId: 'A', quantity: 0 }, /quantity/],
    ['dandh_get_price', { itemId: 'A', quantity: 1.5 }, /quantity/],
    ['dandh_get_item', {}, /itemId/],
  ])('%s %j', async (name, args, re) => {
    const { fetchMock } = mockDandh([tokenRoute]);
    const res = await call(name, args);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(re);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a missing REST credential set names what to configure and points at the XML equivalent', async () => {
    setEnv({ DANDH_XML_USER_CODE: 'u', DANDH_XML_PASSWORD: 'p-long-enough' });
    const { fetchMock } = mockDandh([]);
    const res = await call('dandh_get_availability', { itemId: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/REST .*not configured/);
    expect(textOf(res)).toMatch(/dandh_xml_get_price_availability/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
