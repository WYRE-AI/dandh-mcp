import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { redact, sanitizeForLog } from '../utils/redact.js';
import { REST_ENV, XML_ENV, jsonResponse, setupEnv, stubFetch, textOf, xmlResponse } from './test-helpers.js';

const SECRETS = ['csecret-do-not-log', 'xml-pass-do-not-log', 'tok-leaky', 'ds-secret-pw'];

describe('secret redaction', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  let logs: string[];
  beforeEach(() => {
    setupEnv({ ...REST_ENV, ...XML_ENV });
    fetchMock = stubFetch();
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    process.env.LOG_LEVEL = 'debug';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.LOG_LEVEL;
  });

  function assertClean(...texts: string[]) {
    for (const t of [...texts, logs.join('\n')]) for (const s of SECRETS) expect(t).not.toContain(s);
  }

  it('scrubs secrets echoed in REST error bodies from results and logs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok-leaky', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad: Bearer tok-leaky secret csecret-do-not-log https://api.dandh.com/x?client_secret=csecret-do-not-log' }, 400));
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBe(true);
    assertClean(textOf(res));
  });

  it('scrubs the XML password and drop-ship password from failures', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('<XMLRESPONSE><STATUS>failure</STATUS><MESSAGE>bad xml-pass-do-not-log and ds-secret-pw <PASSWORD>xml-pass-do-not-log</PASSWORD></MESSAGE></XMLRESPONSE>'));
    const res = await dispatchToolCall('dandh_xml_create_order', {
      poNumber: 'P1', shipCarrier: 'UPS', shipService: 'Ground', confirm: true, items: [{ partNumber: 'A', quantity: 1, price: 5 }],
      shipTo: { name: 'n', address: 'a', city: 'c', state: 'TX', zip: '78701', dropShipPassword: 'ds-secret-pw' },
    });
    expect(res.isError).toBe(true);
    assertClean(textOf(res));
  });

  it('network error text containing secrets is scrubbed', async () => {
    fetchMock.mockRejectedValue(new Error('connect failed for xml-pass-do-not-log'));
    const res = await dispatchToolCall('dandh_xml_item_inquiry', { partNumber: 'A' });
    assertClean(textOf(res));
  });

  it('logger masks sensitive keys and token/password patterns', () => {
    logger.info('hello Bearer abc.def-ghi', {
      password: 'xml-pass-do-not-log', clientSecret: 'csecret-do-not-log', Authorization: 'Bearer tok-leaky',
      nested: { access_token: 'tok-leaky', note: '<PASSWORD>xml-pass-do-not-log</PASSWORD>' }, ok: 'visible',
    });
    const line = logs.join('\n');
    assertClean(line);
    expect(line).toContain('visible');
    expect(line).not.toContain('abc.def-ghi');
  });

  it('redact() and sanitizeForLog() helpers', () => {
    expect(redact('a SECRETVAL b', ['SECRETVAL'])).toBe('a [redacted] b');
    expect(redact('xmlDoc=%3CXML%3E&x=1')).toContain('xmlDoc=[redacted]');
    expect(sanitizeForLog({ a: { password: 'x' } })).toEqual({ a: { password: '[redacted]' } });
  });

  it('does not run literal redaction for secrets shorter than 6 characters', () => {
    expect(redact('the pass is abc and also abcdef', ['abc'])).toBe('the pass is abc and also abcdef');
    expect(redact('a12345 b', ['a12345'])).toBe('[redacted] b');
    expect(redact('a1234 b', ['a1234'])).toBe('a1234 b');
    expect(redact('Bearer abc', ['abc'])).toBe('Bearer [redacted]');
  });

  it('never logs request bodies on successful calls', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('<XMLRESPONSE><ITEM><PARTNUM>A</PARTNUM></ITEM><STATUS>success</STATUS></XMLRESPONSE>'));
    await dispatchToolCall('dandh_xml_get_price_availability', { mode: 'price', partNumbers: ['A'] });
    assertClean('');
  });
});
