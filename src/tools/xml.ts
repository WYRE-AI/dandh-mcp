/**
 * The 3 dhXML read requests this server exposes (D&H US XML guide
 * DH.IS.WEB.XML.1, Dec 2024). They are POSTs only because dhXML takes every
 * request as a form-POSTed document; each one is a documented, side-effect-free
 * query. Order Entry is deliberately not implemented.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ArgumentError } from '../types.js';
import { xmlPost } from '../xml-client.js';
import { el, login, wrap } from '../xml/build.js';
import { mapItemInquiry, mapOrderStatus, mapPriceAvailability } from '../xml/responses.js';
import { int, requireXml, str, strList } from './args.js';
import { READ_ONLY, type ToolArgs, type ToolDef } from './types.js';

export const XML_PRICE_ONLY_MAX = 50;
export const XML_COMBINED_MAX = 25;
export const XML_STATUS_MAX = 50;
const PART_NUMBER_MAX = 15;
const INQUIRY_PART_MAX = 50;
const QUANTITY_MAX = 99999;

const MODES = ['price', 'availability', 'both'] as const;
const LOOKUP_TYPES = ['DH', 'MFR'] as const;

const stringList = (description: string, maxItems: number, maxLength: number) => ({
  type: 'array',
  description,
  maxItems,
  items: { type: 'string', maxLength },
});

function schema(properties: Record<string, object>, required: string[] = []): Tool['inputSchema'] {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const priceAvailability: ToolDef = {
  tier: 'read',
  tool: {
    name: 'dandh_xml_get_price_availability',
    description:
      `Real-time D&H price and/or availability by branch for D&H item numbers (XML). mode "price" or "availability": up to ${XML_PRICE_ONLY_MAX} items; mode "both": up to ${XML_COMBINED_MAX} items. ` +
      'Unknown part numbers come back as item-level messages.',
    inputSchema: schema(
      {
        mode: { type: 'string', enum: [...MODES], description: 'What to return.' },
        partNumbers: stringList(`D&H item numbers (each max ${PART_NUMBER_MAX} characters).`, XML_PRICE_ONLY_MAX, PART_NUMBER_MAX),
      },
      ['mode', 'partNumbers'],
    ),
    annotations: READ_ONLY,
  },
  handler: async (args: ToolArgs, creds) => {
    const xc = requireXml(creds, 'dandh_xml_get_price_availability', 'dandh_get_prices_bulk, dandh_get_availability_bulk or dandh_get_price_and_availability_bulk');
    const mode = str(args.mode, 'mode', 20, MODES);
    const parts = strList(args.partNumbers, 'partNumbers', mode === 'both' ? XML_COMBINED_MAX : XML_PRICE_ONLY_MAX, PART_NUMBER_MAX);
    if (parts.length === 0) throw new ArgumentError('"partNumbers" must contain at least one item.');
    const request = mode === 'both' ? 'price-availability' : mode;
    const root = await xmlPost(xc, wrap('XMLFORMPOST', el('REQUEST', request), login(xc.userCode, xc.password), ...parts.map((p) => el('PARTNUM', p, 'partNumbers'))));
    return { items: mapPriceAvailability(root) };
  },
};

const itemInquiry: ToolDef = {
  tier: 'read',
  tool: {
    name: 'dandh_xml_item_inquiry',
    description:
      'Detailed single-item inquiry (XML): volume price for a quantity, estimated retail price, rebate value and end date, non-stock / factory-direct / free-freight / restricted flags, and quantity per branch. Look up by D&H part number (lookupType DH) or manufacturer part number (MFR).',
    inputSchema: schema(
      {
        partNumber: { type: 'string', maxLength: INQUIRY_PART_MAX, description: `D&H or manufacturer part number (max ${INQUIRY_PART_MAX} characters).` },
        lookupType: { type: 'string', enum: [...LOOKUP_TYPES], description: 'DH (default) or MFR.' },
        quantity: { type: 'integer', minimum: 1, maximum: QUANTITY_MAX, description: 'Quantity used for volume pricing. Default 1.' },
      },
      ['partNumber'],
    ),
    annotations: READ_ONLY,
  },
  handler: async (args: ToolArgs, creds) => {
    const xc = requireXml(creds, 'dandh_xml_item_inquiry', 'dandh_get_item or dandh_get_price_and_availability');
    const partNumber = str(args.partNumber, 'partNumber', INQUIRY_PART_MAX);
    const lookupType = args.lookupType === undefined ? 'DH' : str(args.lookupType, 'lookupType', 3, LOOKUP_TYPES);
    const quantity = args.quantity === undefined ? 1 : int(args.quantity, 'quantity', 1, { maximum: QUANTITY_MAX });
    const root = await xmlPost(
      xc,
      wrap('XMLFORMPOST', el('REQUEST', 'itemInquiry'), login(xc.userCode, xc.password), el('PARTNUM', partNumber, 'partNumber'), el('LOOKUPTYPE', lookupType), el('QUANTITY', quantity)),
    );
    return { item: mapItemInquiry(root) ?? null };
  },
};

const orderStatus: ToolDef = {
  tier: 'read',
  tool: {
    name: 'dandh_xml_get_order_status',
    description:
      `Order status (XML) by PO number, D&H order number and/or invoice number (up to ${XML_STATUS_MAX} lookups in total). Returns milestones, backordered quantities with ETAs, invoice totals, and packages with tracking and serial numbers. Backordered items can spawn extra order numbers.`,
    inputSchema: schema({
      poNumbers: stringList('Your PO numbers (max 50 characters each).', XML_STATUS_MAX, 50),
      orderNumbers: stringList('D&H order numbers.', XML_STATUS_MAX, 50),
      invoiceNumbers: stringList('D&H invoice numbers.', XML_STATUS_MAX, 50),
    }),
    annotations: READ_ONLY,
  },
  handler: async (args: ToolArgs, creds) => {
    const xc = requireXml(creds, 'dandh_xml_get_order_status', 'dandh_list_order_tracking');
    const po = strList(args.poNumbers, 'poNumbers', XML_STATUS_MAX, 50);
    const on = strList(args.orderNumbers, 'orderNumbers', XML_STATUS_MAX, 50);
    const inv = strList(args.invoiceNumbers, 'invoiceNumbers', XML_STATUS_MAX, 50);
    const total = po.length + on.length + inv.length;
    if (total === 0) throw new ArgumentError('Provide at least one of poNumbers, orderNumbers, invoiceNumbers.');
    if (total > XML_STATUS_MAX) throw new ArgumentError(`Too many lookups: ${total} (maximum ${XML_STATUS_MAX} per request).`);
    const requests = [
      ...po.map((v) => wrap('STATUSREQUEST', el('PONUM', v, 'poNumbers'))),
      ...on.map((v) => wrap('STATUSREQUEST', el('ORDERNUM', v, 'orderNumbers'))),
      ...inv.map((v) => wrap('STATUSREQUEST', el('INVOICE', v, 'invoiceNumbers'))),
    ];
    const root = await xmlPost(xc, wrap('XMLFORMPOST', el('REQUEST', 'orderStatus'), login(xc.userCode, xc.password), ...requests));
    return { orders: mapOrderStatus(root) };
  },
};

export const XML_TOOLS: readonly ToolDef[] = [priceAvailability, itemInquiry, orderStatus];
