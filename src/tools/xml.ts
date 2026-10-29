import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { xmlRequest } from '../xml-client.js';
import { DandhApiError, isDefinitiveRejection } from '../rest-client.js';
import {
  DEFAULT_ORDER_LIMITS,
  ORDER_LIMIT_ENV,
  checkLineCount,
  checkLineQuantity,
  checkOrderValue,
  checkUnitPrice,
  checkDhUnitPrice,
  unpricedRefusal,
  describeLimits,
  loadOrderLimits,
  orderTotal,
  reservePo,
  normalizePoForSend,
  assertPoNotAtDh,
  checkConfirmToken,
  makeConfirmToken,
  type PoLookupResult,
  OrderLimitError,
  type OrderLimits,
} from '../order-safety.js';
import { el, login, wrap, XmlInputError } from '../xml/build.js';
import { child, textOf } from '../xml/parse.js';
import { mapItemInquiry, mapOrderStatus, mapPriceAvailability } from '../xml/responses.js';
import type { XmlCountry, XmlCredentials } from '../types.js';
import type { CallToolResult } from './types.js';
import {
  CONFIRM_PARAM,
  CONFIRM_TOKEN_PARAM,
  InputError,
  READ_ONLY,
  WRITE,
  addressField,
  assertKnownKeys,
  optBool,
  optEnum,
  optObject,
  optString,
  optStringList,
  orderWarning,
  passwordField,
  reqString,
  requireService,
  stateField,
  textResult,
  toErrorResult,
} from './shared.js';

export const XML_PRICE_ONLY_MAX = 50;
export const XML_COMBINED_MAX = 25;
export const XML_STATUS_MAX = 50;

export const XML_CARRIERS = ['Pickup', 'UPS', 'FedEx', 'USPS'] as const;
export const XML_SERVICES = ['Pickup', 'Ground', '2nd Day Air', 'Next Day Air', 'FirstClassMail', 'PriorityMail', 'Red Sat Del'] as const;
export const XML_BRANCHES: Record<XmlCountry, readonly string[]> = {
  us: ['Harrisburg', 'California', 'Chicago', 'Atlanta'],
  ca: ['Toronto', 'Vancouver'],
};
const USPS_ONLY_SERVICES = ['FirstClassMail', 'PriorityMail'];

const PN_ONLY = { type: 'array', items: { type: 'string' } } as const;

const WARNING = orderWarning(
  'dandh_xml_get_price_availability',
  'The PO number must be unique per account.',
  'Any remarks place the order on HOLD for sales-rep review.',
);

/** End-user data fields: camelCase key -> [XML element, max length, optional kind]. */
const END_USER_FIELDS: [string, string, number, ('date' | 'state' | 'zip' | 'updateType')?][] = [
  ['organization', 'ORGANIZATION', 30],
  ['attention', 'ATTENTION', 30],
  ['address', 'ADDRESS', 30],
  ['address2', 'ADDRESS2', 30],
  ['city', 'CITY', 18],
  ['state', 'STATE', 2, 'state'],
  ['zip', 'ZIP', 10, 'zip'],
  ['poNumber', 'PONUM', 30],
  ['department', 'DEPARTMENT', 50],
  ['phone', 'PHONE', 15],
  ['fax', 'FAX', 15],
  ['email', 'EMAIL', 50],
  ['authQuoteNumber', 'AUTHQUOTENUM', 50],
  ['mcn', 'MCN', 50],
  ['ccoidNumber', 'CCOIDNUM', 50],
  ['serialNumbers', 'SERIALNUM', 1250],
  ['esdEmail', 'ESDEMAIL', 50],
  ['resellerEmail', 'RESELLEREMAIL', 50],
  ['resellerPhone', 'RESELLERPHONE', 15],
  ['customerAccountNumber', 'CUSTACCTNO', 50],
  ['dateOfSale', 'DATEOFSALE', 10, 'date'],
  ['modelNumber', 'MODELNO', 50],
  ['warrantySku', 'SKU', 50],
  ['domain', 'DOMAIN', 250],
  ['adminEmail', 'ADMINEMAIL', 50],
  ['updateType', 'UPDATETYPE', 25, 'updateType'],
  ['supportStartDate', 'SUPPORTSTARTDATE', 10, 'date'],
];

