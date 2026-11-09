import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRestUrl, clearTokenCache, restGet, tokenCacheKey } from '../rest-client.js';
import { ArgumentError, DandhApiError, type RestCredentials } from '../types.js';
import {
  API_ORIGIN,
  AUTH_ORIGIN,
  BASE_PATH,
  FAKE_ACCOUNT,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_SLASH_TOKEN,
  FAKE_TOKEN,
  apiRoute,
  jsonResponse,
  mockDandh,
  setEnv,
  tokenRoute,
} from './helpers.js';

const REST: RestCredentials = { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, accountNumber: FAKE_ACCOUNT, company: 'us' };
const ITEM = { path: `${BASE_PATH}/items/ABC` };

beforeEach(() => {
  setEnv();
  clearTokenCache();
});
afterEach(() => vi.unstubAllGlobals());

async function failure(p: Promise<unknown>): Promise<DandhApiError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DandhApiError);
  return err as DandhApiError;
}

describe('exact auth headers', () => {
  it('gets a client-credentials token (form body, scope resource.READ), then sends Bearer + dandh-tenant', async () => {
    const { calls } = mockDandh([tokenRoute, apiRoute(() => jsonResponse({ itemId: 'ABC' }))]);
    await expect(restGet(REST, ITEM)).resolves.toEqual({ body: { itemId: 'ABC' }, scrollId: undefined });

    expect(calls).toHaveLength(2);
    const [token, api] = calls;
    expect(token.method).toBe('POST');
    expect(token.url.href).toBe(`${AUTH_ORIGIN}/api/oauth/token`);
    expect(token.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(token.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      scope: 'resource.READ',
    });

    expect(api.method).toBe('GET');
    expect(api.url.href).toBe(`${API_ORIGIN}${BASE_PATH}/items/ABC`);
    expect(api.body).toBeUndefined();
    expect(Object.keys(api.headers).sort()).toEqual(['accept', 'authorization', 'dandh-tenant', 'user-agent']);
    expect(api.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(api.headers['dandh-tenant']).toBe('dhus');
    expect(api.headers.accept).toBe('application/json');
    expect(api.headers['user-agent']).toMatch(/^dandh-mcp\//);
  });

  it.each([
    ['us', 'dhus'],
    ['ca', 'dhca'],
    ['dsc', 'dsc'],
  ] as const)('company %s sends dandh-tenant %s', async (company, tenant) => {
    const { calls } = mockDandh([tokenRoute, apiRoute(() => jsonResponse({}))]);
    await restGet({ ...REST, company }, ITEM);
    expect(calls[1].headers['dandh-tenant']).toBe(tenant);
  });

  it('DANDH_ENVIRONMENT=test uses the fixed test hosts', async () => {
    setEnv({ DANDH_ENVIRONMENT: 'test' });
    const { calls } = mockDandh([
      (c) => (c.url.origin === 'https://test.auth.dandh.com' ? jsonResponse({ access_token: FAKE_TOKEN, expires_in: 60 }) : undefined),
      (c) => (c.url.origin === 'https://test.api.dandh.com' ? jsonResponse({}) : undefined),
    ]);
    await restGet(REST, ITEM);
    expect(calls.map((c) => c.url.origin)).toEqual(['https://test.auth.dandh.com', 'https://test.api.dandh.com']);
  });

  it('caches the token per credential set; the cache key includes the secret', async () => {
    const { calls } = mockDandh([tokenRoute, apiRoute(() => jsonResponse({}))]);
    await restGet(REST, ITEM);
    await restGet(REST, ITEM);
    expect(calls.filter((c) => c.url.origin === AUTH_ORIGIN)).toHaveLength(1);
    expect(tokenCacheKey(REST, 'production')).not.toBe(tokenCacheKey({ ...REST, clientSecret: 'other-secret' }, 'production'));
    expect(tokenCacheKey(REST, 'production')).not.toContain(FAKE_CLIENT_SECRET);
  });

  it('a 401 from the API drops the token, refreshes once and retries once', async () => {
    let apiCalls = 0;
    const { calls } = mockDandh([
      tokenRoute,
      apiRoute(() => (++apiCalls === 1 ? jsonResponse({ message: 'expired' }, 401) : jsonResponse({ ok: true }))),
    ]);
    await expect(restGet(REST, ITEM)).resolves.toMatchObject({ body: { ok: true } });
    expect(calls.map((c) => c.url.origin)).toEqual([AUTH_ORIGIN, API_ORIGIN, AUTH_ORIGIN, API_ORIGIN]);
  });

  it('rejected client credentials are reported without the secret', async () => {
    mockDandh([(c) => (c.url.origin === AUTH_ORIGIN ? jsonResponse({ error: 'invalid_client', error_description: `bad ${FAKE_CLIENT_SECRET}` }, 401) : undefined)]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.message).toMatch(/rejected the REST client credentials \(HTTP 401\)/);
    expect(err.message).toMatch(/invalid_client/);
    expect(err.message).not.toContain(FAKE_CLIENT_SECRET);
  });
});

describe('redirects are refused', () => {
  it('a 3xx from the API is an error and is not followed', async () => {
    const { calls } = mockDandh([tokenRoute, apiRoute(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/' } }))]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.message).toMatch(/redirect \(HTTP 302\); refusing to follow it/);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
    expect(calls.some((c) => c.url.hostname === 'evil.example.net')).toBe(false);
  });

  it('a 3xx from the token endpoint is an error', async () => {
    mockDandh([(c) => (c.url.origin === AUTH_ORIGIN ? new Response(null, { status: 307, headers: { location: 'https://evil.example.net/' } }) : undefined)]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.message).toMatch(/redirect \(HTTP 307\)/);
  });
});

describe('fixed origin and exact path', () => {
  it('builds URLs on the fixed API origin only', () => {
    expect(buildRestUrl(`${BASE_PATH}/items/A%2FB`, { quantity: 2 }).href).toBe(`${API_ORIGIN}${BASE_PATH}/items/A%2FB?quantity=2`);
  });

  it.each([
    ['//evil.example.net/x'],
    [`${BASE_PATH}/../../admin`],
    [`${BASE_PATH}/items/./x`],
    ['/somewhere/else'],
    ['https://evil.example.net/customerOrderManagement/v2/customers/1234567890/items'],
  ])('refuses %s', (path) => {
    expect(() => buildRestUrl(path)).toThrow(ArgumentError);
  });
});

describe('error mapping', () => {
  /** The error shape D&H's Axway gateway returned to a live probe of api.dandh.com on 2026-11-09. */
  const axwayError = (status: number, extra: Record<string, unknown> = {}) =>
    jsonResponse(
      { errorName: `${status} - Bad Request`, debugId: 'Id-body-debug-1', message: 'vendor says no', links: [], details: [], ...extra },
      status,
      { 'x-correlationid': 'Id-dh-corr-42' },
    );

  it.each([
    [400, /rejected the request \(HTTP 400\)/],
    [403, /denied access \(HTTP 403\)/],
    [404, /not found \(HTTP 404\)/],
    [429, /rate limit \(HTTP 429\)/],
    [503, /service error \(HTTP 503\)/],
  ])('HTTP %i keeps status, vendor message and the x-correlationid request id', async (status, re) => {
    mockDandh([tokenRoute, apiRoute(() => axwayError(status))]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.status).toBe(status);
    expect(err.requestId).toBe('Id-dh-corr-42');
    expect(err.message).toMatch(re);
    expect(err.message).toContain('vendor says no');
    expect(err.message).toContain(`${status} - Bad Request`);
    expect(err.message).toContain('(request id: Id-dh-corr-42)');
  });

  it('reports field errors from details', async () => {
    mockDandh([tokenRoute, apiRoute(() => axwayError(400, { details: [{ field: 'items', message: 'items is invalid' }, 'pageSize too large'] }))]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.message).toContain('items is invalid');
    expect(err.message).toContain('pageSize too large');
  });

  it('falls back to the body debugId when no request id header is present', async () => {
    mockDandh([tokenRoute, apiRoute(() => jsonResponse({ errorName: '400 - Bad Request', debugId: 'Id-body-debug-1', message: 'm' }, 400))]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.requestId).toBe('Id-body-debug-1');
    expect(err.message).toContain('(request id: Id-body-debug-1)');
  });

  it('a 401 with an empty body reports the www-authenticate error_description', async () => {
    const challenge = 'Bearer realm="api.dandh.com", error="invalid_token", error_description="The access token is invalid or has expired"';
    mockDandh([tokenRoute, apiRoute(() => new Response(null, { status: 401, headers: { 'www-authenticate': challenge, 'x-correlationid': 'Id-401' } }))]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.status).toBe(401);
    expect(err.message).toContain('The access token is invalid or has expired');
    expect(err.requestId).toBe('Id-401');
  });

  it('a 429 includes Retry-After when D&H sends it', async () => {
    mockDandh([tokenRoute, apiRoute(() => jsonResponse({}, 429, { 'retry-after': '7' }))]);
    expect((await failure(restGet(REST, ITEM))).message).toMatch(/Retry after 7 seconds/);
  });

  it('an access token echoed JSON-escaped in an error body is redacted after decoding', async () => {
    const escaped = FAKE_SLASH_TOKEN.replaceAll('/', '\\/');
    mockDandh([
      (c) => (c.url.origin === AUTH_ORIGIN ? jsonResponse({ access_token: FAKE_SLASH_TOKEN, expires_in: 3600 }) : undefined),
      apiRoute(() => new Response(`{"message":"bad token ${escaped}"}`, { status: 400 })),
    ]);
    const err = await failure(restGet(REST, ITEM));
    expect(err.message).toContain('bad token');
    expect(err.message).not.toContain(FAKE_SLASH_TOKEN);
  });

  it('falls back to the Cloudflare cf-ray header for the request id', async () => {
    mockDandh([tokenRoute, apiRoute(() => jsonResponse({}, 500, { 'cf-ray': '8a1b2c3d4e5f-IAD' }))]);
    expect((await failure(restGet(REST, ITEM))).requestId).toBe('8a1b2c3d4e5f-IAD');
  });

  it('a non-JSON 2xx body is an error', async () => {
    mockDandh([tokenRoute, apiRoute(() => new Response('<html>maintenance</html>', { status: 200 }))]);
    expect((await failure(restGet(REST, ITEM))).message).toMatch(/non-JSON/);
  });

  it('a network failure is reported without retrying', async () => {
    const { calls } = mockDandh([tokenRoute, apiRoute(() => { throw new TypeError('fetch failed'); })]);
    expect((await failure(restGet(REST, ITEM))).message).toMatch(/Could not reach the D&H REST API \(network error\)/);
    expect(calls.filter((c) => c.url.origin === API_ORIGIN)).toHaveLength(1);
  });
});

describe('bounded response read', () => {
  it('refuses a body larger than DANDH_MAX_UPSTREAM_BYTES while streaming', async () => {
    setEnv({ DANDH_MAX_UPSTREAM_BYTES: '1024' });
    mockDandh([tokenRoute, apiRoute(() => new Response(JSON.stringify({ pad: 'x'.repeat(4096) }), { status: 200 }))]);
    expect((await failure(restGet(REST, ITEM))).message).toMatch(/exceeded 1024 bytes/);
  });

  it('refuses a declared Content-Length above the limit without reading', async () => {
    setEnv({ DANDH_MAX_UPSTREAM_BYTES: '1024' });
    mockDandh([tokenRoute, apiRoute(() => new Response('{}', { status: 200, headers: { 'content-length': '999999' } }))]);
    expect((await failure(restGet(REST, ITEM))).message).toMatch(/exceeded 1024 bytes/);
  });
});
