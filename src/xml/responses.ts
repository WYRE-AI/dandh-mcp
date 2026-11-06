import { child, childrenOf, textOf, type XmlNode } from './parse.js';

export interface BranchQty {
  branch?: string;
  quantity: number | null;
  inStockDate?: string;
}

export interface PriceAvailabilityItem {
  partNumber?: string;
  unitPrice?: number | null;
  branches?: BranchQty[];
  totalQuantity?: number | null;
  /** Item-level failure message (e.g. unknown part number). */
  message?: string;
}

/** "$39.72", "1,234.50", "6.63" -> number; anything else -> null. */
export function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.replace(/[$,\s]/g, ''));
  return raw.trim() !== '' && Number.isFinite(n) ? n : null;
}

function parseIntSafe(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.replace(/,/g, ''));
  return raw.trim() !== '' && Number.isFinite(n) ? n : null;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === 'y') return true;
  if (v === 'false' || v === 'no' || v === 'n') return false;
  return undefined;
}

function branchQtys(item: XmlNode): BranchQty[] | undefined {
  const rows = childrenOf(item, 'BRANCHQTY');
  if (rows.length === 0) return undefined;
  return rows.map((b) => ({
    branch: textOf(b, 'BRANCH'),
    quantity: parseIntSafe(textOf(b, 'QTY')),
    inStockDate: textOf(b, 'INSTOCKDATE'),
  }));
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function mapPriceAvailability(root: XmlNode): PriceAvailabilityItem[] {
  return childrenOf(root, 'ITEM').map((item) =>
    compact({
      partNumber: textOf(item, 'PARTNUM'),
      unitPrice: child(item, 'UNITPRICE') ? parseMoney(textOf(item, 'UNITPRICE')) : undefined,
      branches: branchQtys(item),
      totalQuantity: child(item, 'TOTALQTY') ? parseIntSafe(textOf(item, 'TOTALQTY')) : undefined,
      message: textOf(item, 'MESSAGE'),
    }),
  );
}

export function mapItemInquiry(root: XmlNode) {
  const item = child(root, 'ITEM');
  if (!item) return undefined;
  return compact({
    partNumber: textOf(item, 'PARTNUM'),
    unitPrice: parseMoney(textOf(item, 'UNITPRICE')),
    itemNumber: textOf(item, 'ITEMNO'),
    vendorItemNumber: textOf(item, 'VENDORITEMNO'),
    description: textOf(item, 'DESCRIPTION'),
    vendorName: textOf(item, 'VENDORDESCR'),
    estimatedRetailPrice: parseMoney(textOf(item, 'ERP')),
    rebateValue: parseMoney(textOf(item, 'REBATEVALUE')),
    rebateEndDate: textOf(item, 'REBATEENDDATE'),
    isNonStock: parseBool(textOf(item, 'ISNONSTOCK')),
    isFactoryDirect: parseBool(textOf(item, 'ISFACTORYDIRECT')),
    freeFreight: parseBool(textOf(item, 'FREEFRT')),
    restricted: parseBool(textOf(item, 'RESTRICTED')),
    branches: branchQtys(item),
    totalQuantity: child(item, 'TOTALQTY') ? parseIntSafe(textOf(item, 'TOTALQTY')) : undefined,
  });
}

function address(node: XmlNode | undefined) {
  if (!node) return undefined;
  return compact({
    name: textOf(node, 'NAME'),
    address: textOf(node, 'ADDRESS'),
    address2: textOf(node, 'ADDRESS2'),
    city: textOf(node, 'CITY'),
    state: textOf(node, 'STATE'),
    zip: textOf(node, 'ZIP'),
  });
}

export function mapOrderStatus(root: XmlNode) {
  return childrenOf(root, 'ORDERSTATUS').map((o) => {
    const total = child(o, 'INVTOTAL');
    return compact({
      date: textOf(o, 'DATE'),
      branch: textOf(o, 'BRANCH'),
      poNumber: textOf(o, 'PONUM'),
      orderNumber: textOf(o, 'ORDERNUM'),
      /** "In Process" until invoiced, per the D&H spec. */
      invoice: textOf(o, 'INVOICE'),
      invoiceTotal: total
        ? compact({
            total: parseMoney(total.text),
            subTotal: parseMoney(total.attrs.SubTotal),
            tax: parseMoney(total.attrs.Tax),
            environmentalHandling: parseMoney(total.attrs.EHF),
            freight: parseMoney(total.attrs.Freight),
            handling: parseMoney(total.attrs.Handling),
          })
        : undefined,
      /** Order milestone, e.g. Shipped / Backordered / In-Process / Cancelled. */
      milestone: textOf(o, 'MESSAGE'),
      soldTo: address(child(o, 'SOLDTO')),
      shipTo: address(child(o, 'SHIPTO')),
      items: childrenOf(child(o, 'ORDERDETAIL'), 'DETAILITEM').map((d) =>
        compact({
          itemNumber: textOf(d, 'ITEMNO'),
          price: parseMoney(textOf(d, 'PRICE')),
          quantity: parseIntSafe(textOf(d, 'QUANTITY')),
          quantityBackordered: parseIntSafe(textOf(d, 'QTYBO')),
          eta: textOf(d, 'ETA'),
          vendor: textOf(d, 'VENDOR'),
          description: textOf(d, 'DESCRIPTION'),
        }),
      ),
      packages: childrenOf(o, 'PACKAGE').map((p) =>
        compact({
          carrier: textOf(p, 'CARRIER'),
          service: textOf(p, 'SERVICE'),
          trackingNumber: textOf(p, 'TRACKNUM'),
          dateShipped: textOf(p, 'DATESHIPPED'),
          shipped: parseBool(textOf(p, 'SHIPPED')),
          items: childrenOf(p, 'SHIPITEM').map((s) =>
            compact({ itemNumber: textOf(s, 'SHIPITEMNO'), serialNumber: textOf(s, 'SERIALNO') }),
          ),
        }),
      ),
    });
  });
}
