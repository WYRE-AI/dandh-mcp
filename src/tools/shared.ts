import type { DandhCredentials } from '../types.js';
import { ConfigError } from '../config.js';
import { DandhApiError } from '../rest-client.js';
import { XmlInputError } from '../xml/build.js';
import { redact, secretsOf } from '../utils/redact.js';
import { getCredentials } from '../credentials.js';
import { logger } from '../utils/logger.js';
import type { CallToolResult } from './types.js';

export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Invalid tool arguments. Messages must never contain credential values. */
export class InputError extends Error {}

/** Annotations shared by every read-only tool. */
export const READ_ONLY = { readOnlyHint: true } as const;
/** Annotations for the two order-placing tools. */
export const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

// ---------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function plainString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') throw new InputError(`${key} must be a string.`);
  const t = v.trim();
  if (!t) return undefined;
  if (CONTROL_CHARS.test(t)) throw new InputError(`${key} contains control characters.`);
  return t;
}

export function optString(args: Record<string, unknown>, key: string, max?: number): string | undefined {
  const v = plainString(args, key);
  if (v !== undefined && max !== undefined && v.length > max) {
    throw new InputError(`${key} must be at most ${max} characters (got ${v.length}).`);
  }
  return v;
}

export function reqString(args: Record<string, unknown>, key: string, max?: number): string {
  const v = optString(args, key, max);
  if (v === undefined) throw new InputError(`${key} is required.`);
  return v;
}

export function optInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${key} must be an integer between ${min} and ${max === Number.MAX_SAFE_INTEGER ? 'the supported maximum' : max}.`);
  }
  return n;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new InputError(`${key} must be true or false.`);
  return v;
}

export function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = optString(args, key);
  if (v === undefined) return undefined;
  const hit = allowed.find((a) => a === v);
  if (!hit) throw new InputError(`${key} must be one of: ${allowed.join(', ')} (got "${v}").`);
  return hit;
}

/** Optional array of non-empty strings; each entry max-length checked. */
export function optStringList(
  args: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxLen?: number,
): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new InputError(`${key} must be an array of strings.`);
  if (v.length === 0) return undefined;
  if (v.length > maxItems) {
    throw new InputError(`${key} has ${v.length} entries; the maximum is ${maxItems} per request.`);
  }
  return v.map((entry, i) => {
    const s = plainString({ [`${key}[${i}]`]: entry }, `${key}[${i}]`);
    if (s === undefined) throw new InputError(`${key}[${i}] must be a non-empty string.`);
    if (maxLen !== undefined && s.length > maxLen) {
      throw new InputError(`${key}[${i}] must be at most ${maxLen} characters.`);
    }
    return s;
  });
}

export function optObject(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new InputError(`${key} must be an object.`);
  return v as Record<string, unknown>;
}

/** Rejects argument keys that are not in `allowed`, so typos in write payloads fail loudly. */
export function assertKnownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new InputError(`Unknown field(s) in ${where}: ${unknown.join(', ')}.`);
}

// ---------------------------------------------------------------------
// Service resolution + error handling
// ---------------------------------------------------------------------

export const REST_SET_HINT =
  'REST tools need a Client ID and Secret key from the D&H API Portal plus your 10-digit D&H account number; add them to this D&H connection (env: DANDH_CLIENT_ID, DANDH_CLIENT_SECRET, DANDH_ACCOUNT_NUMBER; gateway headers: X-DandH-Client-Id, X-DandH-Client-Secret, X-DandH-Account-Number)';
export const XML_SET_HINT =
  'XML tools need your dandh.com user code and password; add them to this D&H connection (env: DANDH_XML_USER_CODE, DANDH_XML_PASSWORD; gateway headers: X-DandH-Xml-User-Code, X-DandH-Xml-Password)';

/** The equivalent tool on the other surface, for "service not configured" errors. */
export const REST_TO_XML: Record<string, string> = {
  dandh_get_item: 'dandh_xml_item_inquiry',
  dandh_search_items: 'dandh_xml_item_inquiry (lookupType MFR searches by manufacturer part number only)',
  dandh_get_price: 'dandh_xml_get_price_availability with mode "price" (or dandh_xml_item_inquiry with a quantity for volume pricing)',
  dandh_get_prices_bulk: 'dandh_xml_get_price_availability with mode "price"',
  dandh_get_availability: 'dandh_xml_get_price_availability with mode "availability"',
  dandh_get_availability_bulk: 'dandh_xml_get_price_availability with mode "availability"',
  dandh_get_price_and_availability: 'dandh_xml_get_price_availability with mode "both" (or dandh_xml_item_inquiry)',
  dandh_get_price_and_availability_bulk: 'dandh_xml_get_price_availability with mode "both"',
  dandh_list_carriers: 'no XML equivalent; the valid SHIPCARRIER/SHIPSERVICE values are listed in dandh_xml_create_order',
  dandh_get_order_tracking: 'dandh_xml_get_order_status',
  dandh_list_order_tracking: 'dandh_xml_get_order_status',
  dandh_create_sales_order: 'dandh_xml_create_order',
};

export const XML_TO_REST: Record<string, string> = {
  dandh_xml_get_price_availability:
    'dandh_get_prices_bulk, dandh_get_availability_bulk or dandh_get_price_and_availability_bulk',
  dandh_xml_item_inquiry: 'dandh_get_item or dandh_get_price_and_availability (with a quantity)',
  dandh_xml_get_order_status: 'dandh_list_order_tracking',
  dandh_xml_create_order: 'dandh_create_sales_order',
};

/**
 * Resolves credentials for a service. Returns the creds or a ready-to-return
 * error result naming the missing service and the equivalent tool on the
 * other surface.
 */
export function requireService(
  tool: string,
  service: 'rest' | 'xml',
): { creds: DandhCredentials } | { error: CallToolResult } {
  let creds: DandhCredentials;
  try {
    creds = getCredentials();
  } catch (err) {
    return { error: errorResult((err as Error).message) };
  }
  if (creds[service]) return { creds };

  const other = service === 'rest' ? 'xml' : 'rest';
  const label = service === 'rest' ? 'REST (Customer Order Management API)' : 'XML';
  const hint = service === 'rest' ? REST_SET_HINT : XML_SET_HINT;
  const equivalent = (service === 'rest' ? REST_TO_XML : XML_TO_REST)[tool];
  if (creds[other]) {
    return {
      error: errorResult(
        `The D&H ${label} service is not configured, so ${tool} is unavailable. ${hint}. ` +
          `The ${other.toUpperCase()} service IS configured — use ${equivalent} instead.`,
      ),
    };
  }
  return {
    error: errorResult(
      `No D&H credentials configured for the ${label} service. ${hint}. ` +
        `(Alternatively configure the ${other.toUpperCase()} service and use ${equivalent}.)`,
    ),
  };
}

/** Converts a thrown error to a redacted error result. */
export function toErrorResult(err: unknown, tool: string, creds?: DandhCredentials, extraSecrets: string[] = []): CallToolResult {
  const raw = err instanceof Error ? err.message : String(err);
  const message = redact(raw, secretsOf(creds, extraSecrets));
  if (!(err instanceof InputError || err instanceof XmlInputError || err instanceof ConfigError)) {
    logger.warn('Tool call failed', { tool, kind: err instanceof DandhApiError ? 'api' : 'unexpected', message });
  }
  return errorResult(message);
}
