/**
 * The only path to D&H's Customer Order Management REST API. The hosts are
 * compile-time constants (never tenant-supplied); DANDH_ENVIRONMENT only
 * picks between the production and test pairs. Every request is a GET:
 * - the URL is built from an already-encoded path and checked to stay on the
 *   fixed API origin at exactly that path, under the customer prefix;
 * - OAuth2 client credentials go in the token request body (scope resource.READ);
 * - API calls send only Authorization: Bearer, dandh-tenant, accept, user-agent.
 */
import { createHash } from 'node:crypto';
import { dandhEnvironment, maxUpstreamBytes } from './config.js';
import { dandhFetch, readBoundedText, readErrorBody, requestIdOf, USER_AGENT, waitUnlessCancelled, withoutCallerSignal, withRequestId } from './fetch-util.js';
import { redactText } from './redact.js';
import { ArgumentError, DandhApiError, TENANT_BY_COMPANY, type Environment, type RestCredentials } from './types.js';

export const REST_HOSTS: Record<Environment, { auth: string; api: string }> = {
  // Confirmed live on 2026-11-09 by unauthenticated probes: api.dandh.com and
  // test.api.dandh.com answer under /customerOrderManagement/v2/customers/
  // through a Bearer gateway (400 without a token, 401 invalid_token with a
  // bogus one); auth.dandh.com/api/oauth/token takes body credentials (400
  // invalid_client). Paths and response shapes still need real credentials.
  production: { auth: 'https://auth.dandh.com', api: 'https://api.dandh.com' },
  test: { auth: 'https://test.auth.dandh.com', api: 'https://test.api.dandh.com' },
};

const TOKEN_PATH = '/api/oauth/token';
const OAUTH_SCOPE = 'resource.READ';
export const CUSTOMER_PREFIX = '/customerOrderManagement/v2/customers/';

const OAUTH_SERVICE = 'the D&H OAuth service';
const API_SERVICE = 'the D&H REST API';

// ---- token cache --------------------------------------------------------

/** Refresh this far ahead of expiry so a slow call never races it. */
const REFRESH_SKEW_MS = 60_000;
/** Used when the token response omits expires_in. */
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;
/** Upper bound on cached tokens (one per distinct credential set). */
const TOKEN_CACHE_MAX = 500;

interface TokenState {
  token: string;
  expireAt: number;
}

const tokenCache = new Map<string, TokenState>();
const inflight = new Map<string, Promise<TokenState>>();

export function clearTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}

/**
 * SHA-256 over (clientId, clientSecret, company, environment). Hashed so no
 * secret sits in a Map key; the secret is included so a caller who knows only
 * a client id can never be served another tenant's cached token.
 */
export function tokenCacheKey(rest: RestCredentials, environment: Environment): string {
  return createHash('sha256').update(JSON.stringify([rest.clientId, rest.clientSecret, rest.company, environment])).digest('hex');
}

