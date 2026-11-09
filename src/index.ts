import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dandhEnvironment } from './config.js';
import { createServer } from './server.js';
import { getDefaultToolset, type Toolset } from './tools/index.js';
import { logger } from './utils/logger.js';

let toolset: Toolset;
try {
  // Bad deployment settings stop the server here, not mid-call. Credentials are read per call.
  dandhEnvironment();
  toolset = getDefaultToolset();
} catch (err) {
  logger.error('Invalid configuration', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const server = createServer(toolset);
await server.connect(new StdioServerTransport());
logger.info('D&H MCP server started (stdio)', { tiers: [...toolset.tiers], tools: toolset.tools.length });
