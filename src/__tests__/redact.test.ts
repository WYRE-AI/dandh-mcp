import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithCredentials } from '../credentials.js';
import { redactText, redactValue, renderSafe } from '../redact.js';
import { clearTokenCache } from '../rest-client.js';
import { getDefaultToolset, resetToolsets } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import {
  FAKE_ACCOUNT,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_TOKEN,
  FAKE_XML_PASSWORD,
  FAKE_XML_USER,
  REST_ENV,
  XML_ENV,
  apiRoute,
  jsonResponse,
  mockDandh,
  setEnv,
  textOf,
  tokenRoute,
  xmlResponse,
  xmlRoute,
} from './helpers.js';

beforeEach(() => {
  clearTokenCache();
  resetToolsets();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

describe('redactText / redactValue', () => {
  it('removes known secrets, Bearer tokens, JWTs, XML passwords and form secrets', () => {
    const text = [
      `secret ${FAKE_CLIENT_SECRET}`,
      `Authorization: Bearer ${FAKE_TOKEN}`,
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
      '<LOGIN><USERID>u</USERID><PASSWORD>hunter2-xml</PASSWORD></LOGIN>',
      'client_secret=abc123&grant_type=client_credentials',
      'xmlDoc=%3CXMLFORMPOST%3E',
    ].join('\n');
    const out = redactText(text, [FAKE_CLIENT_SECRET]);
    for (const leaked of [FAKE_CLIENT_SECRET, FAKE_TOKEN, 'eyJhbGciOiJIUzI1NiJ9', 'hunter2-xml', 'abc123', '%3CXMLFORMPOST']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('grant_type=client_credentials');
  });

  it('masks credential-named keys in structured values', () => {
    expect(redactValue({ client_secret: 's', password: 'p', access_token: 't', nested: [{ Authorization: 'Bearer x' }], itemId: 'A' })).toEqual({
      client_secret: '[REDACTED]',
      password: '[REDACTED]',
      access_token: '[REDACTED]',
      nested: [{ Authorization: '[REDACTED]' }],
      itemId: 'A',
    });
  });

  it('redacts before truncating so no secret prefix survives', () => {
    // Truncating first at 18 chars would leave the first 8 characters of the secret behind.
    const out = renderSafe(`${'x'.repeat(10)}${FAKE_CLIENT_SECRET}`, 18, [FAKE_CLIENT_SECRET]);
    expect(out).not.toContain(FAKE_CLIENT_SECRET.slice(0, 8));
    expect(out).toMatch(/truncated/);
  });
});

describe('credentials never reach tool errors', () => {
  it('a vendor error body echoing the REST secret and token is scrubbed', async () => {
    setEnv(REST_ENV);
    mockDandh([tokenRoute, apiRoute(() => jsonResponse({ message: `bad secret ${FAKE_CLIENT_SECRET} with Bearer ${FAKE_TOKEN}` }, 400))]);
    const res = await getDefaultToolset().dispatch('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/HTTP 400/);
    expect(text).not.toContain(FAKE_CLIENT_SECRET);
    expect(text).not.toContain(FAKE_TOKEN);
  });

  it('an XML failure message echoing the password is scrubbed', async () => {
    setEnv(XML_ENV);
    mockDandh([xmlRoute(() => xmlResponse(`<XMLRESPONSE><STATUS>failure</STATUS><MESSAGE>Login ${FAKE_XML_USER}/${FAKE_XML_PASSWORD} rejected</MESSAGE></XMLRESPONSE>`))]);
    const res = await getDefaultToolset().dispatch('dandh_xml_item_inquiry', { partNumber: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/possible sign-in problem/);
    expect(textOf(res)).not.toContain(FAKE_XML_PASSWORD);
  });

  it('a successful response that happens to contain a secret is scrubbed too', async () => {
    setEnv(REST_ENV);
    mockDandh([tokenRoute, apiRoute(() => jsonResponse({ note: FAKE_CLIENT_SECRET, client_secret: 'other' }))]);
    const text = textOf(await getDefaultToolset().dispatch('dandh_get_item', { itemId: 'A' }));
    expect(text).not.toContain(FAKE_CLIENT_SECRET);
    expect(text).not.toContain('other');
  });
});

describe('logger', () => {
  it('redacts the per-request (gateway) secrets in scope and env secrets', () => {
    process.env.LOG_LEVEL = 'debug';
    setEnv({ DANDH_XML_PASSWORD: 'env-xml-password-value' });
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      lines.push(line);
    });
    runWithCredentials(
      { rest: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, accountNumber: FAKE_ACCOUNT, company: 'us' }, xml: { userCode: FAKE_XML_USER, password: FAKE_XML_PASSWORD, country: 'us' } },
      () => {
        logger.warn(`message with ${FAKE_CLIENT_SECRET}`, { detail: `ctx ${FAKE_XML_PASSWORD}`, password: 'plain' });
        logger.info('env leak env-xml-password-value');
      },
    );
    const out = lines.join('\n');
    expect(lines).toHaveLength(2);
    for (const leaked of [FAKE_CLIENT_SECRET, FAKE_XML_PASSWORD, 'env-xml-password-value', '"plain"']) expect(out).not.toContain(leaked);
    expect(out).toContain('[REDACTED]');
  });
});
