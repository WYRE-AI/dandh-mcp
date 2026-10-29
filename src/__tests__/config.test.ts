import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialsFromEnv, credentialsFromHeaders, ConfigError } from '../config.js';
import { runWithCredentials } from '../credentials.js';
import { dispatchToolCall } from '../tools/index.js';
import { REST_ENV, XML_ENV, jsonResponse, setupEnv, stubFetch, textOf, xmlResponse } from './test-helpers.js';

describe('credential sets', () => {
  beforeEach(() => setupEnv());

  it('accepts REST only, XML only, or both, with defaults', () => {
    expect(credentialsFromEnv({ ...REST_ENV })).toEqual({
      rest: { clientId: 'cid-test', clientSecret: 'csecret-do-not-log', accountNumber: '1234567890', company: 'us' },
      environment: 'production',
    });
    expect(credentialsFromEnv({ ...XML_ENV }).xml).toEqual({ userCode: 'xml-user', password: 'xml-pass-do-not-log', country: 'us' });
    const both = credentialsFromEnv({ ...REST_ENV, ...XML_ENV, DANDH_COMPANY: 'DSC', DANDH_XML_COUNTRY: 'ca', DANDH_ENVIRONMENT: 'test' });
    expect(both.rest?.company).toBe('dsc');
    expect(both.xml?.country).toBe('ca');
    expect(both.environment).toBe('test');
  });

  it.each([
    [{ DANDH_CLIENT_ID: 'a' }, /Incomplete D&H REST credential set: missing DANDH_CLIENT_SECRET, DANDH_ACCOUNT_NUMBER/],
    [{ ...REST_ENV, DANDH_CLIENT_SECRET: '' }, /missing DANDH_CLIENT_SECRET/],
    [{ DANDH_XML_USER_CODE: 'u' }, /Incomplete D&H XML credential set: missing DANDH_XML_PASSWORD/],
    [{ DANDH_XML_PASSWORD: 'p' }, /missing DANDH_XML_USER_CODE/],
    [{ ...REST_ENV, DANDH_ACCOUNT_NUMBER: '12345' }, /10-digit/],
    [{ ...REST_ENV, DANDH_COMPANY: 'uk' }, /must be one of us, ca, dsc/],
    [{ ...XML_ENV, DANDH_XML_COUNTRY: 'dsc' }, /"us" or "ca"/],
    [{ ...REST_ENV, DANDH_ENVIRONMENT: 'staging' }, /production.*test/],
  ])('rejects invalid/partial env %#', (env, re) => {
    expect(() => credentialsFromEnv(env)).toThrow(ConfigError);
    expect(() => credentialsFromEnv(env)).toThrow(re);
  });

  it('does not leak secret values in config errors', () => {
    try {
      credentialsFromEnv({ DANDH_CLIENT_ID: 'a', DANDH_CLIENT_SECRET: 'super-secret-value' });
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-value');
    }
  });

  it('header parsing mirrors the env rules and names headers', () => {
    const ok = credentialsFromHeaders(
      { 'x-dandh-client-id': 'c', 'x-dandh-client-secret': 's', 'x-dandh-account-number': '1234567890', 'x-dandh-company': 'ca' },
      { requireAny: true },
    );
    expect(ok.rest?.company).toBe('ca');
    expect(() => credentialsFromHeaders({ 'x-dandh-client-id': 'c' }, { requireAny: true })).toThrow(/X-DandH-Client-Secret/);
    expect(() => credentialsFromHeaders({}, { requireAny: true })).toThrow(/missing required gateway credential headers/);
    expect(credentialsFromHeaders({}, { requireAny: false })).toEqual({ environment: 'production' });
  });
});

describe('service not configured', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    setupEnv();
    fetchMock = stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('REST tool with only XML configured names the missing service and the XML equivalent', async () => {
    Object.assign(process.env, XML_ENV);
    const res = await dispatchToolCall('dandh_get_prices_bulk', { items: ['A'] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/REST \(Customer Order Management API\) service is not configured/);
    expect(textOf(res)).toContain('dandh_xml_get_price_availability');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('XML tool with only REST configured names the missing service and the REST equivalent', async () => {
    Object.assign(process.env, REST_ENV);
    const res = await dispatchToolCall('dandh_xml_create_order', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/XML service is not configured/);
    expect(textOf(res)).toContain('dandh_create_sales_order');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('neither configured: error names both credential sets', async () => {
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(textOf(res)).toMatch(/DANDH_CLIENT_ID/);
    expect(textOf(res)).toMatch(/dandh_xml_item_inquiry/);
  });

  it('partial env sets surface as a tool error', async () => {
    process.env.DANDH_CLIENT_ID = 'x';
    const res = await dispatchToolCall('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Incomplete D&H REST credential set/);
  });

  it('request-scoped credentials never fall back to env', async () => {
    Object.assign(process.env, REST_ENV);
    const res = await runWithCredentials({ environment: 'production', xml: { userCode: 'u', password: 'p', country: 'us' } }, () =>
      dispatchToolCall('dandh_get_item', { itemId: 'A' }));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    void jsonResponse; void xmlResponse;
  });
});
