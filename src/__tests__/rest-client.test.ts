import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { TOKEN_CACHE_MAX, restRequest, tokenCacheKey, tokenCacheSize } from '../rest-client.js';
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

  it('ignores per-call accountNumber/company: only connection credentials are used', async () => {
    queue(fetchMock, jsonResponse({}));
    await dispatchToolCall('dandh_get_item', { itemId: 'ABC', accountNumber: '0987654321', company: 'ca' });
    expect(callUrl(fetchMock, 1).pathname).toBe('/customerOrderManagement/v2/customers/1234567890/items/ABC');
    expect(callInit(fetchMock, 1).headers['dandh-tenant']).toBe('dhus');
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

  it('sets redirect: "error" on the token request and on API requests', async () => {
    queue(fetchMock, jsonResponse({}));
    await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(callInit(fetchMock, 0).redirect).toBe('error');
    expect(callInit(fetchMock, 1).redirect).toBe('error');
  });

  describe('token cache bound', () => {
    const creds = (i: number) => ({ clientId: `c${i}`, clientSecret: `secret-${i}`, accountNumber: '1234567890', company: 'us' as const });
    const call = (i: number) => restRequest(creds(i), 'production', { method: 'GET', path: '/x' });
    function tokenServer() {
      let n = 0;
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes('/oauth/token')
          ? jsonResponse({ access_token: `tok-${++n}`, expires_in: 3600 })
          : jsonResponse({}));
      return () => n;
    }

    it('never holds more than TOKEN_CACHE_MAX tokens and evicts the least recently used', async () => {
      const issued = tokenServer();
      for (let i = 0; i < TOKEN_CACHE_MAX; i++) await call(i);
      expect(tokenCacheSize()).toBe(TOKEN_CACHE_MAX);
      await call(0); // touch c0: it is now the most recently used
      expect(issued()).toBe(TOKEN_CACHE_MAX);
      await call(TOKEN_CACHE_MAX); // one over the cap -> evicts c1, not c0
      expect(tokenCacheSize()).toBe(TOKEN_CACHE_MAX);
      expect(issued()).toBe(TOKEN_CACHE_MAX + 1);
      await call(0); // still cached
      expect(issued()).toBe(TOKEN_CACHE_MAX + 1);
      await call(1); // was evicted -> new token
      expect(issued()).toBe(TOKEN_CACHE_MAX + 2);
      expect(tokenCacheSize()).toBe(TOKEN_CACHE_MAX);
    });

    it('drops expired entries when storing a new token', async () => {
      vi.useFakeTimers();
      try {
        tokenServer();
        fetchMock.mockImplementationOnce(async () => jsonResponse({ access_token: 'short', expires_in: 120 }));
        await call(1);
        await call(2);
        expect(tokenCacheSize()).toBe(2);
        vi.advanceTimersByTime(121_000);
        await call(3);
        expect(tokenCacheSize()).toBe(2); // c1 expired and was dropped
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
