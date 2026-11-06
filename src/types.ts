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

/**
 * Either service (or both) may be configured. Each is all-or-none; see
 * config.ts. `environment` only affects the REST auth/API hosts.
 */
export interface DandhCredentials {
  rest?: RestCredentials;
  xml?: XmlCredentials;
  environment: Environment;
}