export const XML_TOOLS: Tool[] = [
  {
    name: 'dandh_xml_get_price_availability',
    description:
      `Real-time D&H price and/or availability by branch for D&H item numbers (XML). mode "price" or "availability": up to ${XML_PRICE_ONLY_MAX} items; mode "both": up to ${XML_COMBINED_MAX} items. Item-level failures (unknown part numbers) come back per item.`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['price', 'availability', 'both'] },
        partNumbers: { ...PN_ONLY, description: 'D&H item numbers (each max 15 characters).' },
      },
      required: ['mode', 'partNumbers'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_xml_item_inquiry',
    description:
      'Detailed single-item inquiry (XML): volume price for a quantity, ERP, rebate value/end date, non-stock / factory-direct / free-freight / restricted flags, and per-branch quantities. Look up by D&H part number (lookupType DH) or manufacturer part number (MFR).',
    inputSchema: {
      type: 'object',
      properties: {
        partNumber: { type: 'string', description: 'D&H or manufacturer part number (max 50 characters).' },
        lookupType: { type: 'string', enum: ['DH', 'MFR'], description: 'Default DH.' },
        quantity: { type: 'number', description: 'Quantity used for volume pricing. Default 1.' },
      },
      required: ['partNumber'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_xml_get_order_status',
    description:
      `Order status (XML) by PO number, D&H order number and/or invoice number (up to ${XML_STATUS_MAX} lookups in total). Returns milestones, backordered quantities with ETAs, invoice totals, and packages with tracking and serial numbers. Backordered items spawn extra order numbers.`,
    inputSchema: {
      type: 'object',
      properties: {
        poNumbers: { ...PN_ONLY, description: 'Your PO numbers (max 50 characters each).' },
        orderNumbers: { ...PN_ONLY, description: 'D&H order numbers.' },
        invoiceNumbers: { ...PN_ONLY, description: 'D&H invoice numbers.' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'dandh_xml_create_order',
    description:
      WARNING +
      `Submits an Order Entry via XML. Carriers: ${XML_CARRIERS.join(', ')}. Services: ${XML_SERVICES.join(', ')} (FirstClassMail/PriorityMail are USPS-only). Branches: US ${XML_BRANCHES.us.join(', ')}; CA ${XML_BRANCHES.ca.join(', ')}. ` +
      'Omitting the ship-to ships to the account default address; drop-ship requires an authorized account.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: CONFIRM_PARAM,
        confirmToken: CONFIRM_TOKEN_PARAM,
        poNumber: { type: 'string', description: 'Unique PO number (max 30). Reusing one from this connection within 24 hours is refused.' },
        shipCarrier: { type: 'string', enum: [...XML_CARRIERS], description: 'Carrier for the order.' },
        shipService: { type: 'string', enum: [...XML_SERVICES], description: 'Service level (FirstClassMail and PriorityMail are USPS only).' },
        shipBillToAccount: { type: 'string', description: 'Freight account to bill (max 10).' },
        onlyBranch: { type: 'string', description: 'Ship the entire order from this branch (US or CA branch name).' },
        partialShipmentAllowed: { type: 'boolean', description: 'Ship what is in stock now and the rest later. D&H defaults to yes; turning this and backorderAllowed off can get the order cancelled if it cannot ship as asked.' },
        backorderAllowed: { type: 'boolean', description: 'Keep out-of-stock lines on back order. D&H defaults to yes; turning this and partialShipmentAllowed off can get the order cancelled if it cannot ship as asked.' },
        expectedShipDate: { type: 'string', description: 'MM/DD/YYYY. US only; needs prior D&H approval.' },
        remarks: { type: 'string', description: 'Special instructions (max 58). ANY value puts the order ON HOLD.' },
        shipTo: {
          type: 'object',
          description: 'Drop-ship destination (authorized accounts only). name, address, city, state, zip are all required when used. Text fields allow letters, digits, spaces and . , \' - # / & only.',
          properties: {
            name: { type: 'string', description: 'Recipient name (max 25).' },
            attention: { type: 'string', description: 'Attention line (max 30).' },
            address: { type: 'string', description: 'Street address (max 30).' },
            address2: { type: 'string', description: 'Second address line (max 30).' },
            city: { type: 'string', description: 'City (max 18).' },
            state: { type: 'string', description: 'Two-letter state or province code (letters only).' },
            zip: { type: 'string', description: 'ZIP or postal code (US: 5 digits or ZIP+4).' },
            dropShipPassword: { type: 'string', description: 'Drop-ship password (max 30 printable characters), required only if D&H has assigned one to your account.' },
          },
        },
        endUserData: {
          type: 'object',
          description: 'Optional end-user data: ' + END_USER_FIELDS.map((f) => f[0]).join(', ') + '.',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'string', description: 'D&H item number (max 15).' },
              quantity: { type: 'number', description: `How many to order (whole number, 1 to ${DEFAULT_ORDER_LIMITS.maxLineQuantity} by default; whoever runs this D&H connector can change the cap with ${ORDER_LIMIT_ENV.maxLineQuantity}).` },
              branch: { type: 'string', description: 'Ship this line only from this branch.' },
              price: { type: 'number', description: 'Customer unit price; only for select customers. Positive, at most 2 decimal places. Sent to D&H as given; it is NOT used for the order-value limit, which always uses D&H\'s own price. Omit to let D&H price the line.' },
            },
            required: ['partNumber', 'quantity'],
          },
        },
      },
      required: ['poNumber', 'shipCarrier', 'shipService', 'items'],
    },
    annotations: WRITE,
  },
];

