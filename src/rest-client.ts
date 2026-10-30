import { createHash } from 'node:crypto';
import { logger } from './utils/logger.js';
import { redact } from './utils/redact.js';
import { TENANT_BY_COMPANY, type Environment, type RestCredentials } from './types.js';

export const REST_HOSTS: Record<Environment, { auth: string; api: string }> = {
  production: {
    auth: 'https://auth.dandh.com',
    // UNCONFIRMED: the production API host is not in D&H's public docs; the
    // test host comes from the community n8n node. See README.
    api: 'https://api.dandh.com',
  },
  test: { auth: 'https://test.auth.dandh.com', api: 'https://test.api.dandh.com' },
};

const TOKEN_PATH = '/api/oauth/token';
const OAUTH_SCOPE = 'resource.READ';

// Refresh the token this far ahead of its expiry so a slow call never races it.
const REFRESH_SKEW_MS = 60_000;
// Used when the token response omits expires_in.
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

/** Mutable so tests can run retries without real delays. */
export const retryConfig = { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000 };

/** Any failure talking to D&H. Messages are already redacted. */
export class DandhApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly rejected = false,
    /** True when the failure happened before any request reached D&H's order endpoint. */
    public notSent = false,
    /** For XML failures: D&H's own MESSAGE text, without our prefix (redacted, truncated). */
    readonly dhMessage?: string,
  ) {
    super(message);
  }
}

/** True when nothing was placed: D&H definitively refused the request (4xx, or an explicit XML failure), or it was never sent. */
export function isDefinitiveRejection(err: unknown): boolean {
  if (!(err instanceof DandhApiError)) return false;
  return err.rejected || err.notSent || (err.status !== undefined && err.status >= 400 && err.status < 500);
}

/** D&H rejected our credentials / token. */
export class DandhAuthError extends DandhApiError {}

interface TokenState {
  token: string;
  expireAt: number; // epoch ms
}

/** Upper bound on cached tokens (one per distinct credential set). */
export const TOKEN_CACHE_MAX = 500;

const tokenCache = new Map<string, TokenState>();
const inflight = new Map<string, Promise<TokenState>>();

export function tokenCacheSize(): number {
  return tokenCache.size;
}

/** Stores a token: drops expired entries, then evicts the least recently used one(s) past the cap. */
function storeToken(key: string, state: TokenState): void {
  const now = Date.now();
  for (const [k, v] of tokenCache) if (v.expireAt <= now) tokenCache.delete(k);
  tokenCache.delete(key); // re-insert so Map order is recency order
  tokenCache.set(key, state);
  while (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
}

export function clearTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}

/**
 * Cache key = SHA-256 over a JSON array of (clientId, clientSecret, company,
 * environment). Hashed so no secret sits in a Map key, and JSON-encoded (not
 * colon-joined) so a delimiter inside a value can never merge two tenants.
 * The secret is part of the key on purpose: otherwise a caller who knows only
 * a client id (wrong secret) could be served another tenant's cached token.
 */
export function tokenCacheKey(rest: RestCredentials, environment: Environment): string {
  return createHash('sha256')
    .update(JSON.stringify([rest.clientId, rest.clientSecret, rest.company, environment]))
    .digest('hex');
}

function secretsFor(rest: RestCredentials, extra: (string | undefined)[] = []): (string | undefined)[] {
  return [rest.clientSecret, ...extra];
}

