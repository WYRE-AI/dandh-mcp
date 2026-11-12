/**
 * The 11 D&H Customer Order Management REST endpoints this server exposes,
 * one read tool each, all GET. Paths and parameter names follow the research
 * endpoint list (taken from the community n8n node because D&H's reference is
 * login-walled; UNCONFIRMED against live D&H). Each tool:
 * - validates and percent-encodes every `{name}` path segment;
 * - takes the account number and company only from the credentials;
 * - sends list parameters as repeated keys (`items=A&items=B`, encodeList),
 *   as the n8n reference does by passing an array in `qs` (UNCONFIRMED until
 *   the portal Swagger is checked);
 * - passes pagination (scrollId, pageSize) through and never auto-pages.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CUSTOMER_PREFIX, restGet, type QueryValue } from '../rest-client.js';
import { ArgumentError } from '../types.js';
import { pathSegment } from '../validate.js';
import { exactlyOne, given, int, MAX_STRING, requireRest, str, strList } from './args.js';
import { READ_ONLY, type ToolArgs, type ToolDef } from './types.js';

/** Most items per bulk call, across items + customerItemNumbers (research: "up to 50 items"). */
export const BULK_MAX = 50;
/** Local page-size cap; D&H's maximum is not documented publicly. */
export const PAGE_SIZE_MAX = 100;
const SCROLL_ID_MAX = 4096;

type Param =
  | { type: 'string'; description: string; enum?: readonly string[]; maxLength?: number }
  | { type: 'integer'; description: string; minimum: number; cap?: number }
  | { type: 'array'; description: string; maxItems: number };

interface RestEndpoint {
  name: string;
  description: string;
  /** Relative to /customerOrderManagement/v2/customers/{accountNumber}. */
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, Param>;
  /** Exactly one of these query parameters must be given. */
  exactlyOne?: readonly string[];
  /** Bulk lookup: these array parameters share BULK_MAX and at least one item is required. */
  bulk?: readonly string[];
  /** Equivalent XML tool, named when only XML credentials are configured. */
  xmlEquivalent: string;
}

/** The single place list parameters get their wire format: repeated keys (buildRestUrl appends each value). */
function encodeList(values: string[]): readonly string[] | undefined {
  return values.length ? values : undefined;
}

function schemaFor(p: Param): Record<string, unknown> {
  switch (p.type) {
    case 'string':
      return { type: 'string', description: p.description, ...(p.enum ? { enum: [...p.enum] } : { maxLength: p.maxLength ?? MAX_STRING }) };
    case 'integer':
      // A `cap` is applied silently by the server, so it is described in the text, not advertised as `maximum`
      // (a schema-validating client would otherwise refuse a value the server would accept).
      return { type: 'integer', description: p.description, minimum: p.minimum };
    case 'array':
      return { type: 'array', description: p.description, maxItems: p.maxItems, items: { type: 'string', maxLength: MAX_STRING } };
  }
}

function queryValue(key: string, p: Param, value: unknown): QueryValue | undefined {
  switch (p.type) {
    case 'string':
      return str(value, key, p.maxLength ?? MAX_STRING, p.enum);
    case 'integer':
      return int(value, key, p.minimum, { cap: p.cap });
    case 'array':
      return encodeList(strList(value, key, p.maxItems, MAX_STRING, true));
  }
}

/**
 * Moves the paging fields (`scrollId`, `hasNext`) to the front, so truncating
 * a large page never cuts off the next-page token. An `x-scroll-id` header
 * value is used as `scrollId` when the body has none.
 */
function withPagingFirst(body: unknown, headerScrollId: string | undefined): unknown {
  if (Array.isArray(body)) return headerScrollId ? { scrollId: headerScrollId, elements: body } : body;
  if (!body || typeof body !== 'object') return body;
  const { scrollId = headerScrollId, hasNext, ...rest } = body as Record<string, unknown>;
  return { ...(scrollId !== undefined ? { scrollId } : {}), ...(hasNext !== undefined ? { hasNext } : {}), ...rest };
}