// ---------------------------------------------------------------------

const DATE_RE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;
const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

function checkBranch(country: XmlCountry, branch: string, where: string): string {
  if (!XML_BRANCHES[country].includes(branch)) {
    throw new InputError(`${where} "${branch}" is not a valid ${country.toUpperCase()} branch. Use one of: ${XML_BRANCHES[country].join(', ')}.`);
  }
  return branch;
}

function pnList(args: Record<string, unknown>, key: string, max: number, len: number): string[] {
  return optStringList(args, key, max, len) ?? [];
}

export function buildPriceAvailabilityXml(
  userCode: string, password: string, mode: string, parts: string[],
): string {
  const request = mode === 'both' ? 'price-availability' : mode;
  return wrap('XMLFORMPOST', el('REQUEST', request), login(userCode, password), ...parts.map((p) => el('PARTNUM', p, 'partNumber')));
}

interface BuiltOrderLine {
  partNumber: string;
  quantity: number;
  branch?: string;
  /** Caller-supplied unit price, if any. */
  price?: number;
}

interface BuiltOrder {
  xml: string;
  secrets: string[];
  poNumber: string;
  hasRemarks: boolean;
  lines: BuiltOrderLine[];
  summary: Record<string, unknown>;
}

function buildOrderXml(
  xml: { userCode: string; password: string; country: XmlCountry },
  args: Record<string, unknown>,
  limits: OrderLimits,
): BuiltOrder {
  const country = xml.country;
  assertKnownKeys(args, ['confirm', 'confirmToken', 'poNumber', 'shipCarrier', 'shipService', 'shipBillToAccount', 'onlyBranch', 'partialShipmentAllowed', 'backorderAllowed', 'expectedShipDate', 'remarks', 'shipTo', 'endUserData', 'items'], 'order');
  const poNumber = normalizePoForSend(reqString(args, 'poNumber', 30));
  if (poNumber.length > 30) throw new InputError('poNumber must be at most 30 characters after normalization.');
  const carrier = optEnum(args, 'shipCarrier', XML_CARRIERS);
  const service = optEnum(args, 'shipService', XML_SERVICES);
  // Canadian valid SHIPCARRIER/SHIPSERVICE values are in a guide we don't have; US enums apply to US only.
  const carrierRaw = country === 'us' ? carrier : optString(args, 'shipCarrier', 9);
  const serviceRaw = country === 'us' ? service : optString(args, 'shipService', 12);
  if (!carrierRaw) throw new InputError('shipCarrier is required.');
  if (!serviceRaw) throw new InputError('shipService is required.');
  if (country === 'us' && USPS_ONLY_SERVICES.includes(serviceRaw) && carrierRaw !== 'USPS') {
    throw new InputError(`shipService "${serviceRaw}" is only valid with shipCarrier USPS.`);
  }

  const parts: (string | undefined)[] = [];
  const onlyBranch = optString(args, 'onlyBranch');
  if (onlyBranch) parts.push(el('ONLYBRANCH', checkBranch(country, onlyBranch, 'onlyBranch')));
  const yn = (k: string, tag: string) => {
    const b = optBool(args, k);
    if (b !== undefined) parts.push(el(tag, b ? 'Y' : 'N'));
  };
  yn('partialShipmentAllowed', 'PARTSHIPALLOW');
  yn('backorderAllowed', 'BACKORDERALLOW');

  const secrets: string[] = [];
  let shipToSummary: Record<string, unknown> | undefined;
  const shipTo = optObject(args, 'shipTo');
  if (shipTo) {
    assertKnownKeys(shipTo, ['name', 'attention', 'address', 'address2', 'city', 'state', 'zip', 'dropShipPassword'], 'shipTo');
    const name = addressField(shipTo, 'name', 25, 'shipTo.name');
    const address = addressField(shipTo, 'address', 30, 'shipTo.address');
    const city = addressField(shipTo, 'city', 18, 'shipTo.city');
    const state = stateField(shipTo, 'state', 'shipTo.state');
    const zip = addressField(shipTo, 'zip', 10, 'shipTo.zip');
    const attention = addressField(shipTo, 'attention', 30, 'shipTo.attention');
    const address2 = addressField(shipTo, 'address2', 30, 'shipTo.address2');
    const missing = Object.entries({ name, address, city, state, zip }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new InputError(`shipTo requires ${missing.join(', ')} for a drop-ship.`);
    if (country === 'us' && !US_ZIP_RE.test(zip!)) throw new InputError('shipTo.zip must be 5 digits or ZIP+4 (12345-6789).');
    const pw = passwordField(shipTo, 'dropShipPassword', 30, 'shipTo.dropShipPassword');
    if (pw) { secrets.push(pw); parts.push(el('DROPSHIPPW', pw, 'shipTo.dropShipPassword')); }
    parts.push(
      el('SHIPTONAME', name!, 'shipTo.name'),
      attention ? el('SHIPTOATTN', attention, 'shipTo.attention') : undefined,
      el('SHIPTOADDRESS', address!, 'shipTo.address'),
      address2 ? el('SHIPTOADDRESS2', address2, 'shipTo.address2') : undefined,
      el('SHIPTOCITY', city!, 'shipTo.city'),
      el('SHIPTOSTATE', state!, 'shipTo.state'),
      el('SHIPTOZIP', zip!, 'shipTo.zip'),
    );
    shipToSummary = { name, attention, address, address2, city, state, zip, dropShipPasswordGiven: !!pw };
  }

  parts.push(el('SHIPCARRIER', carrierRaw, 'shipCarrier'), el('SHIPSERVICE', serviceRaw, 'shipService'));
  const billTo = optString(args, 'shipBillToAccount', 10);
  if (billTo) parts.push(el('SHIPBILLTOACCOUNT', billTo, 'shipBillToAccount'));

  const shipDate = optString(args, 'expectedShipDate');
  if (shipDate) {
    if (country !== 'us') throw new InputError('expectedShipDate is not supported for Canadian (ca) XML orders.');
    if (!DATE_RE.test(shipDate)) throw new InputError('expectedShipDate must be MM/DD/YYYY.');
    parts.push(el('EXPECTEDSHIPDATE', shipDate));
  }
  parts.push(el('PONUM', poNumber, 'poNumber'));
  const remarks = optString(args, 'remarks', 58);
  if (remarks) parts.push(el('REMARKS', remarks, 'remarks'));

  const eud = optObject(args, 'endUserData');
  if (eud) {
    assertKnownKeys(eud, END_USER_FIELDS.map((f) => f[0]), 'endUserData');
    const rows: string[] = [];
    for (const [key, tag, max, kind] of END_USER_FIELDS) {
      const v = optString(eud, key, max);
      if (!v) continue;
      if (kind === 'state' && v.length !== 2) throw new InputError('endUserData.state must be a two-character code.');
      if (kind === 'zip' && country === 'us' && !US_ZIP_RE.test(v)) throw new InputError('endUserData.zip must be 5 digits or ZIP+4.');
      if (kind === 'date' && !DATE_RE.test(v)) throw new InputError(`endUserData.${key} must be MM/DD/YYYY.`);
      if (kind === 'updateType' && !['New', 'Renewal', 'Upgrade'].includes(v)) throw new InputError('endUserData.updateType must be New, Renewal or Upgrade.');
      rows.push(el(tag, v, `endUserData.${key}`));
    }
    if (rows.length) parts.push(wrap('ENDUSERDATA', ...rows));
  }

  const items = args.items;
  if (!Array.isArray(items) || items.length === 0) throw new InputError('items must be a non-empty array.');
  checkLineCount(items.length, limits);
  const lines: BuiltOrderLine[] = [];
  const itemXml = items.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`items[${i}] must be an object.`);
    const it = raw as Record<string, unknown>;
    assertKnownKeys(it, ['partNumber', 'quantity', 'branch', 'price'], `items[${i}]`);
    const qtyRaw = it.quantity;
    const qty = typeof qtyRaw === 'string' && /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : qtyRaw;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 99999) {
      throw new InputError(`items[${i}].quantity must be an integer between 1 and 99999.`);
    }
    checkLineQuantity(qty, `items[${i}].quantity`, limits);
    const branch = optString(it, 'branch');
    let price: number | undefined;
    if (it.price !== undefined && it.price !== null) price = checkUnitPrice(it.price, `items[${i}].price`);
    const partNumber = reqString(it, 'partNumber', 15);
    lines.push({ partNumber, quantity: qty, branch, price });
    return wrap(
      'ITEM',
      el('PARTNUM', partNumber, `items[${i}].partNumber`),
      el('QTY', qty),
      branch ? el('BRANCH', checkBranch(country, branch, `items[${i}].branch`)) : undefined,
      price !== undefined ? el('PRICE', String(price)) : undefined,
    );
  });

  return {
    xml: wrap('XMLFORMPOST', el('REQUEST', 'orderEntry'), login(xml.userCode, xml.password), wrap('ORDERHEADER', ...parts), wrap('ORDERITEMS', ...itemXml)),
    secrets,
    poNumber,
    hasRemarks: !!remarks,
    lines,
    summary: {
      poNumber,
      shipCarrier: carrierRaw,
      shipService: serviceRaw,
      shipBillToAccount: billTo,
      onlyBranch,
      partialShipmentAllowed: optBool(args, 'partialShipmentAllowed'),
      backorderAllowed: optBool(args, 'backorderAllowed'),
      expectedShipDate: shipDate,
      shipTo: shipToSummary,
      remarksPutOrderOnHold: !!remarks,
    },
  };
}

