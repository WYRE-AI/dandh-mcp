import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { tokenCacheKey } from '../rest-client.js';
import { REST_ENV, TOKEN_OK, textOf, callInit, callUrl, jsonResponse, queue, setupEnv, stubFetch } from './test-helpers.js';


describe('OAuth + REST client', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    setupEnv(REST_ENV);
    fetchMock = stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requests a token with client credentials in the form body', async () => {
    queue(fetchMock, jsonResponse({ ok: 1 }));
    await dispatchToolCall('dandh_get_item', { itemId: 'ABC' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.dandh.com/api/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toBeUndefined();
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid-test',
      client_secret: 'csecret-do-not-log',
      scope: 'resource.READ',
    });
  });

  it('uses the test hosts when DANDH_ENVIRONMENT=test', async () => {
    process.env.DANDH_ENVIRONMENT = 'test';
    queue(fetchMock, jsonResponse({}));
    await dispatchToolCall('dandh_get_item', { itemId: 'ABC' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://test.auth.dandh.com/api/oauth/token');
    expect(callUrl(fetchMock, 1).origin).toBe('https://test.api.dandh.com');
  });

  it('sends Bearer token and the dandh-tenant header for each company', async () => {
    for (const [company, tenant] of [['us', 'dhus'], ['ca', 'dhca'], ['dsc', 'dsc']] as const) {
      setupEnv({ ...REST_ENV, DANDH_COMPANY: company });
      fetchMock.mockReset();
      queue(fetchMock, jsonResponse({}));
      await dispatchToolCall('dandh_get_item', { itemId: 'ABC' });
      const init = callInit(fetchMock, 1);
      expect(init.headers.Authorization).toBe('Bearer tok-1');
      expect(init.headers['dandh-tenant']).toBe(tenant);
    }
  });

  it('applies per-call accountNumber/company overrides', async () => {
    queue(fetchMock, jsonResponse({}));
    await dispatchToolCall('dandh_get_item', { itemId: 'ABC', accountNumber: '0987654321', company: 'ca' });
    expect(callUrl(fetchMock, 1).pathname).toBe('/customerOrderManagement/v2/customers/0987654321/items/ABC');
    expect(callInit(fetchMock, 1).headers['dandh-tenant']).toBe('dhca');
    const bad = await dispatchToolCall('dandh_get_item', { itemId: 'ABC', accountNumber: '12' });
    expect(bad.isError).toBe(true);
  });

  it('caches the token across calls', async () => {
    queue(fetchMock, jsonResponse({}), jsonResponse({}));
    await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    await dispatchToolCall('dandh_get_item', { itemId: 'B' });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/oauth/token'))).toHaveLength(1);
  });

  it('refreshes an expiring token (expires_in within the skew window)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'short', expires_in: 30 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'fresh', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    await dispatchToolCall('dandh_get_item', { itemId: 'B' });
    expect(callInit(fetchMock, 3).headers.Authorization).toBe('Bearer fresh');
  });

  it('refreshes the token once on a 401 and retries the GET', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_OK));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'expired' }, 401));
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ itemId: 'A' }));
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBeUndefined();
    expect(callInit(fetchMock, 3).headers.Authorization).toBe('Bearer tok-2');
  });

  it('gives up after a second 401 with a friendly credentials message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_OK));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rejected the REST credentials/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports bad client credentials from the token endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_client', error_description: 'bad client csecret-do-not-log' }, 401));
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rejected the REST client credentials/);
    expect(textOf(res)).not.toContain('csecret-do-not-log');
  });

  it('maps 403 and 400 to friendly messages', async () => {
    queue(fetchMock, jsonResponse({ message: 'nope' }, 403), jsonResponse({ message: 'bad item' }, 400));
    expect(textOf(await dispatchToolCall('dandh_get_item', { itemId: 'A' }))).toMatch(/account number, company\/tenant, or API entitlement/);
    expect(textOf(await dispatchToolCall('dandh_get_item', { itemId: 'A' }))).toMatch(/request contents.*bad item/);
  });

  it('retries GETs on 429/5xx but not beyond the limit', async () => {
    queue(fetchMock, jsonResponse({}, 503), jsonResponse({}, 429), jsonResponse({ ok: true }));
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockReset();
    setupEnv(REST_ENV);
    queue(fetchMock, jsonResponse({}, 500), jsonResponse({}, 500), jsonResponse({}, 500));
    expect((await dispatchToolCall('dandh_get_item', { itemId: 'A' })).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('token cache key is a hash that covers the secret and does not collapse delimiters', () => {
    const base = { clientId: 'a', clientSecret: 's', accountNumber: '1234567890', company: 'us' as const };
    const k = tokenCacheKey(base, 'production');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain('s');
    expect(tokenCacheKey({ ...base, clientSecret: 'other' }, 'production')).not.toBe(k);
    expect(tokenCacheKey({ ...base, company: 'ca' }, 'production')).not.toBe(k);
    expect(tokenCacheKey(base, 'test')).not.toBe(k);
    expect(tokenCacheKey({ ...base, clientId: 'a:s', clientSecret: '' }, 'production'))
      .not.toBe(tokenCacheKey({ ...base, clientId: 'a', clientSecret: 's:' }, 'production'));
  });
});
