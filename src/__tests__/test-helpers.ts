import type { CallToolResult } from '../tools/types.js';

/** Extracts the text of the first content block, failing loudly if it isn't text. */
export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') {
    throw new Error(`Expected a text content block, got: ${JSON.stringify(block)}`);
  }
  return block.text;
}

import { vi } from 'vitest';
import { clearTokenCache, retryConfig } from '../rest-client.js';
import { clearPoRegistry } from '../order-safety.js';

export const REST_ENV = {
  DANDH_CLIENT_ID: 'cid-test',
  DANDH_CLIENT_SECRET: 'csecret-do-not-log',
  DANDH_ACCOUNT_NUMBER: '1234567890',
};
export const XML_ENV = {
  DANDH_XML_USER_CODE: 'xml-user',
  DANDH_XML_PASSWORD: 'xml-pass-do-not-log',
};

const DANDH_KEYS = [
  'DANDH_CLIENT_ID', 'DANDH_CLIENT_SECRET', 'DANDH_ACCOUNT_NUMBER', 'DANDH_COMPANY',
  'DANDH_XML_USER_CODE', 'DANDH_XML_PASSWORD', 'DANDH_XML_COUNTRY', 'DANDH_ENVIRONMENT', 'DANDH_XML_URL',
  'DANDH_MAX_ORDER_LINES', 'DANDH_MAX_LINE_QUANTITY', 'DANDH_MAX_ORDER_VALUE', 'DANDH_MAX_UNIT_PRICE',
];

/** Resets DANDH_* env vars, token cache and retry delays, then applies `env`. */
export function setupEnv(env: Record<string, string> = {}): void {
  for (const k of DANDH_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  clearTokenCache();
  clearPoRegistry();
  retryConfig.baseDelayMs = 0;
  retryConfig.maxDelayMs = 0;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/xml' } });
}

export const TOKEN_OK = { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 };

export function stubFetch() {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Queues a token response followed by the given API responses. */
export function queue(fetchMock: ReturnType<typeof vi.fn>, ...responses: Response[]): void {
  fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_OK));
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
}

export function callUrl(fetchMock: ReturnType<typeof vi.fn>, i: number): URL {
  return new URL(fetchMock.mock.calls[i][0] as string);
}

export function callInit(fetchMock: ReturnType<typeof vi.fn>, i: number): RequestInit & { headers: Record<string, string> } {
  return fetchMock.mock.calls[i][1];
}

/** Decodes the xmlDoc form field posted to the XML endpoint. */
export function postedXml(fetchMock: ReturnType<typeof vi.fn>, i = 0): string {
  const body = callInit(fetchMock, i).body as string;
  return new URLSearchParams(body).get('xmlDoc') ?? '';
}