/** Current D&H unit prices for the given part numbers (lowercased key). Missing when D&H gave none. */
async function lookupPrices(xc: XmlCredentials, partNumbers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(partNumbers)];
  for (let i = 0; i < unique.length; i += XML_PRICE_ONLY_MAX) {
    const chunk = unique.slice(i, i + XML_PRICE_ONLY_MAX);
    const root = await xmlRequest(xc, buildPriceAvailabilityXml(xc.userCode, xc.password, 'price', chunk), { idempotent: true });
    for (const it of mapPriceAvailability(root)) {
      if (it.partNumber && typeof it.unitPrice === 'number' && it.unitPrice > 0) out.set(it.partNumber.toLowerCase(), it.unitPrice);
    }
  }
  return out;
}

/**
 * UNVERIFIED wording of D&H's failure message when a status lookup finds nothing. The dhXML spec
 * (DH-IS-WEB-XML_US) has no structured status/code for "no orders found", only a free-text MESSAGE,
 * so this matches one exact phrase against the whole message. Anything else is "unknown" and refuses the order.
 */
const NO_ORDERS_RE = /^\s*no orders? found\.?\s*$/i;

/**
 * Looks the PO up with an orderStatus request. ASSUMED (unverified): a lookup with no match returns
 * STATUS success with no ORDERSTATUS element, or a failure whose whole message is NO_ORDERS_RE.
 * ORDERSTATUS elements with an ORDERNUM mean the PO exists; anything else is "unknown" and the order is refused.
 */
