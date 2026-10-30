import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from './config.js';

/** Order caps. Configured by env, validated at startup (see loadOrderLimits). */
export interface OrderLimits {
  maxLines: number;
  maxLineQuantity: number;
  /** In the account currency. */
  maxOrderValue: number;
  maxUnitPrice: number;
}

export const ORDER_LIMIT_ENV = {
  maxLines: 'DANDH_MAX_ORDER_LINES',
  maxLineQuantity: 'DANDH_MAX_LINE_QUANTITY',
  maxOrderValue: 'DANDH_MAX_ORDER_VALUE',
  maxUnitPrice: 'DANDH_MAX_UNIT_PRICE',
} as const;

export const DEFAULT_ORDER_LIMITS: OrderLimits = {
  maxLines: 25,
  maxLineQuantity: 100,
  maxOrderValue: 5000,
  maxUnitPrice: 25000,
};

function positiveNumber(raw: string | undefined, name: string, fallback: number, integer: boolean): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new ConfigError(`Invalid ${name}: must be a positive ${integer ? 'whole number' : 'number'}.`);
  }
  return n;
}

/** Reads and validates the order caps. Throws ConfigError on a non-positive or non-numeric value. */
export function loadOrderLimits(env: NodeJS.ProcessEnv = process.env): OrderLimits {
  const d = DEFAULT_ORDER_LIMITS;
  const e = ORDER_LIMIT_ENV;
  return {
    maxLines: positiveNumber(env[e.maxLines], e.maxLines, d.maxLines, true),
    maxLineQuantity: positiveNumber(env[e.maxLineQuantity], e.maxLineQuantity, d.maxLineQuantity, true),
    maxOrderValue: positiveNumber(env[e.maxOrderValue], e.maxOrderValue, d.maxOrderValue, false),
    maxUnitPrice: positiveNumber(env[e.maxUnitPrice], e.maxUnitPrice, d.maxUnitPrice, false),
  };
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatMoney = money;

/**
 * Throws when a caller-supplied unit price is not a sane price (finite, > 0, at most 2 decimals).
 * It is only sent along to D&H; it never counts toward the order-value or unit-price caps.
 */
export function checkUnitPrice(value: unknown, label: string): number {
  const fail = (why: string): never => {
    throw new OrderLimitError(`${label} ${why}`);
  };
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be a number.');
  if (value <= 0) return fail('must be greater than 0.');
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) return fail('must have at most 2 decimal places.');
  return value;
}

/** Throws when the price D&H returned for a line is over the unit-price cap. */
export function checkDhUnitPrice(price: number, label: string, limits: OrderLimits): void {
  if (price > limits.maxUnitPrice) {
    throw new OrderLimitError(
      `D&H's price for ${label} (${money(price)}) is over the ${money(limits.maxUnitPrice)} unit-price limit, so the order was not placed. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise ${ORDER_LIMIT_ENV.maxUnitPrice}.`,
    );
  }
}

/** A limit was exceeded or a price/PO safety check failed. Message tells the agent what to do next. */
export class OrderLimitError extends Error {}

export function checkLineCount(count: number, limits: OrderLimits): void {
  if (count > limits.maxLines) {
    throw new OrderLimitError(
      `This order has ${count} lines; the limit is ${limits.maxLines}. Split it into separate orders, each approved by the user, or ask whoever runs this D&H connector to raise ${ORDER_LIMIT_ENV.maxLines}.`,
    );
  }
}

export function checkLineQuantity(qty: number, label: string, limits: OrderLimits): void {
  if (qty > limits.maxLineQuantity) {
    throw new OrderLimitError(
      `${label} is ${qty}; the per-line limit is ${limits.maxLineQuantity}. Lower it, split it into separate orders, each approved by the user, or ask whoever runs this D&H connector to raise ${ORDER_LIMIT_ENV.maxLineQuantity}.`,
    );
  }
}

export interface PricedLine {
  quantity: number;
  /** D&H's returned price. Undefined when D&H gave none; caller prices never go here. */
  unitPrice?: number;
}

/** Sum of qty * D&H unit price, or null when D&H gave no price for any line. Rounded to cents. */
export function orderTotal(lines: PricedLine[]): number | null {
  let cents = 0;
  for (const l of lines) {
    if (l.unitPrice === undefined) return null;
    cents += Math.round(l.quantity * l.unitPrice * 100);
  }
  return cents / 100;
}

