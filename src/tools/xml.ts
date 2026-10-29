import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { xmlRequest } from '../xml-client.js';
import { el, login, wrap, XmlInputError } from '../xml/build.js';
import { child, textOf } from '../xml/parse.js';
import { mapItemInquiry, mapOrderStatus, mapPriceAvailability } from '../xml/responses.js';
import type { XmlCountry } from '../types.js';
import type { CallToolResult } from './types.js';
import {
  InputError,
  READ_ONLY,
  WRITE,
  assertKnownKeys,
  optBool,
  optEnum,
  optObject,
  optString,
  optStringList,
  reqString,
  requireService,
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

const WARNING =
  'WARNING: THIS PLACES A REAL, BILLABLE PURCHASE ORDER WITH D&H. Orders CANNOT be cancelled via the API. ' +
  'The PO number must be unique per account. Any remarks place the order on HOLD for sales-rep review. ' +
  'Before calling, confirm current price and stock (dandh_xml_get_price_availability) and get EXPLICIT user confirmation of every item, quantity, branch and shipping choice. ';

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
        poNumber: { type: 'string', description: 'Unique PO number (max 30).' },
        shipCarrier: { type: 'string', enum: [...XML_CARRIERS] },
        shipService: { type: 'string', enum: [...XML_SERVICES] },
        shipBillToAccount: { type: 'string', description: 'Freight account to bill (max 10).' },
        onlyBranch: { type: 'string', description: 'Ship the entire order from this branch (US or CA branch name).' },
        partialShipmentAllowed: { type: 'boolean', description: 'PARTSHIPALLOW; D&H default is allowed.' },
        backorderAllowed: { type: 'boolean', description: 'BACKORDERALLOW; D&H default is allowed.' },
        expectedShipDate: { type: 'string', description: 'MM/DD/YYYY. US only; needs prior D&H approval.' },
        remarks: { type: 'string', description: 'Special instructions (max 58). ANY value puts the order ON HOLD.' },
        shipTo: {
          type: 'object',
          description: 'Drop-ship destination (authorized accounts only). name, address, city, state, zip are all required when used.',
          properties: {
            name: { type: 'string' }, attention: { type: 'string' }, address: { type: 'string' },
            address2: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' },
            zip: { type: 'string' }, dropShipPassword: { type: 'string' },
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
              quantity: { type: 'number' },
              branch: { type: 'string', description: 'Ship this line only from this branch.' },
              price: { type: 'number', description: 'Customer price; only for select customers.' },
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

function buildOrderXml(
  xml: { userCode: string; password: string; country: XmlCountry },
  args: Record<string, unknown>,
): { xml: string; secrets: string[]; poNumber: string; hasRemarks: boolean } {
  const country = xml.country;
  assertKnownKeys(args, ['poNumber', 'shipCarrier', 'shipService', 'shipBillToAccount', 'onlyBranch', 'partialShipmentAllowed', 'backorderAllowed', 'expectedShipDate', 'remarks', 'shipTo', 'endUserData', 'items'], 'order');
  const poNumber = reqString(args, 'poNumber', 30);
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
  const shipTo = optObject(args, 'shipTo');
  if (shipTo) {
    assertKnownKeys(shipTo, ['name', 'attention', 'address', 'address2', 'city', 'state', 'zip', 'dropShipPassword'], 'shipTo');
    const name = optString(shipTo, 'name', 25);
    const address = optString(shipTo, 'address', 30);
    const city = optString(shipTo, 'city', 18);
    const state = optString(shipTo, 'state', 2);
    const zip = optString(shipTo, 'zip', 10);
    const missing = Object.entries({ name, address, city, state, zip }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new InputError(`shipTo requires ${missing.join(', ')} for a drop-ship.`);
    if (state!.length !== 2) throw new InputError('shipTo.state must be a two-character state/province code.');
    if (country === 'us' && !US_ZIP_RE.test(zip!)) throw new InputError('shipTo.zip must be 5 digits or ZIP+4 (12345-6789).');
    const pw = optString(shipTo, 'dropShipPassword', 30);
    if (pw) { secrets.push(pw); parts.push(el('DROPSHIPPW', pw, 'shipTo.dropShipPassword')); }
    parts.push(
      el('SHIPTONAME', name!, 'shipTo.name'),
      optString(shipTo, 'attention', 30) ? el('SHIPTOATTN', optString(shipTo, 'attention', 30)!, 'shipTo.attention') : undefined,
      el('SHIPTOADDRESS', address!, 'shipTo.address'),
      optString(shipTo, 'address2', 30) ? el('SHIPTOADDRESS2', optString(shipTo, 'address2', 30)!, 'shipTo.address2') : undefined,
      el('SHIPTOCITY', city!, 'shipTo.city'),
      el('SHIPTOSTATE', state!, 'shipTo.state'),
      el('SHIPTOZIP', zip!, 'shipTo.zip'),
    );
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
  const itemXml = items.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`items[${i}] must be an object.`);
    const it = raw as Record<string, unknown>;
    assertKnownKeys(it, ['partNumber', 'quantity', 'branch', 'price'], `items[${i}]`);
    const qtyRaw = it.quantity;
    const qty = typeof qtyRaw === 'string' && /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : qtyRaw;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 99999) {
      throw new InputError(`items[${i}].quantity must be an integer between 1 and 99999.`);
    }
    const branch = optString(it, 'branch');
    let price: string | undefined;
    if (it.price !== undefined && it.price !== null) {
      if (typeof it.price !== 'number' || !(it.price > 0)) throw new InputError(`items[${i}].price must be a positive number.`);
      price = String(it.price);
    }
    return wrap(
      'ITEM',
      el('PARTNUM', reqString(it, 'partNumber', 15), `items[${i}].partNumber`),
      el('QTY', qty),
      branch ? el('BRANCH', checkBranch(country, branch, `items[${i}].branch`)) : undefined,
      price ? el('PRICE', price) : undefined,
    );
  });

  return {
    xml: wrap('XMLFORMPOST', el('REQUEST', 'orderEntry'), login(xml.userCode, xml.password), wrap('ORDERHEADER', ...parts), wrap('ORDERITEMS', ...itemXml)),
    secrets,
    poNumber,
    hasRemarks: !!remarks,
  };
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
      case 'dandh_xml_create_order': {
        const built = buildOrderXml(xc, args);
        const root = await xmlRequest(xc, built.xml, {
          idempotent: false,
          secrets: built.secrets,
          onUnknownOutcome: `The order may or may not have been placed — check dandh_xml_get_order_status for PO ${built.poNumber} before retrying.`,
        });
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
      default:
        return toErrorResult(new Error(`Unknown XML tool: ${name}`), name);
    }
  } catch (err) {
    const secrets = [(args.shipTo as { dropShipPassword?: string } | undefined)?.dropShipPassword].filter((s): s is string => typeof s === 'string');
    return toErrorResult(err instanceof XmlInputError ? new InputError(err.message) : err, name, creds, secrets);
  }
}
