import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetGatewayLock } from '../config.js';
import { credentialsFromEnv, credentialsFromHeaders, resolveCredentials, runWithCredentials } from '../credentials.js';
import { CredentialError } from '../types.js';
import {
  FAKE_ACCOUNT,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_ENV_CLIENT_SECRET,
  FAKE_XML_PASSWORD,
  FAKE_XML_USER,
  GATEWAY_HEADERS,
  REST_ENV,
  setEnv,
} from './helpers.js';

beforeEach(() => setEnv());
afterEach(() => resetGatewayLock());

describe('credential sets (all-or-none, validated)', () => {
  it('reads the REST and XML sets from env with defaults', () => {
    expect(credentialsFromEnv({ ...REST_ENV, DANDH_XML_USER_CODE: FAKE_XML_USER, DANDH_XML_PASSWORD: FAKE_XML_PASSWORD })).toEqual({
      rest: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, accountNumber: FAKE_ACCOUNT, company: 'us' },
      xml: { userCode: FAKE_XML_USER, password: FAKE_XML_PASSWORD, country: 'us' },
    });
    expect(credentialsFromEnv({})).toEqual({});
  });

  it('reads exactly the seven X-DandH-* headers', () => {
    const creds = credentialsFromHeaders({ ...GATEWAY_HEADERS, 'x-dandh-company': 'CA', 'x-dandh-xml-country': 'ca' });
    expect(creds).toEqual({
      rest: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, accountNumber: FAKE_ACCOUNT, company: 'ca' },
      xml: { userCode: FAKE_XML_USER, password: FAKE_XML_PASSWORD, country: 'ca' },
    });
  });

  it.each([
    [{ 'x-dandh-client-id': FAKE_CLIENT_ID }, /Incomplete D&H REST credential set: missing X-DandH-Client-Secret, X-DandH-Account-Number/],
    [{ 'x-dandh-xml-user-code': FAKE_XML_USER }, /Incomplete D&H XML credential set: missing X-DandH-Xml-Password/],
    [{ ...GATEWAY_HEADERS, 'x-dandh-account-number': '12345' }, /10-digit/],
    [{ ...GATEWAY_HEADERS, 'x-dandh-account-number': '../../x/1234' }, /10-digit/],
    [{ ...GATEWAY_HEADERS, 'x-dandh-company': 'uk' }, /X-DandH-Company.*us, ca, dsc/],
    [{ ...GATEWAY_HEADERS, 'x-dandh-xml-country': 'mx' }, /X-DandH-Xml-Country.*us.*ca/],
    [{}, /missing required gateway credential headers/],
    [{ 'x-dandh-company': 'us', 'x-dandh-xml-country': 'us' }, /missing required gateway credential headers/],
  ])('rejects %j', (headers, re) => {
    expect(() => credentialsFromHeaders(headers)).toThrow(CredentialError);
    expect(() => credentialsFromHeaders(headers)).toThrow(re);
  });

  it('error messages never contain a credential value', () => {
    try {
      credentialsFromHeaders({ 'x-dandh-client-secret': FAKE_CLIENT_SECRET });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_CLIENT_SECRET);
    }
  });

  it('ignores the old X-DandH-Environment header (the host is never caller-selected)', () => {
    expect(credentialsFromHeaders({ ...GATEWAY_HEADERS, 'x-dandh-environment': 'test' })).not.toHaveProperty('environment');
  });
});

describe('gateway mode never reads env credentials', () => {
  it('outside a request scope, gateway mode refuses even when DANDH_* is set', () => {
    setEnv({ ...REST_ENV, DANDH_CLIENT_SECRET: FAKE_ENV_CLIENT_SECRET, AUTH_MODE: 'gateway' });
    expect(() => resolveCredentials()).toThrow(/X-DandH-\* headers/);
  });

  it('inside a request scope, only the scoped (header) credentials are used', () => {
    setEnv({ ...REST_ENV, DANDH_CLIENT_SECRET: FAKE_ENV_CLIENT_SECRET, AUTH_MODE: 'gateway' });
    const scoped = credentialsFromHeaders(GATEWAY_HEADERS);
    expect(runWithCredentials(scoped, () => resolveCredentials()).rest?.clientSecret).toBe(FAKE_CLIENT_SECRET);
  });

  it('an unparseable AUTH_MODE fails closed (treated as gateway)', () => {
    setEnv({ ...REST_ENV, AUTH_MODE: 'gatway' });
    expect(() => resolveCredentials()).toThrow(/X-DandH-\* headers/);
  });

  it('env mode (stdio) reads DANDH_*', () => {
    setEnv(REST_ENV);
    expect(resolveCredentials().rest?.clientId).toBe(FAKE_CLIENT_ID);
  });
});
