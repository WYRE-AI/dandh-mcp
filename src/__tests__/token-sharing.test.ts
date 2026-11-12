import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithAbortSignal } from '../fetch-util.js';
import { clearTokenCache, restGet, tokenCacheKey } from '../rest-client.js';
import { DandhApiError, type RestCredentials } from '../types.js';
import {
  API_ORIGIN,
  AUTH_ORIGIN,
  BASE_PATH,
  FAKE_ACCOUNT,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  apiRoute,
  jsonResponse,
  mockDandh,
  setEnv,
  tokenResponse,
  tokenRoute,
  type Route,
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

/** A token endpoint that answers once `release()` is called and rejects like real fetch when the request's signal aborts. */
function gatedTokenRoute() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const route: Route = (call) => {
    if (call.url.origin !== AUTH_ORIGIN) return undefined;
    return new Promise<Response>((resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
      void gate.then(() => resolve(tokenResponse()));
    });
  };
  return { route, release };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const tokenCalls = (calls: { url: URL }[]) => calls.filter((c) => c.url.origin === AUTH_ORIGIN);

describe('shared in-flight token fetch', () => {
  it('keeps serving other callers when the caller that started the token fetch cancels', async () => {
    const { route, release } = gatedTokenRoute();
    const { calls } = mockDandh([route, apiRoute(() => jsonResponse({ itemId: 'ABC' }))]);
    const callerA = new AbortController();

    const a = failure(runWithAbortSignal(callerA.signal, () => restGet(REST, ITEM)));
    const b = restGet(REST, ITEM);
    await nextTick();
    callerA.abort();

    // The aborting caller is rejected at once, while the token fetch is still pending.
    expect((await a).message).toMatch(/cancelled/);
    release();
    await expect(b).resolves.toMatchObject({ body: { itemId: 'ABC' } });

    expect(tokenCalls(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.url.origin === API_ORIGIN)).toHaveLength(1);
  });

  it('runs the token request without the caller signal, so its late result is cached for the next caller', async () => {
    const { route, release } = gatedTokenRoute();
    const { calls } = mockDandh([route, apiRoute(() => jsonResponse({}))]);
    const callerA = new AbortController();

    const a = failure(runWithAbortSignal(callerA.signal, () => restGet(REST, ITEM)));
    await nextTick();
    callerA.abort();
    await a;
    release();
    await nextTick();

    await restGet(REST, ITEM);
    expect(tokenCalls(calls)).toHaveLength(1);
  });

  it('rejects a caller that is already cancelled', async () => {
    mockDandh([tokenRoute, apiRoute(() => jsonResponse({}))]);
    const callerA = new AbortController();
    callerA.abort();
    expect((await failure(runWithAbortSignal(callerA.signal, () => restGet(REST, ITEM)))).message).toMatch(/cancelled/);
  });

  it('leaves no unhandled rejection when an already cancelled caller started a token fetch that then fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      mockDandh([(c) => (c.url.origin === AUTH_ORIGIN ? jsonResponse({ error: 'invalid_client' }, 401) : undefined)]);
      const callerA = new AbortController();
      callerA.abort();
      expect((await failure(runWithAbortSignal(callerA.signal, () => restGet(REST, ITEM)))).message).toMatch(/cancelled/);
      await nextTick();
      await nextTick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still times out the token fetch', async () => {
    setEnv({ DANDH_REQUEST_TIMEOUT_MS: '50' });
    mockDandh([gatedTokenRoute().route]);
    expect((await failure(restGet(REST, ITEM))).message).toMatch(/timed out or was cancelled/);
  });

  it('does not cache a failed token fetch: the next call fetches again', async () => {
    let n = 0;
    const { calls } = mockDandh([
      (c) => (c.url.origin === AUTH_ORIGIN ? (++n === 1 ? jsonResponse({ error: 'server_error' }, 503) : tokenResponse()) : undefined),
      apiRoute(() => jsonResponse({ ok: true })),
    ]);
    await failure(restGet(REST, ITEM));
    await expect(restGet(REST, ITEM)).resolves.toMatchObject({ body: { ok: true } });
    expect(tokenCalls(calls)).toHaveLength(2);
  });
});

describe('token cache isolation', () => {
  it('never serves one credential set the token of another', async () => {
    const other: RestCredentials = { ...REST, clientId: 'dandh-other-client-id', clientSecret: 'dandh-other-client-secret-not-real-2Zt6' };
    const { calls } = mockDandh([
      (c) => {
        if (c.url.origin !== AUTH_ORIGIN) return undefined;
        return jsonResponse({ access_token: `token-for-${new URLSearchParams(c.body).get('client_id')}`, expires_in: 3600 });
      },
      apiRoute(() => jsonResponse({})),
    ]);
    // Concurrent first calls (shared in-flight map) and a later cached call.
    await Promise.all([restGet(REST, ITEM), restGet(other, ITEM)]);
    await restGet(REST, ITEM);

    const bearers = calls.filter((c) => c.url.origin === API_ORIGIN).map((c) => c.headers.authorization);
    expect(bearers).toEqual([`Bearer token-for-${FAKE_CLIENT_ID}`, 'Bearer token-for-dandh-other-client-id', `Bearer token-for-${FAKE_CLIENT_ID}`]);
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  it('keys on client id, secret, company and environment', () => {
    const key = tokenCacheKey(REST, 'production');
    expect(tokenCacheKey({ ...REST, clientId: 'other' }, 'production')).not.toBe(key);
    expect(tokenCacheKey({ ...REST, clientSecret: 'other' }, 'production')).not.toBe(key);
    expect(tokenCacheKey({ ...REST, company: 'ca' }, 'production')).not.toBe(key);
    expect(tokenCacheKey(REST, 'test')).not.toBe(key);
  });
});
