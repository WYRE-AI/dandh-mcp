import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolTier } from '../config.js';
import type { DandhCredentials } from '../types.js';

export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  tier: ToolTier;
  tool: Tool;
  /** Receives only the arguments declared in `tool.inputSchema.properties`. Returns a JSON-serializable value; output is redacted and truncated by the dispatcher. */
  handler: (args: ToolArgs, creds: DandhCredentials) => Promise<unknown>;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
