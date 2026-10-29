import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { isValidAccountNumber, parseCompany } from '../config.js';
import { restRequest, type QueryValue } from '../rest-client.js';
import type { RestCredentials } from '../types.js';
import type { CallToolResult } from './types.js';
import {
  InputError,
  READ_ONLY,
  WRITE,
  assertKnownKeys,
  optBool,
  optInt,
  optObject,
  optString,
  optStringList,
  reqString,
  requireService,
  textResult,
  toErrorResult,
} from './shared.js';

export const BULK_MAX = 50;
const PAGE_SIZE_MAX = 100; // local safety cap, not a documented D&H limit

/** REST warehouse codes (StackJack parity list). */
export const REST_BRANCHES = {
  BR01: 'Mid-Atlantic',
  BR03: 'Toronto',
  BR04: 'West Coast',
  BR05: 'Midwest',
  BR06: 'Atlanta',
  BR08: 'Vancouver',
} as const;

const OVERRIDES = {
  accountNumber: {
    type: 'string',
    description: 'Optional 10-digit D&H account number overriding the configured one for this call.',
  },
  company: {
    type: 'string',
    enum: ['us', 'ca', 'dsc'],
    description: 'Optional company override (us = D&H US, ca = D&H Canada, dsc = DSC) for this call.',
  },
} as const;

const itemId = { type: 'string', description: 'D&H item number (itemId).' } as const;
const bulkProps = {
  items: { type: 'array', items: { type: 'string' }, maxItems: BULK_MAX, description: `D&H item numbers (max ${BULK_MAX} across items + customerItemNumbers).` },
  customerItemNumbers: { type: 'array', items: { type: 'string' }, maxItems: BULK_MAX, description: 'Your own SKUs / customer item numbers.' },
} as const;
const quantity = { type: 'number', description: 'Quantity, for volume (tiered) pricing. Default 1.' } as const;
const paging = {
  pageSize: { type: 'number', description: `Page size (1-${PAGE_SIZE_MAX}).` },
  scrollId: { type: 'string', description: 'scrollId returned by the previous page, to fetch the next page.' },
} as const;

const WARNING =
  'WARNING: THIS PLACES A REAL, BILLABLE PURCHASE ORDER WITH D&H. Orders CANNOT be cancelled via the API. ' +
  'The PO number must be unique. Any special instructions place the order on HOLD for manual review by D&H. ' +
  'Before calling, confirm current price and stock (dandh_get_price_and_availability) and get EXPLICIT user confirmation of every line, quantity, branch and shipping choice. ';

