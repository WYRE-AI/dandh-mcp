import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { isDefinitiveRejection, restRequest, type QueryValue } from '../rest-client.js';
import {
  DEFAULT_ORDER_LIMITS,
  ORDER_LIMIT_ENV,
  OrderLimitError,
  checkLineCount,
  checkLineQuantity,
  checkOrderValue,
  checkUnitPrice,
  describeLimits,
  loadOrderLimits,
  orderTotal,
  reservePo,
  type OrderLimits,
} from '../order-safety.js';
import type { Environment, RestCredentials } from '../types.js';
import type { CallToolResult } from './types.js';
import {
  CONFIRM_PARAM,
  InputError,
  READ_ONLY,
  WRITE,
  isAddressText,
  assertKnownKeys,
  optBool,
  optInt,
  optObject,
  optString,
  optStringList,
  orderWarning,
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

const WARNING = orderWarning(
  'dandh_get_price_and_availability',
  'The PO number must be unique.',
  'Any special instructions place the order on HOLD for manual review by D&H.',
);

/** Keys accepted in shipping.address. D&H's field names are unconfirmed, so this is a small conservative set. */
export const ADDRESS_KEYS = ['name', 'attention', 'address', 'address1', 'address2', 'city', 'state', 'province', 'zip', 'postalCode', 'country'] as const;
const ADDRESS_MAX_KEYS = 12;
const ADDRESS_VALUE_MAX = 60;

export const REST_TOOLS: Tool[] = [
  {
    name: 'dandh_get_item',
    description: 'Get D&H item detail for one D&H item number (REST).',
    inputSchema: { type: 'object', properties: { itemId }, required: ['itemId'] },
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
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_price',
    description: 'Get customer-specific price for one D&H item, with optional quantity for volume pricing (REST).',
    inputSchema: { type: 'object', properties: { itemId, quantity }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_prices_bulk',
    description: `Get prices for up to ${BULK_MAX} items in one call (REST). Provide items and/or customerItemNumbers.`,
    inputSchema: { type: 'object', properties: { ...bulkProps } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_availability',
    description: 'Get real-time availability by distribution center (with restock ETAs when D&H provides them) for one item (REST).',
    inputSchema: { type: 'object', properties: { itemId }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_availability_bulk',
    description: `Get availability for up to ${BULK_MAX} items in one call (REST). Provide items and/or customerItemNumbers.`,
    inputSchema: { type: 'object', properties: { ...bulkProps } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_price_and_availability',
    description: 'Get price (optionally for a quantity) and availability for one item in one call (REST). Use before placing an order.',
    inputSchema: { type: 'object', properties: { itemId, quantity }, required: ['itemId'] },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_price_and_availability_bulk',
    description: `Get price and availability for up to ${BULK_MAX} items in one call (REST). Provide items and/or customerItemNumbers.`,
    inputSchema: { type: 'object', properties: { ...bulkProps } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_list_carriers',
    description: 'List shipping carriers / service types available to the account, optionally filtered by shipMode. Use these values in dandh_create_sales_order (REST).',
    inputSchema: { type: 'object', properties: { shipMode: { type: 'string' }, ...paging } },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_get_order_tracking',
    description: 'Get status and tracking for one sales order by its D&H sales order id: backorders, invoice breakdown, packages, tracking and serial numbers (REST).',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'D&H sales order id.' } },
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
        confirm: CONFIRM_PARAM,
        customerPurchaseOrder: { type: 'string', description: 'Your PO number. MUST be unique; reusing one from this connection within 24 hours is refused.' },
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
            address: { type: 'object', description: `Drop-ship address: a flat object of text values (keys: ${ADDRESS_KEYS.join(', ')}; max ${ADDRESS_VALUE_MAX} characters each; letters, digits, spaces and . , ' - # / & only). D&H's field names are unconfirmed. Omit to ship to the account default.` },
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
                    orderQuantity: { type: 'number', description: `How many to order (whole number, 1 to ${DEFAULT_ORDER_LIMITS.maxLineQuantity} by default; admins can change the cap with ${ORDER_LIMIT_ENV.maxLineQuantity}).` },
                    unitPrice: { type: 'number', description: 'Only for accounts allowed to specify price. Positive, at most 2 decimal places and under the unit-price cap. Omit to let D&H price the line.' },
                  },
                  required: ['itemId', 'orderQuantity'],
                },
              },
            },
            required: ['branch', 'lines'],
          },
        },
      },
      required: ['customerPurchaseOrder', 'shipments'],
    },
    annotations: WRITE,
  },
];