/** Pulls a short human-readable detail out of an error body (JSON or text). */
function errorDetail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parts: string[] = [];
  const collect = (v: unknown, depth = 0): void => {
    if (depth > 3 || v == null) return;
    if (typeof v === 'string') {
      if (v.trim()) parts.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, 5)) collect(x, depth + 1);
    } else if (typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      for (const key of ['message', 'error_description', 'error', 'detail', 'title', 'errors']) {
        collect(rec[key], depth + 1);
      }
    }
  };
  try {
    collect(JSON.parse(trimmed));
  } catch {
    // Non-JSON body: only keep it if it looks like short plain text, not a web page.
    if (!/^\s*</.test(trimmed) && trimmed.length <= 300) parts.push(trimmed);
  }
  const unique = [...new Set(parts)].join('; ');
  return unique ? unique.slice(0, 500) : undefined;
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function friendlyMessage(status: number, detail: string | undefined, write: boolean): string {
  const suffix = detail ? `: ${detail}` : '';
  switch (status) {
    case 400:
      return (
        `D&H rejected the request contents (HTTP 400)${suffix}. ` +
        (write
          ? 'Check the order fields; a duplicate customerPurchaseOrder is a common cause (PO numbers must be unique). The order was not placed.'
          : 'Check the item numbers / query parameters.')
      );
    case 401:
      return `D&H rejected the REST credentials (HTTP 401)${suffix}. Check the Client ID and Secret key from your D&H API Portal app (Applications → your app → OAuth Credentials).`;
    case 403:
      return `D&H denied access (HTTP 403)${suffix}. The account number, company/tenant, or API entitlement is not permitted for these credentials — confirm the app has the Customer Order Management API enabled and the account number and company match.`;
    case 404:
      return `D&H returned not found (HTTP 404)${suffix}. Check the item/order identifier, account number, and company.`;
    case 429:
      return `D&H rate limit reached (HTTP 429)${suffix}. Try again shortly.`;
    default:
      return status >= 500
        ? `D&H service error (HTTP ${status})${suffix}. This is usually temporary.`
        : `D&H request failed (HTTP ${status})${suffix}.`;
  }
}

/** Marks an error as thrown before anything reached D&H's order endpoint. Non-API errors are wrapped. */
export function markNotSent(err: unknown, secrets: (string | undefined)[] = []): DandhApiError {
  if (err instanceof DandhApiError) {
    err.notSent = true;
    return err;
  }
  return new DandhApiError(redact(err instanceof Error ? err.message : String(err), secrets), undefined, false, true);
}

/** Every failure while getting a token happens before the actual request is sent. */
async function requestToken(rest: RestCredentials, environment: Environment): Promise<TokenState> {
  try {
    return await fetchToken(rest, environment);
  } catch (err) {
    throw markNotSent(err, secretsFor(rest));
  }
}

