import { createHash } from 'node:crypto';
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

export const PO_REGISTRY_MAX = 1000;
export const PO_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

const reserved = new Map<string, number>(); // key -> expiry epoch ms

/** Key is hashed so the account identity never sits in memory as a readable map key or error text. */
function poKey(identity: string, po: string): string {
  return createHash('sha256').update(JSON.stringify([identity, po.trim().toLowerCase()])).digest('hex');
}

function prune(now: number): void {
  for (const [k, exp] of reserved) if (exp <= now) reserved.delete(k);
  while (reserved.size >= PO_REGISTRY_MAX) {
    const oldest = reserved.keys().next().value;
    if (oldest === undefined) break;
    reserved.delete(oldest);
  }
}

export function clearPoRegistry(): void {
  reserved.clear();
}

/**
 * Reserves a PO for this account identity (REST account number or XML user
 * code). Throws OrderLimitError if it was already reserved in the last 24h.
 * Returns a release function: call it only when D&H definitively rejected the
 * request. Never put the identity in the message.
 */
export function reservePo(identity: string, po: string, statusTool: string): () => void {
  const now = Date.now();
  const key = poKey(identity, po);
  const exp = reserved.get(key);
  if (exp !== undefined && exp > now) {
    throw new OrderLimitError(
      `PO number ${po.trim()} was already sent to D&H from this connection in the last 24 hours, so it was not sent again. Check its status with ${statusTool} first. Only if no order shows up, ask the user for a new PO number.`,
    );
  }
  reserved.delete(key);
  prune(now);
  reserved.set(key, now + PO_REGISTRY_TTL_MS);
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