// ---------------------------------------------------------------------

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

interface BuiltRestOrder {
  body: Record<string, unknown>;
  lines: { branch: string; itemId: string; quantity: number; unitPrice?: number }[];
  summary: Record<string, unknown>;
}

function validateAddress(address: Record<string, unknown>): Record<string, string> {
  const keys = Object.keys(address);
  if (keys.length > ADDRESS_MAX_KEYS) throw new InputError(`shipping.address has ${keys.length} fields; the maximum is ${ADDRESS_MAX_KEYS}.`);
  assertKnownKeys(address, ADDRESS_KEYS, 'shipping.address');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(address)) {
    if (typeof v !== 'string') throw new InputError(`shipping.address.${k} must be a text value.`);
    const t = v.trim();
    if (!t) continue;
    if (t.length > ADDRESS_VALUE_MAX) throw new InputError(`shipping.address.${k} must be at most ${ADDRESS_VALUE_MAX} characters (got ${t.length}).`);
    if (!isAddressText(t)) {
      throw new InputError(`shipping.address.${k} contains characters that are not allowed. Use letters, digits, spaces and . , ' - # / & only.`);
    }
    out[k] = t;
  }
  return out;
}

function buildOrderBody(args: Record<string, unknown>, limits: OrderLimits): BuiltRestOrder {
  assertKnownKeys(
    args,
    ['confirm', 'customerPurchaseOrder', 'specialInstructions', 'freightBillingAccount', 'shipping', 'shipments'],
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
      const clean = validateAddress(address);
      if (Object.keys(clean).length) out.address = clean;
    }
    if (Object.keys(out).length) body.shipping = out;
  }

  const shipments = args.shipments;
  if (!Array.isArray(shipments) || shipments.length === 0) throw new InputError('shipments must be a non-empty array.');
  const totalLines = shipments.reduce<number>((n, sh) => {
    const l = (sh as { lines?: unknown } | null)?.lines;
    return n + (Array.isArray(l) ? l.length : 0);
  }, 0);
  checkLineCount(totalLines, limits);
  const lines: BuiltRestOrder['lines'] = [];
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
        checkLineQuantity(out.orderQuantity as number, `shipments[${i}].lines[${j}].orderQuantity`, limits);
        let unitPrice: number | undefined;
        if (line.unitPrice !== undefined && line.unitPrice !== null) {
          unitPrice = checkUnitPrice(line.unitPrice, `shipments[${i}].lines[${j}].unitPrice`, limits);
          out.unitPrice = unitPrice;
        }
        lines.push({ branch, itemId: out.itemId as string, quantity: out.orderQuantity as number, unitPrice });
        return out;
      }),
    };
  });
  const ship = body.shipping as Record<string, unknown> | undefined;
  return {
    body,
    lines,
    summary: {
      customerPurchaseOrder: body.customerPurchaseOrder,
      freightBillingAccount: body.freightBillingAccount,
      shipping: ship,
      specialInstructionsPutOrderOnHold: !!instructions,
    },
  };
}

