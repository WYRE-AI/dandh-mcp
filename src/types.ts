/** Which fixed pair of D&H REST hosts to use. A deployment setting (DANDH_ENVIRONMENT), never caller-supplied. */
export type Environment = 'production' | 'test';

/** User-facing company selector; mapped to the `dandh-tenant` header value. */
export type RestCompany = 'us' | 'ca' | 'dsc';
export type Tenant = 'dhus' | 'dhca' | 'dsc';

export const TENANT_BY_COMPANY: Record<RestCompany, Tenant> = {
  us: 'dhus',
  ca: 'dhca',
  dsc: 'dsc',
};

export type XmlCountry = 'us' | 'ca';

/** OAuth2 client-credentials set for the Customer Order Management REST API. */
export interface RestCredentials {
  clientId: string;
  clientSecret: string;
  /** 10-digit D&H account number used in REST paths. */
  accountNumber: string;
  company: RestCompany;
}

/** dandh.com / dandh.ca UserCode + Password for the XML integration. */
export interface XmlCredentials {
  userCode: string;
  password: string;
  country: XmlCountry;
}

/** Either service (or both) may be configured. Each set is all-or-none; see credentials.ts. */
export interface DandhCredentials {
  rest?: RestCredentials;
  xml?: XmlCredentials;
}

/** Caller-supplied arguments failed validation. Never reaches D&H. */
export class ArgumentError extends Error {}

/** Missing, partial, or invalid D&H credentials. Messages name variables/headers, never values. */
export class CredentialError extends Error {}

/** Any non-2xx, redirect, oversized, malformed, or unreachable D&H response. Messages are already redacted. */
export class DandhApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
