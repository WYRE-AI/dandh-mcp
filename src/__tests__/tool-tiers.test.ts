import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, narrowTiers, parseToolTiers } from '../config.js';
import { ALL_TOOL_DEFS, buildToolset, pickDeclaredArgs } from '../tools/index.js';
import { textOf } from './helpers.js';

const EXPECTED = [
  'dandh_get_availability',
  'dandh_get_availability_bulk',
  'dandh_get_item',
  'dandh_get_order_tracking',
  'dandh_get_price',
  'dandh_get_price_and_availability',
  'dandh_get_price_and_availability_bulk',
  'dandh_get_prices_bulk',
  'dandh_list_carriers',
  'dandh_list_order_tracking',
  'dandh_search_items',
  'dandh_xml_get_order_status',
  'dandh_xml_get_price_availability',
  'dandh_xml_item_inquiry',
];

describe('tool tiers', () => {
  it('exposes exactly the 14 researched read endpoints, all read tier, all read-only annotated', () => {
    expect(ALL_TOOL_DEFS.map((d) => d.tool.name).sort()).toEqual(EXPECTED);
    for (const d of ALL_TOOL_DEFS) {
      expect(d.tier, d.tool.name).toBe('read');
      expect(d.tool.annotations, d.tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(d.tool.inputSchema.additionalProperties, d.tool.name).toBe(false);
    }
  });

  it('has no order-placing tool and no tool that mentions placing orders', () => {
    for (const d of ALL_TOOL_DEFS) {
      expect(d.tool.name).not.toMatch(/create|order_entry|submit|place/);
      expect(d.tool.description ?? '').not.toMatch(/create_sales_order|create_order|place an order/i);
    }
  });

  it('defaults to read', () => {
    expect([...DEFAULT_TIERS]).toEqual(['read']);
    expect([...parseToolTiers(undefined)]).toEqual(['read']);
    expect([...parseToolTiers('  ')]).toEqual(['read']);
    expect(buildToolset(parseToolTiers(undefined)).tools).toHaveLength(14);
  });

  it('rejects unknown tier names loudly (there is no write tier)', () => {
    expect(() => parseToolTiers('read,write')).toThrow(/Invalid DANDH_TOOL_TIERS/);
  });

  it('the tier header can only narrow; empty narrows to nothing', () => {
    const configured = parseToolTiers('read');
    expect([...narrowTiers(configured, undefined)]).toEqual(['read']);
    expect([...narrowTiers(configured, 'read,admin')]).toEqual(['read']);
    expect([...narrowTiers(configured, '')]).toEqual([]);
    expect([...narrowTiers(configured, 'write')]).toEqual([]);
    expect(buildToolset(narrowTiers(configured, '')).tools).toEqual([]);
  });

  it('a tool outside the enabled tiers is indistinguishable from an unknown one', async () => {
    const res = await buildToolset(new Set()).dispatch('dandh_get_item', { itemId: 'A' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Error: Unknown tool: dandh_get_item');
  });

  it('removed order tools are unknown', async () => {
    for (const name of ['dandh_create_sales_order', 'dandh_xml_create_order']) {
      const res = await buildToolset(parseToolTiers('read')).dispatch(name, { confirm: true });
      expect(textOf(res)).toBe(`Error: Unknown tool: ${name}`);
    }
  });
});

describe('argument forwarding', () => {
  it('drops undeclared arguments (account, company, host) before the handler runs', () => {
    const tool = ALL_TOOL_DEFS.find((d) => d.tool.name === 'dandh_get_item')!.tool;
    expect(pickDeclaredArgs(tool, { itemId: 'A', accountNumber: '0000000000', company: 'ca', baseUrl: 'https://evil.example.net' })).toEqual({ itemId: 'A' });
    expect(pickDeclaredArgs(tool, ['nope'])).toEqual({});
  });
});