export function checkOrderValue(total: number, limits: OrderLimits): void {
  if (total > limits.maxOrderValue) {
    throw new OrderLimitError(
      `This order's estimated total (${money(total)}) is over the ${money(limits.maxOrderValue)} limit, so it was not placed. Don't split it to get under the limit. Tell the user. They can place it on dandh.com, or ask whoever runs this D&H connector to raise ${ORDER_LIMIT_ENV.maxOrderValue}.`,
    );
  }
}

/** Caps that apply, for the preview. */
export function describeLimits(limits: OrderLimits): Record<string, string | number> {
  return {
    [ORDER_LIMIT_ENV.maxLines]: limits.maxLines,
    [ORDER_LIMIT_ENV.maxLineQuantity]: limits.maxLineQuantity,
    [ORDER_LIMIT_ENV.maxOrderValue]: limits.maxOrderValue,
    [ORDER_LIMIT_ENV.maxUnitPrice]: limits.maxUnitPrice,
  };
}

// ---------------------------------------------------------------------
// In-process PO dedupe
// ---------------------------------------------------------------------

/** Global memory ceiling. When full, the oldest entry is evicted (see reservePo). */
export const PO_REGISTRY_MAX = 5000;
/** Orders one account identity may place per 24 hours through this connector. */
export const PO_REGISTRY_PER_IDENTITY_MAX = 200;
export const PO_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

interface PoEntry {
  expires: number; // epoch ms
  identityHash: string;
}

// Insertion order = reservation order, so the first key is the oldest entry.
const reserved = new Map<string, PoEntry>();

function identityHashOf(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}

/**
 * The PO as it is sent to D&H and compared locally: NFKC-normalized (fullwidth digits, NBSP and
 * similar fold to plain characters), trimmed, inner whitespace runs collapsed to one space.
 * Case is kept: lowercasing could change what the PO means to the customer.
 */
