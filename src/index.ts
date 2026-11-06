import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { validateStartupConfig } from './startup.js';
import { logger } from './utils/logger.js';

try {
  validateStartupConfig();
} catch (err) {
  logger.error('Invalid configuration', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('D&H MCP server started (stdio)');
