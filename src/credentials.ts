/**
 * D&H credentials: parsing (env or X-DandH-* headers) and the per-request
 * scope. Gateway mode reads credentials ONLY from the request headers and
 * never falls back to the process environment.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import { isGatewayMode } from './config.js';
import { CredentialError, type DandhCredentials, type RestCompany, type XmlCountry } from './types.js';

type Field = 'clientId' | 'clientSecret' | 'accountNumber' | 'company' | 'xmlUserCode' | 'xmlPassword' | 'xmlCountry';

export const ENV_NAMES: Record<Field, string> = {
  clientId: 'DANDH_CLIENT_ID',
  clientSecret: 'DANDH_CLIENT_SECRET',
  accountNumber: 'DANDH_ACCOUNT_NUMBER',
  company: 'DANDH_COMPANY',
  xmlUserCode: 'DANDH_XML_USER_CODE',
  xmlPassword: 'DANDH_XML_PASSWORD',
  xmlCountry: 'DANDH_XML_COUNTRY',
};

/** The only headers credentials are read from in gateway mode. */
export const HEADER_NAMES: Record<Field, string> = {
  clientId: 'X-DandH-Client-Id',
  clientSecret: 'X-DandH-Client-Secret',
  accountNumber: 'X-DandH-Account-Number',
  company: 'X-DandH-Company',
  xmlUserCode: 'X-DandH-Xml-User-Code',
  xmlPassword: 'X-DandH-Xml-Password',
  xmlCountry: 'X-DandH-Xml-Country',
};

const REST_REQUIRED: Field[] = ['clientId', 'clientSecret', 'accountNumber'];
const XML_REQUIRED: Field[] = ['xmlUserCode', 'xmlPassword'];

const COMPANIES: readonly RestCompany[] = ['us', 'ca', 'dsc'];
const COUNTRIES: readonly XmlCountry[] = ['us', 'ca'];

function clean(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

function oneOf<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (!(allowed as readonly string[]).includes(v)) throw new CredentialError(`Invalid ${name}: must be one of ${allowed.join(', ')}.`);
  return v as T;
}

function incomplete(service: string, missing: Field[], all: Field[], optional: Field, names: Record<Field, string>): CredentialError {
  return new CredentialError(
    `Incomplete D&H ${service} credential set: missing ${missing.map((f) => names[f]).join(', ')}. ` +
      `Provide all of ${all.map((f) => names[f]).join(', ')} (optionally ${names[optional]}), or none of them.`,
  );
}

/**
 * Builds a credential set from a field reader. Each service is all-or-none.
 * `names` supplies the variable/header names used in error messages; values
 * are never echoed.
 */
function build(read: (field: Field) => string | undefined, names: Record<Field, string>): DandhCredentials {
  const get = (f: Field) => clean(read(f));
  const out: DandhCredentials = {};

  if (REST_REQUIRED.some((f) => get(f))) {
    const missing = REST_REQUIRED.filter((f) => !get(f));
    if (missing.length) throw incomplete('REST', missing, REST_REQUIRED, 'company', names);
    const accountNumber = get('accountNumber')!;
    if (!/^\d{10}$/.test(accountNumber)) throw new CredentialError(`${names.accountNumber} must be the 10-digit D&H account number.`);
    out.rest = {
      clientId: get('clientId')!,
      clientSecret: get('clientSecret')!,
      accountNumber,
      company: oneOf(get('company'), COMPANIES, 'us', names.company),
    };
  }

  if (XML_REQUIRED.some((f) => get(f))) {
    const missing = XML_REQUIRED.filter((f) => !get(f));
    if (missing.length) throw incomplete('XML', missing, XML_REQUIRED, 'xmlCountry', names);
    out.xml = {
      userCode: get('xmlUserCode')!,
      password: get('xmlPassword')!,
      country: oneOf(get('xmlCountry'), COUNTRIES, 'us', names.xmlCountry),
    };
  }

  return out;
}

/** Credentials from DANDH_* (stdio and AUTH_MODE=env). May hold neither service. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): DandhCredentials {
  return build((f) => env[ENV_NAMES[f]], ENV_NAMES);
}

/**
 * Credentials from the X-DandH-* request headers (gateway mode). Throws
 * CredentialError on a partial or invalid set, when neither service is
 * present, or when a credential header appears more than once: Node joins
 * repeats into one "a, b" value, so `rawHeaders` (name, value, name, ...)
 * is checked to fail closed instead of combining them.
 */
export function credentialsFromHeaders(headers: IncomingHttpHeaders, rawHeaders: readonly string[] = []): DandhCredentials {
  const sent = rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
  for (const name of Object.values(HEADER_NAMES)) {
    if (sent.filter((s) => s === name.toLowerCase()).length > 1) throw new CredentialError(`${name} was sent more than once.`);
  }
  const creds = build((f) => {
    const value = headers[HEADER_NAMES[f].toLowerCase()];
    return Array.isArray(value) ? undefined : value;
  }, HEADER_NAMES);
  if (!creds.rest && !creds.xml) {
    throw new CredentialError(
      'missing required gateway credential headers: send the REST set ' +
        `(${REST_REQUIRED.map((f) => HEADER_NAMES[f]).join(', ')}) and/or the XML set (${XML_REQUIRED.map((f) => HEADER_NAMES[f]).join(', ')}).`,
    );
  }
  return creds;
}

const credentialStore = new AsyncLocalStorage<DandhCredentials>();

/** Runs fn with per-request credentials (gateway mode: from the X-DandH-* headers). */
export function runWithCredentials<T>(creds: DandhCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

/** The secret values in scope for this request, if any. Used by the logger to redact them exactly. */
export function scopedSecrets(): string[] {
  const creds = credentialStore.getStore();
  return [creds?.rest?.clientSecret, creds?.xml?.password].filter((s): s is string => !!s);
}

/** Per-request credentials if in scope; otherwise DANDH_*, except in gateway mode, which never reads env. */
export function resolveCredentials(): DandhCredentials {
  const scoped = credentialStore.getStore();
  if (scoped) return scoped;
  if (isGatewayMode()) {
    throw new CredentialError('No D&H credentials on this request. Gateway mode requires the X-DandH-* headers.');
  }
  return credentialsFromEnv();
}