function restTool(spec: RestEndpoint): ToolDef {
  const pathParams = spec.pathParams ?? {};
  const placeholders = [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (placeholders.join() !== Object.keys(pathParams).join()) throw new Error(`${spec.name}: pathParams must match ${spec.path}.`);
  const query = spec.query ?? {};

  const properties: Record<string, object> = {};
  for (const [key, description] of Object.entries(pathParams)) properties[key] = { type: 'string', minLength: 1, maxLength: 256, description };
  for (const [key, p] of Object.entries(query)) properties[key] = schemaFor(p);

  const tool: Tool = {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties, ...(placeholders.length ? { required: placeholders } : {}), additionalProperties: false },
    annotations: READ_ONLY,
  };

  return {
    tier: 'read',
    tool,
    handler: async (args: ToolArgs, creds) => {
      const rest = requireRest(creds, spec.name, spec.xmlEquivalent);
      const path =
        CUSTOMER_PREFIX +
        pathSegment(rest.accountNumber, 'accountNumber') +
        spec.path.replace(/\{(\w+)\}/g, (_m, key: string) => pathSegment(args[key], key));
      if (spec.exactlyOne) exactlyOne(args, spec.exactlyOne);
      if (spec.bulk) {
        const total = spec.bulk.reduce((n, k) => n + (Array.isArray(args[k]) ? (args[k] as unknown[]).length : 0), 0);
        if (total === 0) throw new ArgumentError(`Provide at least one item in ${spec.bulk.join(' and/or ')}.`);
        if (total > BULK_MAX) throw new ArgumentError(`Too many items: ${total} (maximum ${BULK_MAX} per request across ${spec.bulk.join(' + ')}).`);
      }
      const params: Record<string, QueryValue | undefined> = {};
      for (const [key, p] of Object.entries(query)) if (given(args[key])) params[key] = queryValue(key, p, args[key]);
      const res = await restGet(rest, { path, query: params });
      return withPagingFirst(res.body, res.scrollId);
    },
  };
}

// ---- shared parameters ----------------------------------------------------

const ITEM_ID = { itemId: 'D&H item number.' };
const quantity: Param = { type: 'integer', minimum: 1, description: 'Quantity, for volume (tiered) pricing. D&H defaults to 1.' };
const paging: Record<string, Param> = {
  pageSize: { type: 'integer', minimum: 1, cap: PAGE_SIZE_MAX, description: `Results per page (1-${PAGE_SIZE_MAX}; larger values are capped).` },
  scrollId: { type: 'string', maxLength: SCROLL_ID_MAX, description: 'scrollId returned by the previous page; pass it to get the next page. Omit for the first page.' },
};
const list = (what: string): Param => ({ type: 'array', maxItems: BULK_MAX, description: `${what} (max ${BULK_MAX}).` });
const bulkQuery: Record<string, Param> = {
  items: list(`D&H item numbers; together with customerItemNumbers at most ${BULK_MAX}`),
  customerItemNumbers: list('Your own SKUs / customer item numbers'),
};
const BULK_KEYS = ['items', 'customerItemNumbers'] as const;

const SEARCH_KEYS = ['vendorItemId', 'customerItemNumber', 'universalProductCode', 'items', 'vendorItemIds', 'customerItemNumbers'] as const;
const TRACKING_KEYS = ['orderNumber', 'purchaseOrderNumber', 'invoiceNumber'] as const;

/** shipMode values from the researched reference (community n8n node). */
export const SHIP_MODES = ['parcel', 'lessThanTruckload', 'fullTruckload'] as const;

const XML_PA = 'dandh_xml_get_price_availability';