/** Pulls a unit price out of a REST price response. The shape is unconfirmed, so this looks for common names. */
const PRICE_KEYS = ['unitprice', 'customerprice', 'yourprice', 'netprice', 'price'];
export function extractUnitPrice(body: unknown, depth = 0): number | undefined {
  if (depth > 3 || body === null || body === undefined) return undefined;
  if (Array.isArray(body)) {
    for (const x of body.slice(0, 3)) {
      const p = extractUnitPrice(x, depth + 1);
      if (p !== undefined) return p;
    }
    return undefined;
  }
  if (typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  for (const want of PRICE_KEYS) {
    const key = Object.keys(rec).find((k) => k.toLowerCase() === want);
    if (!key) continue;
    const v = rec[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const p = extractUnitPrice(v, depth + 1);
      if (p !== undefined) return p;
    }
  }
  return undefined;
}

async function placeOrDescribeOrder(rest: RestCredentials, environment: Environment, base: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const limits = loadOrderLimits();
  const confirm = optBool(args, 'confirm') === true;
  const built = buildOrderBody(args, limits);

  // Unit prices: the caller's, else D&H's current price (read-only lookups, one per distinct item + quantity).
  const looked = new Map<string, number>();
  let lookupError: string | undefined;
  const key = (l: { itemId: string; quantity: number }) => `${l.itemId.toLowerCase()}|${l.quantity}`;
  try {
    for (const l of built.lines) {
      if (l.unitPrice !== undefined || looked.has(key(l))) continue;
      const r = await restRequest(rest, environment, {
        method: 'GET',
        path: `${base}/items/${encodeURIComponent(l.itemId)}/price`,
        query: { quantity: l.quantity },
      });
      const p = extractUnitPrice(r.body);
      if (p !== undefined) looked.set(key(l), p);
    }
  } catch (err) {
    if (confirm) throw err;
    lookupError = err instanceof Error ? err.message : String(err);
  }
  const priced = built.lines.map((l) => {
    const fromD = looked.get(key(l));
    return {
      ...l,
      unitPrice: l.unitPrice ?? fromD,
      priceSource: l.unitPrice !== undefined ? 'caller' : fromD !== undefined ? 'D&H current price' : 'unknown',
    };
  });
  const total = orderTotal(priced.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })));
  if (total !== null) checkOrderValue(total, limits);

  if (!confirm) {
    return textResult({
      status: 'preview',
      placed: false,
      message:
        'Preview only: nothing was sent to the D&H order endpoint. Show this to the user and, once they explicitly approve every line, quantity, branch and shipping choice, call again with confirm: true to place the order.' +
        (total === null ? ' The total could not be determined for every line, so confirm: true would be refused until each line has a known price (pass unitPrice, or check the item numbers).' : ''),
      order: built.summary,
      shipments: [...new Set(priced.map((l) => l.branch))].map((branch) => ({
        branch,
        lines: priced
          .filter((l) => l.branch === branch)
          .map((l) => ({
            itemId: l.itemId,
            orderQuantity: l.quantity,
            unitPrice: l.unitPrice ?? 'unknown',
            priceSource: l.priceSource,
            lineTotal: l.unitPrice === undefined ? 'unknown' : Math.round(l.quantity * l.unitPrice * 100) / 100,
          })),
      })),
      lineCount: priced.length,
      estimatedTotal: total ?? 'unknown',
      ...(lookupError ? { priceLookupError: lookupError } : {}),
      limitsApplied: describeLimits(limits),
    });
  }

  if (total === null) {
    throw new OrderLimitError(
      'Cannot place this order: the price of one or more lines could not be determined, so the order value cannot be checked against the limit. Pass unitPrice on each line, or check the item numbers with dandh_get_price.',
    );
  }

  const release = reservePo(rest.accountNumber, String(built.body.customerPurchaseOrder), 'dandh_list_order_tracking');
  try {
    // Single attempt only: restRequest never re-sends a POST.
    const r = await restRequest(rest, environment, { method: 'POST', path: `${base}/salesOrders`, body: built.body });
    return textResult(r.body);
  } catch (err) {
    // Keep the PO reserved unless D&H definitively refused the request.
    if (isDefinitiveRejection(err)) release();
    throw err;
  }
}

export async function handleRestTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const svc = requireService(name, 'rest');
  if ('error' in svc) return svc.error;
  const { creds } = svc;
  try {
    const rest = creds.rest!;
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
      case 'dandh_create_sales_order':
        return await placeOrDescribeOrder(rest, creds.environment, base, args);
      default:
        return toErrorResult(new Error(`Unknown REST tool: ${name}`), name);
    }
  } catch (err) {
    return toErrorResult(err, name, creds);
  }
}