export async function lookupPoStatus(xc: XmlCredentials, po: string): Promise<PoLookupResult> {
  const body = wrap('XMLFORMPOST', el('REQUEST', 'orderStatus'), login(xc.userCode, xc.password), wrap('STATUSREQUEST', el('PONUM', po, 'poNumbers')));
  let root;
  try {
    root = await xmlRequest(xc, body, { idempotent: true });
  } catch (err) {
    if (err instanceof DandhApiError && err.rejected && err.dhMessage !== undefined && NO_ORDERS_RE.test(err.dhMessage)) return 'none';
    throw err;
  }
  if (textOf(root, 'STATUS')?.toLowerCase() !== 'success') return 'unknown';
  const orders = mapOrderStatus(root);
  if (orders.length === 0) return 'none';
  return orders.some((o) => o.orderNumber) ? 'exists' : 'unknown';
}

async function placeOrDescribeOrder(xc: XmlCredentials, args: Record<string, unknown>): Promise<CallToolResult> {
  const limits = loadOrderLimits();
  const confirm = optBool(args, 'confirm') === true;
  const built = buildOrderXml(xc, args, limits);
  // What the confirm token binds to: the normalized order XML (after validation, so it includes every field).
  const confirmBinding = { country: xc.country, xml: built.xml };

  // Cap math uses D&H's current price only (read-only lookup). Caller prices are never used.
  const needLookup = built.lines.map((l) => l.partNumber);
  let looked = new Map<string, number>();
  let lookupError: string | undefined;
  if (needLookup.length) {
    try {
      looked = await lookupPrices(xc, needLookup);
    } catch (err) {
      if (confirm) throw err;
      lookupError = err instanceof Error ? err.message : String(err);
    }
  }
  const priced = built.lines.map((l) => {
    const { price: callerPrice, ...rest } = l;
    return { ...rest, callerPrice, unitPrice: looked.get(l.partNumber.toLowerCase()) };
  });
  for (const l of priced) if (l.unitPrice !== undefined) checkDhUnitPrice(l.unitPrice, `part ${l.partNumber}`, limits);
  const total = orderTotal(priced.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })));
  if (total !== null) checkOrderValue(total, limits);

  if (!confirm) {
    return textResult({
      status: 'preview',
      placed: false,
      message:
        'Preview only: no order was sent to D&H (only price lookups). Show this to the user and, once they explicitly approve every line, quantity, branch and shipping choice, call again with confirm: true to place the order.' +
        (total === null ? " D&H didn't return a price for one or more lines, so confirm: true will be refused for that reason. Check the items with dandh_xml_get_price_availability." : ''),
      confirmToken: makeConfirmToken(xc.userCode, confirmBinding),
      order: built.summary,
      lines: priced.map((l) => ({
        partNumber: l.partNumber,
        quantity: l.quantity,
        branch: l.branch,
        dhUnitPrice: l.unitPrice ?? 'unknown',
        ...(l.callerPrice !== undefined ? { callerPriceSentToDH: l.callerPrice } : {}),
        lineTotal: l.unitPrice === undefined ? 'unknown' : Math.round(l.quantity * l.unitPrice * 100) / 100,
      })),
      lineCount: priced.length,
      estimatedTotal: total ?? 'unknown',
      ...(lookupError ? { priceLookupError: lookupError } : {}),
      limitsApplied: describeLimits(limits),
    });
  }

  if (total === null) {
    throw new OrderLimitError(
      unpricedRefusal('dandh_xml_get_price_availability'),
    );
  }

  checkConfirmToken(xc.userCode, confirmBinding, optString(args, 'confirmToken'));

  const release = reservePo(xc.userCode, built.poNumber, 'dandh_xml_get_order_status');
  // Fail closed: refuse unless D&H clearly shows no order with this PO. Releases the reservation (nothing sent).
  await assertPoNotAtDh(built.poNumber, 'dandh_xml_get_order_status', () => lookupPoStatus(xc, built.poNumber), release);
  let root;
  try {
    root = await xmlRequest(xc, built.xml, {
      idempotent: false,
      secrets: built.secrets,
      onUnknownOutcome: `The order may or may not have been placed — check dandh_xml_get_order_status for PO ${built.poNumber} before retrying.`,
    });
  } catch (err) {
    // Keep the PO reserved unless D&H definitively refused the request.
    if (isDefinitiveRejection(err)) release();
    throw err;
  }
  const orderNumber = textOf(root, 'ORDERNUM');
  if (!orderNumber && !child(root, 'ORDERNUM')) {
    throw new InputError(`D&H did not return an order number. Check dandh_xml_get_order_status for PO ${built.poNumber} before retrying.`);
  }
  return textResult({
    status: 'success',
    orderNumber,
    poNumber: built.poNumber,
    note: built.hasRemarks
      ? 'Remarks were supplied, so the order is ON HOLD awaiting D&H sales-rep processing.'
      : 'Backordered/split items may spawn additional order numbers; check dandh_xml_get_order_status.',
  });
}

