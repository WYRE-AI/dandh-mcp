import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDefaultToolset, type Toolset } from './tools/index.js';
import { VERSION } from './version.js';

export function createServer(toolset: Toolset = getDefaultToolset()): Server {
  const server = new Server({ name: 'dandh-mcp', version: VERSION }, { capabilities: { tools: {}, logging: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolset.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    toolset.dispatch(request.params.name, request.params.arguments ?? {}, extra.signal),
  );

  return server;
}
