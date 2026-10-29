import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseXmlUrlOverride } from '../config.js';
import {
  DEFAULT_ORDER_LIMITS,
  OrderLimitError,
  PO_REGISTRY_MAX,
  PO_REGISTRY_TTL_MS,
  checkUnitPrice,
  checkDhUnitPrice,
  checkLineCount,
  checkLineQuantity,
  checkOrderValue,
  clearPoRegistry,
  loadOrderLimits,
  orderTotal,
  poRegistrySize,
  reservePo,
} from '../order-safety.js';
import { validateStartupConfig } from '../startup.js';

describe('loadOrderLimits', () => {
  it('uses conservative defaults', () => {
    expect(loadOrderLimits({})).toEqual({ maxLines: 25, maxLineQuantity: 100, maxOrderValue: 5000, maxUnitPrice: 25000 });
  });

  it('reads overrides from env', () => {
    expect(
      loadOrderLimits({ DANDH_MAX_ORDER_LINES: '3', DANDH_MAX_LINE_QUANTITY: '7', DANDH_MAX_ORDER_VALUE: '99.5', DANDH_MAX_UNIT_PRICE: '10' }),
    ).toEqual({ maxLines: 3, maxLineQuantity: 7, maxOrderValue: 99.5, maxUnitPrice: 10 });
  });

  it.each([
    ['DANDH_MAX_ORDER_LINES', '0'],
    ['DANDH_MAX_ORDER_LINES', '-1'],
    ['DANDH_MAX_ORDER_LINES', '2.5'],
    ['DANDH_MAX_LINE_QUANTITY', 'abc'],
    ['DANDH_MAX_ORDER_VALUE', '0'],
    ['DANDH_MAX_ORDER_VALUE', 'NaN'],
    ['DANDH_MAX_ORDER_VALUE', 'Infinity'],
    ['DANDH_MAX_UNIT_PRICE', '-5'],
    ['DANDH_MAX_UNIT_PRICE', '1e3'],
  ])('%s=%s is a ConfigError naming the variable', (name, value) => {
    expect(() => loadOrderLimits({ [name]: value })).toThrow(ConfigError);
    expect(() => loadOrderLimits({ [name]: value })).toThrow(new RegExp(name));
  });

  it('validateStartupConfig fails on bad caps or a bad XML URL', () => {
    expect(() => validateStartupConfig({})).not.toThrow();
    expect(() => validateStartupConfig({ DANDH_MAX_ORDER_VALUE: '-1' })).toThrow(ConfigError);
    expect(() => validateStartupConfig({ DANDH_XML_URL: 'http://www.dandh.com/x' })).toThrow(ConfigError);
  });
});

describe('checkUnitPrice', () => {
  const L = DEFAULT_ORDER_LIMITS;
  it.each([9.99, 0.01, 100, 25000, 99999.99])('accepts %s (no cap: caller prices never count toward limits)', (v) => {
    expect(checkUnitPrice(v, 'price')).toBe(v);
  });
  it.each([
    [0, /greater than 0/],
    [-1, /greater than 0/],
    [NaN, /must be a number/],
    [Infinity, /must be a number/],
    ['9.99', /must be a number/],
    [null, /must be a number/],
    [1.005, /2 decimal places/],
  ])('rejects %s', (v, re) => {
    expect(() => checkUnitPrice(v, 'price')).toThrow(re);
  });

  it('checkDhUnitPrice caps the D&H price', () => {
    expect(() => checkDhUnitPrice(25000, 'item A', L)).not.toThrow();
    expect(() => checkDhUnitPrice(25000.01, 'item A', L)).toThrow(/unit-price limit.*DANDH_MAX_UNIT_PRICE/);
  });
});

describe('orderTotal', () => {
  it('sums qty * price in cents and is null when any price is unknown', () => {
    expect(orderTotal([{ quantity: 3, unitPrice: 0.1 }, { quantity: 1, unitPrice: 0.2 }])).toBe(0.5);
    expect(orderTotal([{ quantity: 1, unitPrice: 5 }, { quantity: 1 }])).toBeNull();
  });
});