export async function handleXmlTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const svc = requireService(name, 'xml');
  if ('error' in svc) return svc.error;
  const { creds } = svc;
  const xc = creds.xml!;
  try {
    switch (name) {
      case 'dandh_xml_get_price_availability': {
        const mode = optEnum(args, 'mode', ['price', 'availability', 'both'] as const);
        if (!mode) throw new InputError('mode is required: price, availability or both.');
        const max = mode === 'both' ? XML_COMBINED_MAX : XML_PRICE_ONLY_MAX;
        const parts = pnList(args, 'partNumbers', max, 15);
        if (parts.length === 0) throw new InputError('partNumbers must contain at least one item.');
        const root = await xmlRequest(xc, buildPriceAvailabilityXml(xc.userCode, xc.password, mode, parts), { idempotent: true });
        return textResult({ items: mapPriceAvailability(root) });
      }
      case 'dandh_xml_item_inquiry': {
        const partNumber = reqString(args, 'partNumber', 50);
        const lookupType = optEnum(args, 'lookupType', ['DH', 'MFR'] as const) ?? 'DH';
        const q = args.quantity === undefined || args.quantity === null ? 1 : args.quantity;
        if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 99999) {
          throw new InputError('quantity must be an integer between 1 and 99999.');
        }
        const body = wrap('XMLFORMPOST', el('REQUEST', 'itemInquiry'), login(xc.userCode, xc.password),
          el('PARTNUM', partNumber, 'partNumber'), el('LOOKUPTYPE', lookupType), el('QUANTITY', q));
        const root = await xmlRequest(xc, body, { idempotent: true });
        return textResult({ item: mapItemInquiry(root) ?? null });
      }
      case 'dandh_xml_get_order_status': {
        const po = pnList(args, 'poNumbers', XML_STATUS_MAX, 50);
        const on = pnList(args, 'orderNumbers', XML_STATUS_MAX, 50);
        const inv = pnList(args, 'invoiceNumbers', XML_STATUS_MAX, 50);
        const total = po.length + on.length + inv.length;
        if (total === 0) throw new InputError('Provide at least one of poNumbers, orderNumbers, invoiceNumbers.');
        if (total > XML_STATUS_MAX) throw new InputError(`Too many lookups: ${total} (maximum ${XML_STATUS_MAX} per request).`);
        const reqs = [
          ...po.map((v) => wrap('STATUSREQUEST', el('PONUM', v, 'poNumbers'))),
          ...on.map((v) => wrap('STATUSREQUEST', el('ORDERNUM', v, 'orderNumbers'))),
          ...inv.map((v) => wrap('STATUSREQUEST', el('INVOICE', v, 'invoiceNumbers'))),
        ];
        const body = wrap('XMLFORMPOST', el('REQUEST', 'orderStatus'), login(xc.userCode, xc.password), ...reqs);
        const root = await xmlRequest(xc, body, { idempotent: true });
        return textResult({ orders: mapOrderStatus(root) });
      }
      case 'dandh_xml_create_order':
        return await placeOrDescribeOrder(xc, args);
      default:
        return toErrorResult(new Error(`Unknown XML tool: ${name}`), name);
    }
  } catch (err) {
    const secrets = [(args.shipTo as { dropShipPassword?: string } | undefined)?.dropShipPassword].filter((s): s is string => typeof s === 'string');
    return toErrorResult(err instanceof XmlInputError ? new InputError(err.message) : err, name, creds, secrets);
  }
}