async function fetchToken(rest: RestCredentials, environment: Environment): Promise<TokenState> {
  const url = `${REST_HOSTS[environment].auth}${TOKEN_PATH}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      // Client credentials are sent in the body, per D&H's OAuth guide.
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: rest.clientId,
        client_secret: rest.clientSecret,
        scope: OAUTH_SCOPE,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new DandhApiError(
      `Could not reach the D&H OAuth service: ${redact((err as Error).message, secretsFor(rest))}`,
    );
  }

  if (!res.ok) {
    const detail = redact(errorDetail(await readText(res)) ?? '', secretsFor(rest)) || undefined;
    if (res.status === 400 || res.status === 401) {
      throw new DandhAuthError(
        `D&H rejected the REST client credentials (HTTP ${res.status})${detail ? `: ${detail}` : ''}. Check the Client ID and Secret key from your D&H API Portal app (Applications → your app → OAuth Credentials).`,
        res.status,
      );
    }
    throw new DandhApiError(
      `D&H OAuth service error (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`,
      res.status,
    );
  }

  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new DandhApiError('D&H OAuth service returned a non-JSON token response.');
  }
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new DandhAuthError('D&H OAuth service returned no access_token.');
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TOKEN_TTL_MS;
  return { token: data.access_token, expireAt: Date.now() + ttl };
}

/**
 * Returns a cached token while it has more than REFRESH_SKEW_MS left.
 * `rejectedToken` forces a refresh only if the cache still holds that token
 * (another request may already have replaced it).
 */
async function getToken(
  rest: RestCredentials,
  environment: Environment,
  rejectedToken?: string,
): Promise<string> {
  const key = tokenCacheKey(rest, environment);
  const cached = tokenCache.get(key);
  if (cached && cached.expireAt - REFRESH_SKEW_MS > Date.now() && cached.token !== rejectedToken) {
    tokenCache.delete(key);
    tokenCache.set(key, cached); // mark as recently used
    return cached.token;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = requestToken(rest, environment)
      .then((state) => {
        storeToken(key, state);
        return state;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return (await pending).token;
}

function invalidateToken(rest: RestCredentials, environment: Environment, token: string): void {
  const key = tokenCacheKey(rest, environment);
  if (tokenCache.get(key)?.token === token) tokenCache.delete(key);
}

export type QueryValue = string | number | boolean | undefined;

export interface RestRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface RestResponse {
  /** Parsed JSON body, or {} for an empty response. */
  body: unknown;
  /** scrollId from the `x-scroll-id` response header, if present. */
  headerScrollId?: string;
}

function buildUrl(environment: Environment, req: RestRequest): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) qs.append(k, String(v));
  }
  const q = qs.toString();
  return `${REST_HOSTS[environment].api}${req.path}${q ? `?${q}` : ''}`;
}

function retryDelay(res: Response | undefined, attempt: number): number {
  const ra = Number(res?.headers.get('retry-after'));
  const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : retryConfig.baseDelayMs * 2 ** attempt;
  return Math.min(ms, retryConfig.maxDelayMs);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One authenticated REST call.
 *
 * - Every call sends `Authorization: Bearer <token>` and `dandh-tenant`.
 * - 401: the cached token is dropped. GETs refresh and retry exactly once.
 *   POSTs are NEVER re-sent: the caller is told to retry (D&H rejected the
 *   call as unauthenticated, so no order was accepted).
 * - 429/5xx/network errors are retried (with backoff) for GETs only. A POST
 *   whose outcome is unknown is reported as such, never repeated.
 */
export async function restRequest(
  rest: RestCredentials,
  environment: Environment,
  req: RestRequest,
): Promise<RestResponse> {
  const write = req.method !== 'GET';
  let url: string;
  let payload: string | undefined;
  try {
    url = buildUrl(environment, req);
    payload = write ? JSON.stringify(req.body ?? {}) : undefined;
  } catch (err) {
    throw markNotSent(err, secretsFor(rest));
  }
  let token = await getToken(rest, environment);
  let refreshed = false;
  let attempt = 0;

  for (;;) {
    let res: Response | undefined;
    let networkError: Error | undefined;
    try {
      res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'dandh-tenant': TENANT_BY_COMPANY[rest.company],
          Accept: 'application/json',
          ...(write ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(write ? 30_000 : 15_000),
      });
    } catch (err) {
      networkError = err as Error;
    }

    if (networkError) {
      const msg = redact(networkError.message, secretsFor(rest, [token]));
      if (write) {
        throw new DandhApiError(
          `The order request to D&H failed before a response was received (${msg}). The order MAY have been placed — check dandh_list_order_tracking by purchaseOrderNumber before retrying.`,
        );
      }
      if (attempt < retryConfig.maxRetries) {
        await sleep(retryDelay(undefined, attempt++));
        continue;
      }
      throw new DandhApiError(`Could not reach D&H: ${msg}`);
    }

    const response = res!;
    if (response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        const msg = redact((err as Error).message, secretsFor(rest, [token]));
        if (write) {
          throw new DandhApiError(
            `Could not read the D&H response body (HTTP ${response.status}) (${msg}). The order MAY have been placed — check dandh_list_order_tracking by purchaseOrderNumber before retrying.`,
            response.status,
          );
        }
        if (attempt < retryConfig.maxRetries) {
          await sleep(retryDelay(undefined, attempt++));
          continue;
        }
        throw new DandhApiError(`Could not read the D&H response body (HTTP ${response.status}): ${msg}`, response.status);
      }
      let body: unknown = {};
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new DandhApiError(`D&H returned a non-JSON response (HTTP ${response.status}).`, response.status);
        }
      }
      const headerScrollId = response.headers.get('x-scroll-id') || undefined;
      return { body, headerScrollId };
    }

    if (response.status === 401) {
      invalidateToken(rest, environment, token);
      if (!write && !refreshed) {
        refreshed = true;
        logger.warn('D&H rejected the access token, refreshing and retrying once');
        token = await getToken(rest, environment, token);
        continue;
      }
    }

    if (!write && (response.status === 429 || response.status >= 500) && attempt < retryConfig.maxRetries) {
      await sleep(retryDelay(response, attempt++));
      continue;
    }

    const detail = redact(errorDetail(await readText(response)) ?? '', secretsFor(rest, [token])) || undefined;
    let message = friendlyMessage(response.status, detail, write);
    if (response.status === 401 && write) {
      message += ' The order was not accepted. The token cache was cleared; the order was NOT retried automatically — retry the call if the user still wants it.';
    }
    throw response.status === 401 || response.status === 403
      ? new DandhAuthError(message, response.status)
      : new DandhApiError(message, response.status);
  }
}
