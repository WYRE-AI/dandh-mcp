import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseXmlUrlOverride } from '../config.js';
import {
  DEFAULT_ORDER_LIMITS,
  OrderLimitError,
  PO_REGISTRY_MAX,
  PO_REGISTRY_PER_IDENTITY_MAX,
  normalizePoForSend,
  loadConfirmSecret,
  PO_REGISTRY_TTL_MS,
  CONFIRM_TOKEN_TTL_MS,
  assertPoNotAtDh,
  checkConfirmToken,
  makeConfirmToken,
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

  it('refuses a DANDH_CONFIRM_SECRET under 32 bytes without echoing it', () => {
    const short = 'x'.repeat(31);
    expect(() => loadConfirmSecret({ DANDH_CONFIRM_SECRET: short })).toThrow(ConfigError);
    expect(() => loadConfirmSecret({ DANDH_CONFIRM_SECRET: short })).toThrow(/DANDH_CONFIRM_SECRET.*at least 32 bytes/);
    expect(() => loadConfirmSecret({ DANDH_CONFIRM_SECRET: short })).not.toThrow(/xxx/);
    expect(() => validateStartupConfig({ DANDH_CONFIRM_SECRET: short })).toThrow(ConfigError);
    expect(loadConfirmSecret({ DANDH_CONFIRM_SECRET: 'x'.repeat(32) })).toBeInstanceOf(Buffer);
    expect(() => validateStartupConfig({ DANDH_CONFIRM_SECRET: 'x'.repeat(32) })).not.toThrow();
    expect(loadConfirmSecret({ DANDH_CONFIRM_SECRET: '  ' })).toBeUndefined();
    // bytes, not characters: 11 three-byte characters = 33 bytes
    expect(() => loadConfirmSecret({ DANDH_CONFIRM_SECRET: '€'.repeat(11) })).not.toThrow();
    expect(() => loadConfirmSecret({ DANDH_CONFIRM_SECRET: '€'.repeat(10) })).toThrow(ConfigError);
  });

  it('a short DANDH_CONFIRM_SECRET also refuses to make a confirm token', () => {
    process.env.DANDH_CONFIRM_SECRET = 'too-short';
    expect(() => makeConfirmToken('acct', {})).toThrow(ConfigError);
    delete process.env.DANDH_CONFIRM_SECRET;
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

  it('refuses an identity at its per-identity quota, without affecting other identities', () => {
    for (let i = 0; i < PO_REGISTRY_PER_IDENTITY_MAX; i++) reservePo('a', `PO-${i}`, 't');
    expect(() => reservePo('a', 'PO-new', 't')).toThrow(
      'This connection has reached its limit of 200 orders in 24 hours, so this order was not sent. Tell the user; they can place it on dandh.com, or wait and try later.',
    );
    expect(poRegistrySize()).toBe(PO_REGISTRY_PER_IDENTITY_MAX);
    expect(() => reservePo('b', 'PO-new', 't')).not.toThrow();
  });

  it('a released PO frees room under the per-identity quota', () => {
    const release = reservePo('a', 'PO-first', 't');
    for (let i = 1; i < PO_REGISTRY_PER_IDENTITY_MAX; i++) reservePo('a', `PO-${i}`, 't');
    expect(() => reservePo('a', 'PO-new', 't')).toThrow(OrderLimitError);
    release();
    expect(() => reservePo('a', 'PO-new', 't')).not.toThrow();
  });

  it('per-identity quota ignores expired entries', () => {
    vi.useFakeTimers();
    for (let i = 0; i < PO_REGISTRY_PER_IDENTITY_MAX; i++) reservePo('a', `PO-${i}`, 't');
    vi.advanceTimersByTime(PO_REGISTRY_TTL_MS + 1000);
    expect(() => reservePo('a', 'PO-new', 't')).not.toThrow();
    expect(poRegistrySize()).toBe(1);
  });

  it('at the global ceiling, evicts the oldest entry instead of refusing', () => {
    const fill = PO_REGISTRY_MAX / PO_REGISTRY_PER_IDENTITY_MAX;
    for (let id = 0; id < fill; id++) for (let i = 0; i < PO_REGISTRY_PER_IDENTITY_MAX; i++) reservePo(`acct-${id}`, `PO-${i}`, 't');
    expect(poRegistrySize()).toBe(PO_REGISTRY_MAX);
    expect(() => reservePo('fresh', 'PO-new', 't')).not.toThrow();
    expect(poRegistrySize()).toBe(PO_REGISTRY_MAX);
    // the oldest (acct-0 / PO-0) was evicted; the next-oldest is still protected
    expect(() => reservePo('acct-0', 'PO-1', 't')).toThrow(/already sent to D&H/);
    expect(() => reservePo('acct-0', 'PO-0', 't')).not.toThrow();
    expect(() => reservePo('fresh', 'PO-new', 't')).toThrow(/already sent to D&H/);
  });

  it('treats fullwidth digits, NBSP, tabs and repeated spaces as the same PO', () => {
    reservePo('a', 'PO 12', 't');
    for (const variant of ['po\u00A012', 'PO   12', '  Po\t12  ', 'ＰＯ １２', 'po\u2003\u200312']) {
      expect(() => reservePo('a', variant, 't')).toThrow(/already sent to D&H/);
    }
    expect(() => reservePo('a', 'PO 13', 't')).not.toThrow();
    expect(() => reservePo('a', 'PO12', 't')).not.toThrow(); // no whitespace at all is a different PO
  });
});

describe('normalizePoForSend', () => {
  it('applies NFKC, trims and collapses inner whitespace, but keeps case', () => {
    expect(normalizePoForSend('  ＰＯ\u00A0\u00A0Ab １２\t')).toBe('PO Ab 12');
    expect(normalizePoForSend('Po-1')).toBe('Po-1');
  });
});

describe('assertPoNotAtDh', () => {
  const release = vi.fn();
  beforeEach(() => release.mockClear());

  it('passes on a clear "none" and keeps the reservation', async () => {
    await expect(assertPoNotAtDh('PO-1', 'status_tool', async () => 'none', release)).resolves.toBeUndefined();
    expect(release).not.toHaveBeenCalled();
  });

  it('refuses when the PO exists, releasing the reservation', async () => {
    await expect(assertPoNotAtDh(' PO-1 ', 'status_tool', async () => 'exists', release)).rejects.toThrow(
      "PO number PO-1 already has an order at D&H, so this order was not sent. Check it with status_tool. If it isn't the order the user meant, ask the user for a new PO number.",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown result', async () => 'unknown' as const],
    ['lookup error', async () => { throw new Error('boom'); }],
  ])('fails closed on %s, releasing the reservation', async (_n, lookup) => {
    await expect(assertPoNotAtDh('PO-1', 'status_tool', lookup, release)).rejects.toThrow(
      "Couldn't check D&H for an existing order with PO number PO-1, so this order was not sent. Try again in a moment; if it keeps failing, check status_tool and tell the user.",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('confirm token', () => {
  const order = { body: { po: 'PO-1', lines: [{ itemId: 'A', qty: 2 }, { itemId: 'B', qty: 1 }] } };
  const MISMATCH = "This order doesn't match a preview. Run the order without confirm first, show the preview to the user, then confirm with the confirmToken it returns.";
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DANDH_CONFIRM_SECRET;
  });

  it('accepts a token for the same order and account, regardless of key order', () => {
    const t = makeConfirmToken('acct', order);
    expect(() => checkConfirmToken('acct', order, t)).not.toThrow();
    expect(() => checkConfirmToken('acct', { body: { lines: [{ qty: 2, itemId: 'A' }, { qty: 1, itemId: 'B' }], po: 'PO-1' } }, t)).not.toThrow();
  });

  it.each([
    ['quantity', { body: { po: 'PO-1', lines: [{ itemId: 'A', qty: 3 }, { itemId: 'B', qty: 1 }] } }],
    ['line item', { body: { po: 'PO-1', lines: [{ itemId: 'A', qty: 2 }, { itemId: 'C', qty: 1 }] } }],
    ['extra line', { body: { po: 'PO-1', lines: [{ itemId: 'A', qty: 2 }, { itemId: 'B', qty: 1 }, { itemId: 'A', qty: 1 }] } }],
    ['PO', { body: { po: 'PO-2', lines: [{ itemId: 'A', qty: 2 }, { itemId: 'B', qty: 1 }] } }],
  ])('rejects a token when the %s changed', (_n, altered) => {
    const t = makeConfirmToken('acct', order);
    expect(() => checkConfirmToken('acct', altered, t)).toThrow(MISMATCH);
  });

  it('rejects a token from another account', () => {
    expect(() => checkConfirmToken('other', order, makeConfirmToken('acct', order))).toThrow(MISMATCH);
  });

  it.each([undefined, '', 'nonsense', '123.abc', `${Date.now()}.${'0'.repeat(64)}`])('rejects a missing/malformed token %j', (t) => {
    expect(() => checkConfirmToken('acct', order, t)).toThrow(MISMATCH);
  });

  it('rejects a token whose timestamp was altered', () => {
    const [ts, mac] = makeConfirmToken('acct', order).split('.');
    expect(() => checkConfirmToken('acct', order, `${Number(ts) + 1}.${mac}`)).toThrow(MISMATCH);
  });

  it('expires after 30 minutes', () => {
    vi.useFakeTimers();
    const t = makeConfirmToken('acct', order);
    vi.advanceTimersByTime(CONFIRM_TOKEN_TTL_MS - 1000);
    expect(() => checkConfirmToken('acct', order, t)).not.toThrow();
    vi.advanceTimersByTime(2000);
    expect(() => checkConfirmToken('acct', order, t)).toThrow("This preview has expired. Run the preview again and get the user's OK before confirming.");
  });

  it('an expired token for an altered order is a mismatch, not an expiry', () => {
    vi.useFakeTimers();
    const t = makeConfirmToken('acct', order);
    vi.advanceTimersByTime(CONFIRM_TOKEN_TTL_MS + 1000);
    expect(() => checkConfirmToken('acct', { body: {} }, t)).toThrow(MISMATCH);
  });

  it('DANDH_CONFIRM_SECRET makes tokens verifiable across processes and keys differ otherwise', () => {
    process.env.DANDH_CONFIRM_SECRET = 'shared-secret-1'.padEnd(32, '-');
    const t = makeConfirmToken('acct', order);
    expect(() => checkConfirmToken('acct', order, t)).not.toThrow();
    process.env.DANDH_CONFIRM_SECRET = 'shared-secret-2'.padEnd(32, '-');
    expect(() => checkConfirmToken('acct', order, t)).toThrow(MISMATCH);
    delete process.env.DANDH_CONFIRM_SECRET; // falls back to the per-process key
    expect(() => checkConfirmToken('acct', order, t)).toThrow(MISMATCH);
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
