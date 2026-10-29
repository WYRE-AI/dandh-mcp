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
      expect(t.description).toMatch(/^WARNING: THIS PLACES A REAL, BILLABLE PURCHASE ORDER WITH D&H\./);
      expect(t.description).toMatch(/CANNOT be cancelled via the API/);
      expect(t.description).toMatch(/must be unique/);
      expect(t.description).toMatch(/HOLD/);
      expect(t.description).toMatch(/EXPLICIT user confirmation/);
    }
    for (const t of ALL_TOOLS.filter((x) => !writes.includes(x))) expect(t.annotations).toEqual({ readOnlyHint: true });
  });
});
