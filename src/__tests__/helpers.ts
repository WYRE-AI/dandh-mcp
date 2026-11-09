import { vi } from 'vitest';
import type { CallToolResult } from '../tools/types.js';

/**
 * Every fake credential used by the test suite lives here. .gitleaks.toml
 * allowlists these exact strings and nothing broader.
 */
export const FAKE_CLIENT_ID = 'dandh-test-client-id';
export const FAKE_CLIENT_SECRET = 'dandh-test-client-secret-not-real-7Qx2';
export const FAKE_ACCOUNT = '1234567890';
export const FAKE_XML_USER = 'dandh-test-xml-user';
export const FAKE_XML_PASSWORD = 'dandh-test-xml-password-not-real-9Kp4';
export const FAKE_ENV_CLIENT_SECRET = 'dandh-env-client-secret-must-not-be-used';
export const FAKE_ENV_XML_PASSWORD = 'dandh-env-xml-password-must-not-be-used';
export const FAKE_TOKEN = 'dandh-test-access-token-not-real-3Lm8';
/** An opaque token with `/`, which JSON may escape as `\/`. */
export const FAKE_SLASH_TOKEN = 'dandh/test-token/not-real-5Wn1';
export const FAKE_S2S_SECRET = 'test-s2s-7Hq2Lw9Zr4Kx8Mv3Nb6Pc1Td5Fg0Yj';

export const REST_ENV = {
  DANDH_CLIENT_ID: FAKE_CLIENT_ID,
  DANDH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  DANDH_ACCOUNT_NUMBER: FAKE_ACCOUNT,
};
export const XML_ENV = {
  DANDH_XML_USER_CODE: FAKE_XML_USER,
  DANDH_XML_PASSWORD: FAKE_XML_PASSWORD,
};

/** Gateway headers carrying a full REST set and a full XML set. */
export const GATEWAY_HEADERS = {
  'x-dandh-client-id': FAKE_CLIENT_ID,
  'x-dandh-client-secret': FAKE_CLIENT_SECRET,
  'x-dandh-account-number': FAKE_ACCOUNT,
  'x-dandh-xml-user-code': FAKE_XML_USER,
  'x-dandh-xml-password': FAKE_XML_PASSWORD,
};

export const API_ORIGIN = 'https://api.dandh.com';
export const AUTH_ORIGIN = 'https://auth.dandh.com';
export const XML_URL = 'https://www.dandh.com/dhXML/xmlDispatch';
export const BASE_PATH = `/customerOrderManagement/v2/customers/${FAKE_ACCOUNT}`;

/** Clears every DANDH_* variable and AUTH_MODE, then applies `env`. */
export function setEnv(env: Record<string, string> = {}): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('DANDH_') || k === 'AUTH_MODE') delete process.env[k];
  Object.assign(process.env, env);
}

export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') throw new Error(`Expected text content, got ${JSON.stringify(block)}`);
  return block.text;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/xml' } });
}

export const tokenResponse = () => jsonResponse({ access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 3600 });

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
}

export type Route = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

/**
 * Stubs globalThis.fetch as D&H. Unmatched requests answer 599 so a wrong
 * host or path fails the test loudly instead of looking like a vendor 404.
 */
export function mockDandh(routes: Route[] = []) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    for (const route of routes) {
      const response = await route(call);
      if (response) return response;
    }
    return new Response(`unmatched ${call.method} ${url.href}`, { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** Answers the OAuth token endpoint. */
export const tokenRoute: Route = (call) =>
  call.url.origin === AUTH_ORIGIN && call.url.pathname === '/api/oauth/token' ? tokenResponse() : undefined;

/** Answers every REST API GET with `respond`. */
export function apiRoute(respond: (call: RecordedCall) => Response): Route {
  return (call) => (call.url.origin === API_ORIGIN ? respond(call) : undefined);
}

/** Answers every XML dispatcher POST with `respond`. */
export function xmlRoute(respond: (call: RecordedCall) => Response): Route {
  return (call) => (call.url.href === XML_URL ? respond(call) : undefined);
}

/** The xmlDoc form field posted to the XML dispatcher. */
export function postedXml(call: RecordedCall): string {
  return new URLSearchParams(call.body ?? '').get('xmlDoc') ?? '';
}
