import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../tools/index.js';

describe('tool list', () => {
  it('names + annotations snapshot', () => {
    expect(ALL_TOOLS.map((t) => ({ name: t.name, annotations: t.annotations }))).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_item",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_search_items",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_price",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_prices_bulk",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_availability",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_availability_bulk",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_price_and_availability",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_price_and_availability_bulk",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_list_carriers",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_get_order_tracking",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_list_order_tracking",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "dandh_create_sales_order",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_xml_get_price_availability",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_xml_item_inquiry",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "name": "dandh_xml_get_order_status",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "readOnlyHint": false,
          },
          "name": "dandh_xml_create_order",
        },
      ]
    `);
  });

  it('write tools carry a loud warning and destructive annotations; reads are read-only', () => {
    const writes = ALL_TOOLS.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writes.map((t) => t.name).sort()).toEqual(['dandh_create_sales_order', 'dandh_xml_create_order']);
    for (const t of writes) {
      expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
      expect(t.description).toMatch(/^WARNING: BY DEFAULT THIS ONLY PREVIEWS THE ORDER\. Set `confirm: true` to place a real, billable purchase order with D&H/);
      expect(t.description).toMatch(/CANNOT be cancelled through the API/);
      expect(t.description).toMatch(/must be unique/);
      expect(t.description).toMatch(/HOLD/);
      expect(t.description).toMatch(/EXPLICIT OK on every line, quantity, branch and shipping choice/);
      const confirm = (t.inputSchema.properties as Record<string, { type: string; description: string }>).confirm;
      expect(confirm).toEqual({ type: 'boolean', description: 'Set to true to place the real, billable order. Leave it out to get a preview only. With true, also pass the confirmToken from the preview.' });
      const confirmToken = (t.inputSchema.properties as Record<string, { type: string; description: string }>).confirmToken;
      expect(confirmToken).toEqual({ type: 'string', description: 'Token from the preview; required with confirm: true so the order placed is the one the user approved.' });
      expect(t.description).toMatch(/To confirm, pass the `confirmToken` from the preview\. /);
    }
    for (const t of ALL_TOOLS.filter((x) => !writes.includes(x))) expect(t.annotations).toEqual({ readOnlyHint: true });
  });

  it('no tool schema offers a per-call accountNumber or company override', () => {
    for (const t of ALL_TOOLS) {
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      expect(props).not.toContain('accountNumber');
      expect(props).not.toContain('company');
    }
  });

  it('every new order parameter has a one-line description', () => {
    for (const name of ['dandh_create_sales_order', 'dandh_xml_create_order']) {
      const t = ALL_TOOLS.find((x) => x.name === name)!;
      const props = t.inputSchema.properties as Record<string, { description?: string }>;
      for (const k of ['confirm', 'poNumber' in props ? 'poNumber' : 'customerPurchaseOrder']) {
        expect(props[k].description).toBeTruthy();
        expect(props[k].description).not.toContain('\n');
      }
    }
  });
});