export function normalizePoForSend(po: string): string {
  return po.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/**
 * Key is hashed so the account identity never sits in memory as a readable map key or error text.
 * Local dedupe is case-insensitive on top of normalizePoForSend.
 */
function poKey(identityHash: string, po: string): string {
  const norm = normalizePoForSend(po).toLowerCase();
  return createHash('sha256').update(JSON.stringify([identityHash, norm])).digest('hex');
}

function prune(now: number): void {
  for (const [k, e] of reserved) if (e.expires <= now) reserved.delete(k);
}

export function clearPoRegistry(): void {
  reserved.clear();
}

/**
 * Reserves a PO for this account identity (REST account number or XML user
 * code). Throws OrderLimitError if it was already reserved in the last 24h, or if the
 * identity already has PO_REGISTRY_PER_IDENTITY_MAX live reservations.
 * Returns a release function: call it only when D&H definitively rejected the
 * request or the request was never sent. Never put the identity in the message.
 *
 * The D&H PO lookup before a confirmed order (assertPoNotAtDh) is the main dedupe; this
 * in-process registry is a backstop for when that lookup is wrong or racing. So the
 * global ceiling evicts the oldest entry instead of refusing: one busy account must not
 * block others, and the per-identity quota is what bounds any single account.
 */
export function reservePo(identity: string, po: string, statusTool: string): () => void {
  const now = Date.now();
  const identityHash = identityHashOf(identity);
  const key = poKey(identityHash, po);
  const existing = reserved.get(key);
  if (existing !== undefined && existing.expires > now) {
    throw new OrderLimitError(
      `PO number ${normalizePoForSend(po)} was already sent to D&H from this connection in the last 24 hours, so it was not sent again. Check its status with ${statusTool} first. Only if no order shows up, ask the user for a new PO number.`,
    );
  }
  reserved.delete(key);
  prune(now);
  let mine = 0;
  for (const e of reserved.values()) if (e.identityHash === identityHash) mine++;
  if (mine >= PO_REGISTRY_PER_IDENTITY_MAX) {
    throw new OrderLimitError(
      `This connection has reached its limit of ${PO_REGISTRY_PER_IDENTITY_MAX} orders in 24 hours, so this order was not sent. Tell the user; they can place it on dandh.com, or wait and try later.`,
    );
  }
  while (reserved.size >= PO_REGISTRY_MAX) {
    const oldest = reserved.keys().next().value;
    if (oldest === undefined) break;
    reserved.delete(oldest);
  }
  reserved.set(key, { expires: now + PO_REGISTRY_TTL_MS, identityHash });
  return () => {
    reserved.delete(key);
  };
}

export function poRegistrySize(): number {
  return reserved.size;
}

/** Refusal for a confirmed order when D&H returned no price for some line. */
export function unpricedRefusal(priceTool: string): string {
  return `Cannot place this order: D&H didn't return a price for one or more lines, so the total can't be checked against the limit. Check the items with ${priceTool}. If D&H still can't price a line, don't place it here; tell the user to place it on dandh.com.`;
}

// ---------------------------------------------------------------------
// Pre-confirm PO lookup at D&H
// ---------------------------------------------------------------------

/** exists: D&H shows an order for the PO. none: a clear "no orders". unknown: error or unreadable response. */
export type PoLookupResult = 'exists' | 'none' | 'unknown';

/**
 * Looks the PO up at D&H before a confirmed order is sent. Fails closed: anything
 * other than a clear "none" refuses the order. Releases the local reservation
 * (nothing was sent) before throwing.
 */
export async function assertPoNotAtDh(
  po: string,
  statusTool: string,
  lookup: () => Promise<PoLookupResult>,
  release: () => void,
): Promise<void> {
  let result: PoLookupResult;
  let lookupError: Error | undefined;
  try {
    result = await lookup();
  } catch (err) {
    result = 'unknown';
    lookupError = err instanceof Error ? err : new Error(String(err));
  }
  if (result === 'none') return;
  release();
  const p = normalizePoForSend(po);
  throw new OrderLimitError(
    result === 'exists'
      ? `PO number ${p} already has an order at D&H, so this order was not sent. Check it with ${statusTool}. If it isn't the order the user meant, ask the user for a new PO number.`
      : `Couldn't check D&H for an existing order with PO number ${p}, so this order was not sent. Try again in a moment; if it keeps failing, check ${statusTool} and tell the user.${lookupError ? ` (D&H lookup error: ${lookupError.message})` : ''}`,
    lookupError ? { cause: lookupError } : undefined,
  );
}

// ---------------------------------------------------------------------
// Preview -> confirm binding
// ---------------------------------------------------------------------

export const CONFIRM_TOKEN_TTL_MS = 30 * 60 * 1000;
export const CONFIRM_SECRET_ENV = 'DANDH_CONFIRM_SECRET';

/** Per-process random key, used when DANDH_CONFIRM_SECRET is not set. */
const processConfirmKey = randomBytes(32);

export const CONFIRM_SECRET_MIN_BYTES = 32;

/**
 * Reads DANDH_CONFIRM_SECRET. Undefined when unset/blank; throws ConfigError (never echoing the
 * value) when it is shorter than CONFIRM_SECRET_MIN_BYTES UTF-8 bytes.
 */
export function loadConfirmSecret(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const raw = env[CONFIRM_SECRET_ENV]?.trim();
  if (!raw) return undefined;
  if (Buffer.byteLength(raw, 'utf8') < CONFIRM_SECRET_MIN_BYTES) {
    throw new ConfigError(`Invalid ${CONFIRM_SECRET_ENV}: must be at least ${CONFIRM_SECRET_MIN_BYTES} bytes long. Use a random value, e.g. from \`openssl rand -hex 32\`.`);
  }
  return Buffer.from(raw, 'utf8');
}

function confirmKey(): Buffer {
  return loadConfirmSecret() ?? processConfirmKey;
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x ?? null)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function confirmMac(issuedAt: string, identity: string, order: unknown): Buffer {
  const identityHash = createHash('sha256').update(identity).digest('hex');
  return createHmac('sha256', confirmKey())
    .update(`${issuedAt}.${canonicalJson({ account: identityHash, order })}`)
    .digest();
}

/**
 * Token for the preview: `<issuedAt ms>.<HMAC-SHA256 hex>` over the normalized
 * order (as built after validation, without confirm/confirmToken) and a hash of
 * the account identity.
 */
export function makeConfirmToken(identity: string, order: unknown): string {
  const issuedAt = String(Date.now());
  return `${issuedAt}.${confirmMac(issuedAt, identity, order).toString('hex')}`;
}

/** Throws OrderLimitError unless `token` was issued for exactly this order and account, within 30 minutes. */
export function checkConfirmToken(identity: string, order: unknown, token: string | undefined): void {
  const mismatch = () =>
    new OrderLimitError(
      "This order doesn't match a preview. Run the order without confirm first, show the preview to the user, then confirm with the confirmToken it returns.",
    );
  const m = typeof token === 'string' ? /^(\d{1,15})\.([0-9a-f]{64})$/.exec(token) : null;
  if (!m) throw mismatch();
  const given = Buffer.from(m[2], 'hex');
  const expected = confirmMac(m[1], identity, order);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw mismatch();
  if (Date.now() - Number(m[1]) > CONFIRM_TOKEN_TTL_MS) {
    throw new OrderLimitError('This preview has expired. Run the preview again and get the user\'s OK before confirming.');
  }
}