function storeToken(key: string, state: TokenState): void {
  const now = Date.now();
  for (const [k, v] of tokenCache) if (v.expireAt <= now) tokenCache.delete(k);
  tokenCache.delete(key);
  tokenCache.set(key, state);
  while (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
}

/**
 * Returns a cached token with more than REFRESH_SKEW_MS left, unless it is `rejected`.
 * Concurrent misses share one request. That request is detached from the first
 * caller's cancellation signal (the request timeout still applies), so one caller
 * cancelling cannot fail the others; each caller stops waiting when it is cancelled.
 */
async function getToken(rest: RestCredentials, environment: Environment, rejected?: string): Promise<string> {
  const key = tokenCacheKey(rest, environment);
  const cached = tokenCache.get(key);
  if (cached && cached.token !== rejected && cached.expireAt - REFRESH_SKEW_MS > Date.now()) return cached.token;
  if (cached?.token === rejected) tokenCache.delete(key);
  let pending = inflight.get(key);
  if (!pending) {
    pending = withoutCallerSignal(() => fetchToken(rest, environment))
      .then((state) => {
        storeToken(key, state);
        return state;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return (await waitUnlessCancelled(pending, OAUTH_SERVICE)).token;
}

async function fetchToken(rest: RestCredentials, environment: Environment): Promise<TokenState> {
  const url = new URL(TOKEN_PATH, REST_HOSTS[environment].auth);
  const res = await dandhFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
      // Client credentials go in the body, per D&H's OAuth guide.
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: rest.clientId,
        client_secret: rest.clientSecret,
        scope: OAUTH_SCOPE,
      }).toString(),
    },
    OAUTH_SERVICE,
  );

  if (!res.ok) {
    const { detail, requestId } = await errorInfo(res, [rest.clientSecret]);
    const suffix = detail ? `: ${detail}` : '';
    const message =
      res.status === 400 || res.status === 401
        ? `D&H rejected the REST client credentials (HTTP ${res.status})${suffix}. Check the Client ID and Secret from your D&H API Portal app (Applications > your app > OAuth Credentials).`
        : `D&H OAuth service error (HTTP ${res.status})${suffix}.`;
    throw new DandhApiError(withRequestId(message, requestId), res.status, requestId);
  }

  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = JSON.parse(await readBoundedText(res, 64 * 1024, OAUTH_SERVICE)) as typeof data;
  } catch (err) {
    if (err instanceof DandhApiError) throw err;
    throw new DandhApiError('D&H OAuth service returned a non-JSON token response.', res.status);
  }
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new DandhApiError('D&H OAuth service returned no access_token.', res.status);
  }
  const expiresIn = Number(data.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TOKEN_TTL_MS;
  return { token: data.access_token, expireAt: Date.now() + ttl };
}

// ---- requests -------------------------------------------------------------

/** A list goes out as repeated keys (`items=A&items=B`). */
export type QueryValue = string | number | readonly string[];

/** Builds a URL on the fixed API origin and refuses anything that would leave the customer API at exactly `path`. */
export function buildRestUrl(path: string, query: Record<string, QueryValue | undefined> = {}, environment: Environment = dandhEnvironment()): URL {
  const origin = REST_HOSTS[environment].api;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of typeof value === 'object' ? value : value === undefined ? [] : [value]) params.append(key, String(v));
  }
  const qs = params.toString();
  if (!path.startsWith(CUSTOMER_PREFIX)) throw new ArgumentError('Refusing to call a path outside the D&H Customer Order Management API.');
  const url = new URL(`${path}${qs ? `?${qs}` : ''}`, origin);
  if (url.origin !== origin || url.pathname !== path) {
    throw new ArgumentError('Refusing to call a path outside the D&H Customer Order Management API.');
  }
  return url;
}

export interface RestRequest {
  /** Full path with every dynamic segment already validated and percent-encoded. */
  path: string;
  query?: Record<string, QueryValue | undefined>;
}

export interface RestResponse {
  /** Parsed JSON body, or null for an empty body. */
  body: unknown;
  /** Next-page token from the `x-scroll-id` response header, if present. */
  scrollId?: string;
}

/**
 * One authenticated GET. A 401 drops the cached token and retries once with a
 * fresh one; nothing else is retried. Errors keep status, D&H's message and a
 * request id, with secrets removed.
 */
export async function restGet(rest: RestCredentials, req: RestRequest): Promise<RestResponse> {
  const environment = dandhEnvironment();
  const url = buildRestUrl(req.path, req.query, environment);
  let token = await getToken(rest, environment);

  for (let attempt = 0; ; attempt++) {
    const res = await dandhFetch(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'dandh-tenant': TENANT_BY_COMPANY[rest.company],
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
      },
      API_SERVICE,
    );

    if (res.status === 401 && attempt === 0) {
      await res.body?.cancel().catch(() => undefined);
      token = await getToken(rest, environment, token);
      continue;
    }
    if (!res.ok) throw await apiError(res, [rest.clientSecret, token]);

    const text = await readBoundedText(res, maxUpstreamBytes(), API_SERVICE);
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new DandhApiError(`D&H returned a non-JSON response for GET ${url.pathname} (HTTP ${res.status}).`, res.status, requestIdOf(res));
      }
    }
    return { body, scrollId: res.headers.get('x-scroll-id')?.trim() || undefined };
  }
}

