import type { IncomingHttpHeaders } from 'node:http';
import type {
  DandhCredentials,
  Environment,
  RestCompany,
  RestCredentials,
  XmlCountry,
  XmlCredentials,
} from './types.js';

/** Thrown for missing/partial/invalid credential configuration. Messages name variables, never values. */
export class ConfigError extends Error {}

type Field =
  | 'clientId'
  | 'clientSecret'
  | 'accountNumber'
  | 'company'
  | 'xmlUserCode'
  | 'xmlPassword'
  | 'xmlCountry'
  | 'environment';

export const ENV_NAMES: Record<Field, string> = {
  clientId: 'DANDH_CLIENT_ID',
  clientSecret: 'DANDH_CLIENT_SECRET',
  accountNumber: 'DANDH_ACCOUNT_NUMBER',
  company: 'DANDH_COMPANY',
  xmlUserCode: 'DANDH_XML_USER_CODE',
  xmlPassword: 'DANDH_XML_PASSWORD',
  xmlCountry: 'DANDH_XML_COUNTRY',
  environment: 'DANDH_ENVIRONMENT',
};

export const HEADER_NAMES: Record<Field, string> = {
  clientId: 'X-DandH-Client-Id',
  clientSecret: 'X-DandH-Client-Secret',
  accountNumber: 'X-DandH-Account-Number',
  company: 'X-DandH-Company',
  xmlUserCode: 'X-DandH-Xml-User-Code',
  xmlPassword: 'X-DandH-Xml-Password',
  xmlCountry: 'X-DandH-Xml-Country',
  environment: 'X-DandH-Environment',
};

const REST_REQUIRED: Field[] = ['clientId', 'clientSecret', 'accountNumber'];
const XML_REQUIRED: Field[] = ['xmlUserCode', 'xmlPassword'];

const ACCOUNT_NUMBER_RE = /^\d{10}$/;

export function isValidAccountNumber(value: string): boolean {
  return ACCOUNT_NUMBER_RE.test(value);
}

export function parseCompany(value: string, label = 'company'): RestCompany {
  const v = value.trim().toLowerCase();
  if (v === 'us' || v === 'ca' || v === 'dsc') return v;
  throw new ConfigError(`Invalid ${label} "${value}": must be one of us, ca, dsc.`);
}

function clean(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/**
 * Builds a credential set from a field reader. `names` supplies the
 * variable/header names used in error messages so the same rules apply to
 * the env (stdio / AUTH_MODE=env) and header (gateway) sources.
 */
function build(
  read: (field: Field) => string | undefined,
  names: Record<Field, string>,
  defaultEnvironment: string | undefined,
): DandhCredentials {
  const get = (f: Field) => clean(read(f));

  const envRaw = get('environment') ?? clean(defaultEnvironment) ?? 'production';
  const envLower = envRaw.toLowerCase();
  if (envLower !== 'production' && envLower !== 'test') {
    throw new ConfigError(`Invalid ${names.environment}: must be "production" or "test".`);
  }
  const environment: Environment = envLower;

  const out: DandhCredentials = { environment };

  const restPresent = REST_REQUIRED.filter((f) => get(f));
  if (restPresent.length > 0) {
    const missing = REST_REQUIRED.filter((f) => !get(f));
    if (missing.length > 0) {
      throw new ConfigError(
        `Incomplete D&H REST credential set: missing ${missing.map((f) => names[f]).join(', ')}. ` +
          `Provide all of ${REST_REQUIRED.map((f) => names[f]).join(', ')} (optionally ${names.company}), or none of them.`,
      );
    }
    const accountNumber = get('accountNumber')!;
    if (!isValidAccountNumber(accountNumber)) {
      throw new ConfigError(`${names.accountNumber} must be the 10-digit D&H account number.`);
    }
    const company = get('company');
    const rest: RestCredentials = {
      clientId: get('clientId')!,
      clientSecret: get('clientSecret')!,
      accountNumber,
      company: company ? parseCompany(company, names.company) : 'us',
    };
    out.rest = rest;
  }

  const xmlPresent = XML_REQUIRED.filter((f) => get(f));
  if (xmlPresent.length > 0) {
    const missing = XML_REQUIRED.filter((f) => !get(f));
    if (missing.length > 0) {
      throw new ConfigError(
        `Incomplete D&H XML credential set: missing ${missing.map((f) => names[f]).join(', ')}. ` +
          `Provide all of ${XML_REQUIRED.map((f) => names[f]).join(', ')} (optionally ${names.xmlCountry}), or none of them.`,
      );
    }
    const countryRaw = (get('xmlCountry') ?? 'us').toLowerCase();
    if (countryRaw !== 'us' && countryRaw !== 'ca') {
      throw new ConfigError(`Invalid ${names.xmlCountry}: must be "us" or "ca".`);
    }
    const xml: XmlCredentials = {
      userCode: get('xmlUserCode')!,
      password: get('xmlPassword')!,
      country: countryRaw as XmlCountry,
    };
    out.xml = xml;
  }

  return out;
}

/** Credentials from process.env (stdio and AUTH_MODE=env). */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): DandhCredentials {
  return build((f) => env[ENV_NAMES[f]], ENV_NAMES, undefined);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? clean(raw) : undefined;
}

const CREDENTIAL_FIELDS: Field[] = [...REST_REQUIRED, ...XML_REQUIRED];

/** True when the request carries any D&H credential header (company/country/environment alone don't count). */
export function hasCredentialHeaders(headers: IncomingHttpHeaders): boolean {
  return CREDENTIAL_FIELDS.some((f) => headerValue(headers[HEADER_NAMES[f].toLowerCase()]));
}

/**
 * Credentials from X-DandH-* request headers. Throws ConfigError on a partial
 * set, an invalid value, or (when `requireAny`) when neither service is
 * configured. The environment falls back to process.env.DANDH_ENVIRONMENT, a
 * non-secret deployment setting.
 */
export function credentialsFromHeaders(
  headers: IncomingHttpHeaders,
  opts: { requireAny: boolean },
): DandhCredentials {
  const creds = build(
    (f) => headerValue(headers[HEADER_NAMES[f].toLowerCase()]),
    HEADER_NAMES,
    process.env[ENV_NAMES.environment],
  );
  if (opts.requireAny && !creds.rest && !creds.xml) {
    throw new ConfigError(
      'missing required gateway credential headers: send the REST set ' +
        `(${REST_REQUIRED.map((f) => HEADER_NAMES[f].toLowerCase()).join(', ')}) and/or the XML set ` +
        `(${XML_REQUIRED.map((f) => HEADER_NAMES[f].toLowerCase()).join(', ')})`,
    );
  }
  return creds;
}

const DANDH_HOST_RE = /^(?:[a-z0-9-]+\.)*dandh\.(?:com|ca)$/;

/**
 * Validates the DANDH_XML_URL override: https only, a D&H host (dandh.com,
 * dandh.ca or a subdomain), no credentials in the URL and no custom port.
 * Returns undefined when unset. The XML login is sent in the request body, so
 * an arbitrary host here would receive the D&H password.
 */
export function parseXmlUrlOverride(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const bad = (why: string): never => {
    throw new ConfigError(`Invalid DANDH_XML_URL: ${why}`);
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad('not a valid URL.');
  }
  if (url.protocol !== 'https:') bad('must be an https:// URL.');
  if (url.username || url.password) bad('must not contain a username or password.');
  if (url.port) bad('must not set a port.');
  if (!DANDH_HOST_RE.test(url.hostname.toLowerCase())) bad('host must be dandh.com, dandh.ca or a subdomain of either.');
  return url.href;
}