export const REST_TOOLS: Tool[] = [
  {
    name: 'dandh_get_item',
    description: 'Get D&H item detail for one D&H item number (REST).',
    inputSchema: { type: 'object', properties: { itemId, ...OVERRIDES }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_search_items',
    description:
      'Search D&H items by exactly ONE identifier: vendorItemId (manufacturer part number), customerItemNumber (your SKU), universalProductCode (UPC), or a list via items / vendorItemIds / customerItemNumbers (max 50). Paginated: pass the returned scrollId back to get the next page (REST).',
    inputSchema: {
      type: 'object',
      properties: {
        vendorItemId: { type: 'string', description: 'Manufacturer part number.' },
        customerItemNumber: { type: 'string', description: 'Your own SKU.' },
        universalProductCode: { type: 'string', description: 'UPC.' },
        items: { type: 'array', items: { type: 'string' }, description: 'D&H item numbers (max 50).' },
        vendorItemIds: { type: 'array', items: { type: 'string' }, description: 'Manufacturer part numbers (max 50).' },
        customerItemNumbers: { type: 'array', items: { type: 'string' }, description: 'Your SKUs (max 50).' },
        ...paging,
        ...OVERRIDES,
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_price',
    description: 'Get customer-specific price for one D&H item, with optional quantity for volume pricing (REST).',
    inputSchema: { type: 'object', properties: { itemId, quantity, ...OVERRIDES }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_prices_bulk',
    description: `Get prices for up to ${BULK_MAX} items in one call (REST). Provide items and/or customerItemNumbers.`,
    inputSchema: { type: 'object', properties: { ...bulkProps, ...OVERRIDES } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_availability',
    description: 'Get real-time availability by distribution center (with restock ETAs when D&H provides them) for one item (REST).',
    inputSchema: { type: 'object', properties: { itemId, ...OVERRIDES }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_availability_bulk',
    description: `Get availability for up to ${BULK_MAX} items in one call (REST). Provide items and/or customerItemNumbers.`,
    inputSchema: { type: 'object', properties: { ...bulkProps, ...OVERRIDES } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_price_and_availability',
    description: 'Get price (optionally for a quantity) and availability for one item in one call (REST). Use before placing an order.',
    inputSchema: { type: 'object', properties: { itemId, quantity, ...OVERRIDES }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_price_and_availability_bulk',
    description: `Get price and availability for up to ${BULK_MAX} items in one call (REST). Provide items and/or customerItemNumbers.`,
    inputSchema: { type: 'object', properties: { ...bulkProps, ...OVERRIDES } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_list_carriers',
    description: 'List shipping carriers / service types available to the account, optionally filtered by shipMode. Use these values in dandh_create_sales_order (REST).',
    inputSchema: { type: 'object', properties: { shipMode: { type: 'string' }, ...paging, ...OVERRIDES } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_order_tracking',
    description: 'Get status and tracking for one sales order by its D&H sales order id: backorders, invoice breakdown, packages, tracking and serial numbers (REST).',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'D&H sales order id.' }, ...OVERRIDES },
      required: ['orderId'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_list_order_tracking',
    description: 'Find order status/tracking by exactly ONE of orderNumber, purchaseOrderNumber (your PO) or invoiceNumber. Paginated via scrollId (REST).',
    inputSchema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string', description: 'D&H order number.' },
        purchaseOrderNumber: { type: 'string', description: 'Your PO number.' },
        invoiceNumber: { type: 'string', description: 'D&H invoice number.' },
        ...paging,
        ...OVERRIDES,
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_create_sales_order',
    description:
      WARNING +
      'Submits a sales order via the REST API. allowPartialShipment and allowBackOrder default to true on D&H\'s side. Valid branch codes: ' +
      Object.entries(REST_BRANCHES).map(([k, v]) => `${k} ${v}`).join(', ') +
      '. Use dandh_list_carriers for carrier/serviceType values.',
    inputSchema: {
      type: 'object',
      properties: {
        customerPurchaseOrder: { type: 'string', description: 'Your PO number. MUST be unique.' },
        specialInstructions: { type: 'string', description: 'Order notes. ANY value places the order on HOLD for manual review.' },
        freightBillingAccount: { type: 'string', description: 'Freight account to bill shipping to.' },
        shipping: {
          type: 'object',
          description: 'Shipping choices; omit to use the account defaults.',
          properties: {
            carrier: { type: 'string', description: 'Carrier code from dandh_list_carriers (give together with serviceType).' },
            serviceType: { type: 'string', description: 'Service level for that carrier, from dandh_list_carriers (give together with carrier).' },
            allowPartialShipment: { type: 'boolean', description: 'Ship what is in stock now and the rest later. D&H defaults to yes.' },
            allowBackOrder: { type: 'boolean', description: 'Keep out-of-stock lines on back order instead of dropping them. D&H defaults to yes.' },
            address: { type: 'object', description: 'Drop-ship address object, passed to D&H as given (field names unconfirmed; omit to ship to the account default).' },
          },
        },
        shipments: {
          type: 'array',
          description: 'One entry per shipping branch.',
          items: {
            type: 'object',
            properties: {
              branch: { type: 'string', enum: Object.keys(REST_BRANCHES), description: 'D&H warehouse to ship this group of lines from (see the branch codes above).' },
              lines: {
                type: 'array',
                description: 'Items to ship from this branch.',
                items: {
                  type: 'object',
                  properties: {
                    itemId: { type: 'string', description: 'D&H item number.' },
                    orderQuantity: { type: 'number', description: 'How many to order (whole number, at least 1).' },
                    unitPrice: { type: 'number', description: 'Only for accounts allowed to specify price.' },
                  },
                  required: ['itemId', 'orderQuantity'],
                },
              },
            },
            required: ['branch', 'lines'],
          },
        },
        ...OVERRIDES,
      },
      required: ['customerPurchaseOrder', 'shipments'],
    },
    annotations: WRITE,
  },
];

// ---------------------------------------------------------------------

function scopedRest(base: RestCredentials, args: Record<string, unknown>): RestCredentials {
  const account = optString(args, 'accountNumber');
  const company = optString(args, 'company');
  if (account !== undefined && !isValidAccountNumber(account)) {
    throw new InputError('accountNumber must be the 10-digit D&H account number.');
  }
  return {
    ...base,
    accountNumber: account ?? base.accountNumber,
    company: company ? parseCompany(company) : base.company,
  };
}

const customerPath = (r: RestCredentials) =>
  `/customerOrderManagement/v2/customers/${encodeURIComponent(r.accountNumber)}`;

function bulkQuery(args: Record<string, unknown>): Record<string, QueryValue> {
  const items = optStringList(args, 'items', BULK_MAX) ?? [];
  const skus = optStringList(args, 'customerItemNumbers', BULK_MAX) ?? [];
  if (items.length + skus.length === 0) throw new InputError('Provide items and/or customerItemNumbers.');
  if (items.length + skus.length > BULK_MAX) {
    throw new InputError(`Too many items: ${items.length + skus.length} (maximum ${BULK_MAX} per request).`);
  }
  return {
    items: items.length ? items.join(',') : undefined,
    customerItemNumbers: skus.length ? skus.join(',') : undefined,
  };
}

function pagingQuery(args: Record<string, unknown>): Record<string, QueryValue> {
  return { pageSize: optInt(args, 'pageSize', 1, PAGE_SIZE_MAX), scrollId: optString(args, 'scrollId') };
}

function quantityQuery(args: Record<string, unknown>): Record<string, QueryValue> {
  return { quantity: optInt(args, 'quantity', 1) };
}

/** Returns the body as-is, surfacing an x-scroll-id header as `scrollId` when the body lacks one. */
function withScroll(body: unknown, headerScrollId?: string): unknown {
  if (!headerScrollId) return body;
  if (Array.isArray(body)) return { elements: body, scrollId: headerScrollId };
  if (body && typeof body === 'object' && !('scrollId' in body)) return { ...body, scrollId: headerScrollId };
  return body;
}

function exactlyOne(args: Record<string, unknown>, keys: string[]): void {
  const given = keys.filter((k) => {
    const v = args[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== '';
  });
  if (given.length !== 1) {
    throw new InputError(`Provide exactly one of ${keys.join(', ')} (got ${given.length === 0 ? 'none' : given.join(' + ')}).`);
  }
}

function buildOrderBody(args: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(
    args,
    ['customerPurchaseOrder', 'specialInstructions', 'freightBillingAccount', 'shipping', 'shipments', 'accountNumber', 'company'],
    'order',
  );
  const body: Record<string, unknown> = { customerPurchaseOrder: reqString(args, 'customerPurchaseOrder') };
  const instructions = optString(args, 'specialInstructions');
  if (instructions) body.specialInstructions = instructions;
  const freight = optString(args, 'freightBillingAccount');
  if (freight) body.freightBillingAccount = freight;

  const shipping = optObject(args, 'shipping');
  if (shipping) {
    assertKnownKeys(shipping, ['carrier', 'serviceType', 'allowPartialShipment', 'allowBackOrder', 'address'], 'shipping');
    const carrier = optString(shipping, 'carrier');
    const serviceType = optString(shipping, 'serviceType');
    if (!carrier !== !serviceType) throw new InputError('shipping.carrier and shipping.serviceType must be given together.');
    const out: Record<string, unknown> = {};
    if (carrier) { out.carrier = carrier; out.serviceType = serviceType; }
    for (const k of ['allowPartialShipment', 'allowBackOrder']) {
      const b = optBool(shipping, k);
      if (b !== undefined) out[k] = b;
    }
    const address = optObject(shipping, 'address');
    if (address) {
      for (const [k, v] of Object.entries(address)) {
        if (v !== null && typeof v === 'object') throw new InputError(`shipping.address.${k} must be a string or number.`);
      }
      out.address = address;
    }
    if (Object.keys(out).length) body.shipping = out;
  }

  const shipments = args.shipments;
  if (!Array.isArray(shipments) || shipments.length === 0) throw new InputError('shipments must be a non-empty array.');
  body.shipments = shipments.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`shipments[${i}] must be an object.`);
    const s = raw as Record<string, unknown>;
    assertKnownKeys(s, ['branch', 'lines'], `shipments[${i}]`);
    const branch = reqString(s, 'branch');
    if (!(branch in REST_BRANCHES)) {
      throw new InputError(`shipments[${i}].branch "${branch}" is not valid. Use one of: ${Object.entries(REST_BRANCHES).map(([k, v]) => `${k} (${v})`).join(', ')}.`);
    }
    if (!Array.isArray(s.lines) || s.lines.length === 0) throw new InputError(`shipments[${i}].lines must be a non-empty array.`);
    return {
      branch,
      lines: s.lines.map((l, j) => {
        if (!l || typeof l !== 'object' || Array.isArray(l)) throw new InputError(`shipments[${i}].lines[${j}] must be an object.`);
        const line = l as Record<string, unknown>;
        assertKnownKeys(line, ['itemId', 'orderQuantity', 'unitPrice'], `shipments[${i}].lines[${j}]`);
        const out: Record<string, unknown> = {
          itemId: reqString(line, 'itemId'),
          orderQuantity: optInt(line, 'orderQuantity', 1),
        };
        if (out.orderQuantity === undefined) throw new InputError(`shipments[${i}].lines[${j}].orderQuantity is required.`);
        if (line.unitPrice !== undefined && line.unitPrice !== null) {
          if (typeof line.unitPrice !== 'number' || !(line.unitPrice > 0)) {
            throw new InputError(`shipments[${i}].lines[${j}].unitPrice must be a positive number.`);
          }
          out.unitPrice = line.unitPrice;
        }
        return out;
      }),
    };
  });
  return body;
}

export async function handleRestTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const svc = requireService(name, 'rest');
  if ('error' in svc) return svc.error;
  const { creds } = svc;
  try {
    const rest = scopedRest(creds.rest!, args);
    const base = customerPath(rest);
    const call = async (path: string, query?: Record<string, QueryValue>) => {
      const r = await restRequest(rest, creds.environment, { method: 'GET', path: `${base}${path}`, query });
      return textResult(withScroll(r.body, r.headerScrollId));
    };
    const id = () => encodeURIComponent(reqString(args, 'itemId'));

    switch (name) {
      case 'dandh_get_item': return await call(`/items/${id()}`);
      case 'dandh_search_items': {
        const keys = ['vendorItemId', 'customerItemNumber', 'universalProductCode', 'items', 'vendorItemIds', 'customerItemNumbers'];
        exactlyOne(args, keys);
        const query: Record<string, QueryValue> = { ...pagingQuery(args) };
        for (const k of keys.slice(0, 3)) query[k] = optString(args, k);
        for (const k of keys.slice(3)) query[k] = optStringList(args, k, BULK_MAX)?.join(',');
        return await call('/items', query);
      }
      case 'dandh_get_price': return await call(`/items/${id()}/price`, quantityQuery(args));
      case 'dandh_get_prices_bulk': return await call('/items/price/bulk', bulkQuery(args));
      case 'dandh_get_availability': return await call(`/items/${id()}/availability`);
      case 'dandh_get_availability_bulk': return await call('/items/availability/bulk', bulkQuery(args));
      case 'dandh_get_price_and_availability': return await call(`/items/${id()}/priceAndAvailability`, quantityQuery(args));
      case 'dandh_get_price_and_availability_bulk': return await call('/items/priceAndAvailability/bulk', bulkQuery(args));
      case 'dandh_list_carriers': return await call('/carriers', { shipMode: optString(args, 'shipMode'), ...pagingQuery(args) });
      case 'dandh_get_order_tracking':
        return await call(`/salesOrders/${encodeURIComponent(reqString(args, 'orderId'))}/tracking`);
      case 'dandh_list_order_tracking': {
        const keys = ['orderNumber', 'purchaseOrderNumber', 'invoiceNumber'];
        exactlyOne(args, keys);
        const query: Record<string, QueryValue> = { ...pagingQuery(args) };
        for (const k of keys) query[k] = optString(args, k);
        return await call('/salesOrders/tracking', query);
      }
      case 'dandh_create_sales_order': {
        const body = buildOrderBody(args);
        // Single attempt only: restRequest never re-sends a POST.
        const r = await restRequest(rest, creds.environment, { method: 'POST', path: `${base}/salesOrders`, body });
        return textResult(r.body);
      }
      default:
        return toErrorResult(new Error(`Unknown REST tool: ${name}`), name);
    }
  } catch (err) {
    return toErrorResult(err, name, creds);
  }
}