const STATUS_HINTS: Record<number, string> = {
  400: 'D&H rejected the request (HTTP 400){d}. Check the item numbers and query parameters.',
  401: 'D&H rejected the REST credentials (HTTP 401){d}. Check the Client ID and Secret from your D&H API Portal app.',
  403: 'D&H denied access (HTTP 403){d}. The account number, company or API entitlement is not permitted for these credentials: confirm the app has the Customer Order Management API enabled and the account number and company match.',
  404: 'D&H returned not found (HTTP 404){d}. Check the item or order identifier, account number and company.',
  429: 'D&H rate limit (HTTP 429) reached{d}. Try again shortly.',
};

async function apiError(res: Response, secrets: string[]): Promise<DandhApiError> {
  const { detail, requestId } = await errorInfo(res, secrets);
  const d = detail ? `: ${detail}` : '';
  const template =
    STATUS_HINTS[res.status] ??
    (res.status >= 500 ? `D&H service error (HTTP ${res.status}){d}. This is usually temporary.` : `D&H request failed (HTTP ${res.status}){d}.`);
  const retryAfter = res.status === 429 ? Number.parseInt(res.headers.get('retry-after') ?? '', 10) : NaN;
  const message = template.replace('{d}', d) + (retryAfter >= 0 ? ` Retry after ${retryAfter} seconds.` : '');
  return new DandhApiError(withRequestId(message, requestId), res.status, requestId);
}

/** Body keys that carry a human-readable reason. errorName/debugId/details are the Axway shape D&H returned to live probes (2026-11-09). */
const DETAIL_KEYS = ['message', 'errorName', 'error', 'error_description', 'detail', 'details', 'title', 'errors'];

/**
 * A short detail and a request id for an error response. The detail comes
 * from the JSON body (or short plain text), plus the `www-authenticate`
 * error_description D&H sends with an empty 401. Each piece is redacted
 * after JSON decoding, so a JSON-escaped secret cannot slip through, and
 * before truncation.
 */
async function errorInfo(res: Response, secrets: string[]): Promise<{ detail?: string; requestId?: string }> {
  const trimmed = (await readErrorBody(res)).trim();
  const parts: string[] = [];
  let debugId: unknown;
  const collect = (v: unknown, depth = 0): void => {
    if (depth > 3 || v == null) return;
    if (typeof v === 'string') {
      if (v.trim()) parts.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, 5)) collect(x, depth + 1);
    } else if (typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      if (depth === 0) debugId = rec.debugId;
      for (const key of DETAIL_KEYS) collect(rec[key], depth + 1);
    }
  };
  if (trimmed) {
    try {
      collect(JSON.parse(trimmed));
    } catch {
      // Non-JSON: keep it only if it looks like short plain text, not a web page.
      if (!trimmed.startsWith('<') && trimmed.length <= 300) parts.push(trimmed);
    }
  }
  const challenge = res.headers.get('www-authenticate')?.match(/error_description="([^"]*)"/)?.[1];
  if (challenge) parts.push(challenge);
  const unique = [...new Set(parts.map((p) => redactText(p, secrets)))].join('; ');
  const bodyId = typeof debugId === 'string' && debugId.trim() ? redactText(debugId.trim(), secrets).slice(0, 128) : undefined;
  return { detail: unique ? unique.slice(0, 500) : undefined, requestId: requestIdOf(res) ?? bodyId };
}
