/** Argument validation shared by the REST and XML tools. Error messages name the argument, never echo a credential. */
import { ArgumentError, CredentialError, type DandhCredentials, type RestCredentials, type XmlCredentials } from '../types.js';
import type { ToolArgs } from './types.js';

export const MAX_STRING = 256;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function given(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
}

/** A trimmed, non-empty string without control characters, optionally restricted to `allowed`. */
export function str(value: unknown, key: string, maxLength = MAX_STRING, allowed?: readonly string[]): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ArgumentError(`"${key}" must be a non-empty string.`);
  const s = value.trim();
  if (CONTROL_CHARS.test(s)) throw new ArgumentError(`"${key}" contains control characters.`);
  if (s.length > maxLength) throw new ArgumentError(`"${key}" is too long (max ${maxLength} characters).`);
  if (allowed && !allowed.includes(s)) throw new ArgumentError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  return s;
}

/** An integer >= minimum. Above `maximum` it is rejected; above `cap` it is silently capped (vendor page limits). */
export function int(value: unknown, key: string, minimum: number, bounds: { maximum?: number; cap?: number } = {}): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ArgumentError(`"${key}" must be an integer.`);
  if (n < minimum) throw new ArgumentError(`"${key}" must be at least ${minimum}.`);
  if (bounds.maximum !== undefined && n > bounds.maximum) throw new ArgumentError(`"${key}" must be at most ${bounds.maximum}.`);
  return bounds.cap !== undefined ? Math.min(n, bounds.cap) : n;
}

/** An array of strings (each validated like `str`). `noComma` rejects entries that would split a comma-joined list. */
export function strList(value: unknown, key: string, maxItems: number, maxLength = MAX_STRING, noComma = false): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ArgumentError(`"${key}" must be an array of strings.`);
  if (value.length > maxItems) throw new ArgumentError(`"${key}" has ${value.length} entries; the maximum is ${maxItems} per request.`);
  return value.map((entry, i) => {
    const s = str(entry, `${key}[${i}]`, maxLength);
    if (noComma && s.includes(',')) throw new ArgumentError(`"${key}[${i}]" must not contain a comma.`);
    return s;
  });
}

export function exactlyOne(args: ToolArgs, keys: readonly string[]): void {
  const present = keys.filter((k) => given(args[k]));
  if (present.length !== 1) {
    throw new ArgumentError(`Provide exactly one of ${keys.join(', ')} (got ${present.length === 0 ? 'none' : present.join(' + ')}).`);
  }
}

// ---- service resolution ---------------------------------------------------

const REST_HINT =
  'REST tools need a Client ID and Secret from the D&H API Portal plus your 10-digit D&H account number (gateway headers X-DandH-Client-Id, X-DandH-Client-Secret, X-DandH-Account-Number; env DANDH_CLIENT_ID, DANDH_CLIENT_SECRET, DANDH_ACCOUNT_NUMBER)';
const XML_HINT =
  'XML tools need your dandh.com user code and password (gateway headers X-DandH-Xml-User-Code, X-DandH-Xml-Password; env DANDH_XML_USER_CODE, DANDH_XML_PASSWORD)';

function missing(service: 'REST' | 'XML', tool: string, otherConfigured: boolean, equivalent: string): CredentialError {
  const label = service === 'REST' ? 'REST (Customer Order Management API)' : 'XML';
  const hint = service === 'REST' ? REST_HINT : XML_HINT;
  const other = service === 'REST' ? 'XML' : 'REST';
  return new CredentialError(
    otherConfigured
      ? `The D&H ${label} service is not configured, so ${tool} is unavailable. ${hint}. The ${other} service IS configured: use ${equivalent} instead.`
      : `No D&H credentials are configured for the ${label} service. ${hint}.`,
  );
}

export function requireRest(creds: DandhCredentials, tool: string, xmlEquivalent: string): RestCredentials {
  if (creds.rest) return creds.rest;
  throw missing('REST', tool, !!creds.xml, xmlEquivalent);
}

export function requireXml(creds: DandhCredentials, tool: string, restEquivalent: string): XmlCredentials {
  if (creds.xml) return creds.xml;
  throw missing('XML', tool, !!creds.rest, restEquivalent);
}
