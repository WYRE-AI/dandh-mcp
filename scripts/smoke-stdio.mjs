#!/usr/bin/env node
// Spawns the built stdio server (dist/index.js) and checks the tool surface
// plus argument and credential handling. Makes no network call: every tool
// call here must be refused before any request to D&H. Upstream round-trips
// are covered by the mocked tests in src/__tests__.
// Usage: npm run build && npm run smoke
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SECRET = 'dandh-smoke-client-secret-not-real-0000';

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

function fail(message) {
  console.error(`smoke-stdio: FAIL - ${message}`);
  process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    PATH: process.env.PATH ?? '',
    LOG_LEVEL: 'error',
    DANDH_CLIENT_ID: 'dandh-smoke-client-id',
    DANDH_CLIENT_SECRET: SECRET,
    DANDH_ACCOUNT_NUMBER: '1234567890',
  },
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (tools.length !== EXPECTED.length) fail(`expected ${EXPECTED.length} tools, got ${tools.length}`);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`tool names differ: ${names.join(', ')}`);
  if (!tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)) fail('a tool is not annotated read-only');

  const traversal = await client.callTool({ name: 'dandh_get_item', arguments: { itemId: '../salesOrders' } });
  const text = traversal.content?.[0]?.text ?? '';
  if (!traversal.isError || !/itemId/.test(text)) fail(`path traversal was not refused: ${text.slice(0, 200)}`);

  const noXml = await client.callTool({ name: 'dandh_xml_item_inquiry', arguments: { partNumber: 'A' } });
  const noXmlText = noXml.content?.[0]?.text ?? '';
  if (!noXml.isError || !/XML service is not configured/.test(noXmlText)) fail(`missing XML credentials not reported: ${noXmlText.slice(0, 200)}`);
  if (noXmlText.includes(SECRET)) fail('secret leaked into tool output');

  for (const name of ['dandh_create_sales_order', 'dandh_xml_create_order']) {
    const removed = await client.callTool({ name, arguments: { confirm: true } });
    if (!removed.isError) fail(`${name} did not error`);
  }

  if (!process.exitCode) console.log(`smoke-stdio: OK (${tools.length} read-only tools; traversal and missing credentials refused without a network call; order tools absent)`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await client.close().catch(() => {});
}