describe('PO registry', () => {
  beforeEach(() => {
    clearPoRegistry();
    vi.useRealTimers();
  });

  it('refuses a duplicate PO case-insensitively and trimmed, without naming the account', () => {
    reservePo('1234567890', 'PO-1', 'dandh_list_order_tracking');
    let msg = '';
    try {
      reservePo('1234567890', '  po-1 ', 'dandh_list_order_tracking');
    } catch (e) {
      expect(e).toBeInstanceOf(OrderLimitError);
      msg = (e as Error).message;
    }
    expect(msg).toBe('PO number po-1 was already sent to D&H from this connection in the last 24 hours, so it was not sent again. Check its status with dandh_list_order_tracking first. Only if no order shows up, ask the user for a new PO number.');
    expect(msg).not.toContain('1234567890');
  });

  it('scopes by account identity', () => {
    reservePo('1111111111', 'PO-1', 't');
    expect(() => reservePo('2222222222', 'PO-1', 't')).not.toThrow();
  });

  it('release frees the PO', () => {
    const release = reservePo('a', 'PO-1', 't');
    release();
    expect(() => reservePo('a', 'PO-1', 't')).not.toThrow();
  });

  it('expires after 24h', () => {
    vi.useFakeTimers();
    reservePo('a', 'PO-1', 't');
    vi.advanceTimersByTime(PO_REGISTRY_TTL_MS - 1000);
    expect(() => reservePo('a', 'PO-1', 't')).toThrow(OrderLimitError);
    vi.advanceTimersByTime(2000);
    expect(() => reservePo('a', 'PO-1', 't')).not.toThrow();
  });

  it('is bounded, evicting the oldest entries', () => {
    for (let i = 0; i < PO_REGISTRY_MAX + 50; i++) reservePo('a', `PO-${i}`, 't');
    expect(poRegistrySize()).toBeLessThanOrEqual(PO_REGISTRY_MAX);
    expect(() => reservePo('a', 'PO-0', 't')).not.toThrow(); // evicted
    expect(() => reservePo('a', `PO-${PO_REGISTRY_MAX + 49}`, 't')).toThrow(OrderLimitError); // newest kept
  });
});

describe('parseXmlUrlOverride', () => {
  it('returns undefined when unset', () => {
    expect(parseXmlUrlOverride(undefined)).toBeUndefined();
    expect(parseXmlUrlOverride('  ')).toBeUndefined();
  });

  it.each([
    'https://www.dandh.com/dhXML/xmlDispatch',
    'https://www.dandh.ca/dhXML/xmlDispatch',
    'https://dandh.com/x',
    'https://test.www.dandh.ca/x',
    'https://WWW.DANDH.COM/x',
    'https://www.dandh.com:443/x',
  ])('accepts %s', (u) => {
    expect(parseXmlUrlOverride(u)).toBeTruthy();
  });

  it.each([
    'http://www.dandh.com/x',
    'https://dandh.com.evil.com/x',
    'https://evildandh.com/x',
    'https://www.dandh.com.evil.com/x',
    'https://evil.com/www.dandh.com',
    'https://user:pw@www.dandh.com/x',
    'https://www.dandh.com@evil.com/x',
    'https://www.dandh.com:8443/x',
    'https://dandh.org/x',
    'ftp://www.dandh.com/x',
    'not a url',
  ])('rejects %s', (u) => {
    expect(() => parseXmlUrlOverride(u)).toThrow(ConfigError);
  });
});

describe('cap messages', () => {
  it('line and quantity caps point to separate approved orders or the connector owner', () => {
    expect(() => checkLineCount(26, DEFAULT_ORDER_LIMITS)).toThrow(
      'This order has 26 lines; the limit is 25. Split it into separate orders, each approved by the user, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_LINES.',
    );
    expect(() => checkLineQuantity(101, 'items[0].quantity', DEFAULT_ORDER_LIMITS)).toThrow(
      'items[0].quantity is 101; the per-line limit is 100. Lower it, split it into separate orders, each approved by the user, or ask whoever runs this D&H connector to raise DANDH_MAX_LINE_QUANTITY.',
    );
  });
  it('value cap never suggests splitting', () => {
    expect(() => checkOrderValue(7230, DEFAULT_ORDER_LIMITS)).toThrow(
      "This order's estimated total ($7,230.00) is over the $5,000.00 limit, so it was not placed. Don't split it to get under the limit. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise DANDH_MAX_ORDER_VALUE.",
    );
  });
});
