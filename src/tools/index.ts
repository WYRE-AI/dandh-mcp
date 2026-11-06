import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { REST_TOOLS, handleRestTool } from './rest.js';
import { XML_TOOLS, handleXmlTool } from './xml.js';
import type { CallToolResult } from './types.js';

export const ALL_TOOLS: Tool[] = [...REST_TOOLS, ...XML_TOOLS];

const REST_NAMES = new Set(REST_TOOLS.map((t) => t.name));
const XML_NAMES = new Set(XML_TOOLS.map((t) => t.name));

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (REST_NAMES.has(name)) return handleRestTool(name, args);
  if (XML_NAMES.has(name)) return handleXmlTool(name, args);
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}