const ENDPOINTS: RestEndpoint[] = [
  {
    name: 'dandh_get_item',
    description: 'Get D&H item detail for one D&H item number (REST).',
    path: '/items/{itemId}',
    pathParams: ITEM_ID,
    xmlEquivalent: 'dandh_xml_item_inquiry',
  },
  {
    name: 'dandh_search_items',
    description:
      `Search D&H items by exactly ONE identifier: vendorItemId (manufacturer part number), customerItemNumber (your SKU), universalProductCode (UPC), or one list (items, vendorItemIds or customerItemNumbers, max ${BULK_MAX}). ` +
      'Returns one page; pass the returned scrollId back to get the next page (REST).',
    path: '/items',
    query: {
      vendorItemId: { type: 'string', description: 'Manufacturer part number.' },
      customerItemNumber: { type: 'string', description: 'Your own SKU.' },
      universalProductCode: { type: 'string', description: 'UPC.' },
      items: list('D&H item numbers'),
      vendorItemIds: list('Manufacturer part numbers'),
      customerItemNumbers: list('Your own SKUs'),
      ...paging,
    },
    exactlyOne: SEARCH_KEYS,
    xmlEquivalent: 'dandh_xml_item_inquiry (lookupType MFR searches by manufacturer part number)',
  },
  {
    name: 'dandh_get_price',
    description: 'Get your customer-specific price for one D&H item, optionally for a quantity (volume pricing) (REST).',
    path: '/items/{itemId}/price',
    pathParams: ITEM_ID,
    query: { quantity },
    xmlEquivalent: `${XML_PA} with mode "price"`,
  },
  {
    name: 'dandh_get_prices_bulk',
    description: `Get prices for up to ${BULK_MAX} items in one call. Provide items and/or customerItemNumbers (REST).`,
    path: '/items/price/bulk',
    query: bulkQuery,
    bulk: BULK_KEYS,
    xmlEquivalent: `${XML_PA} with mode "price"`,
  },
  {
    name: 'dandh_get_availability',
    description: 'Get stock by D&H distribution center (with restock dates when D&H provides them) for one item (REST).',
    path: '/items/{itemId}/availability',
    pathParams: ITEM_ID,
    xmlEquivalent: `${XML_PA} with mode "availability"`,
  },
  {
    name: 'dandh_get_availability_bulk',
    description: `Get availability for up to ${BULK_MAX} items in one call. Provide items and/or customerItemNumbers (REST).`,
    path: '/items/availability/bulk',
    query: bulkQuery,
    bulk: BULK_KEYS,
    xmlEquivalent: `${XML_PA} with mode "availability"`,
  },
  {
    name: 'dandh_get_price_and_availability',
    description: 'Get price (optionally for a quantity) and availability for one item in one call (REST).',
    path: '/items/{itemId}/priceAndAvailability',
    pathParams: ITEM_ID,
    query: { quantity },
    xmlEquivalent: `${XML_PA} with mode "both"`,
  },
  {
    name: 'dandh_get_price_and_availability_bulk',
    description: `Get price and availability for up to ${BULK_MAX} items in one call. Provide items and/or customerItemNumbers (REST).`,
    path: '/items/priceAndAvailability/bulk',
    query: bulkQuery,
    bulk: BULK_KEYS,
    xmlEquivalent: `${XML_PA} with mode "both"`,
  },
  {
    name: 'dandh_list_carriers',
    description: 'List the shipping carriers and service types available to the account, optionally filtered by shipMode. Returns one page with a scrollId for the next (REST).',
    path: '/carriers',
    query: { shipMode: { type: 'string', enum: SHIP_MODES, description: 'Shipping mode filter.' }, ...paging },
    xmlEquivalent: 'no XML equivalent',
  },
  {
    name: 'dandh_get_order_tracking',
    description:
      'Get shipments, packages, tracking and serial numbers for one order tracking id (REST). Whether this id is the D&H order number is unconfirmed: ' +
      'to look up by order number, PO or invoice, prefer dandh_list_order_tracking.',
    path: '/salesOrders/{orderId}/tracking',
    pathParams: { orderId: 'D&H order tracking id (unconfirmed whether this equals the D&H order number).' },
    xmlEquivalent: 'dandh_xml_get_order_status',
  },
  {
    name: 'dandh_list_order_tracking',
    description: 'Find order status and tracking by exactly ONE of orderNumber, purchaseOrderNumber (your PO) or invoiceNumber. Returns one page with a scrollId for the next (REST).',
    path: '/salesOrders/tracking',
    query: {
      orderNumber: { type: 'string', description: 'D&H order number.' },
      purchaseOrderNumber: { type: 'string', description: 'Your PO number.' },
      invoiceNumber: { type: 'string', description: 'D&H invoice number.' },
      ...paging,
    },
    exactlyOne: TRACKING_KEYS,
    xmlEquivalent: 'dandh_xml_get_order_status',
  },
];

export const REST_TOOLS: readonly ToolDef[] = ENDPOINTS.map(restTool);
