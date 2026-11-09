import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TIERS, maxResponseChars, parseToolTiers, TOOL_TIERS_ENV, type ToolTier } from '../config.js';
import { resolveCredentials } from '../credentials.js';
import { runWithAbortSignal } from '../fetch-util.js';
import { renderSafe } from '../redact.js';
import { ArgumentError, CredentialError, DandhApiError, type DandhCredentials } from '../types.js';
import { logger } from '../utils/logger.js';
import { REST_TOOLS } from './rest.js';
import type { CallToolResult, ToolArgs, ToolDef } from './types.js';
import { XML_TOOLS } from './xml.js';

/** Every tool this server knows, in tools/list order. Tier filtering happens in buildToolset. */
export const ALL_TOOL_DEFS: readonly ToolDef[] = [...REST_TOOLS, ...XML_TOOLS];

export interface Toolset {
  tiers: ReadonlySet<ToolTier>;
  tools: Tool[];
  dispatch: (name: string, args: unknown, signal?: AbortSignal) => Promise<CallToolResult>;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Keeps only arguments declared in the tool's input schema; anything else never reaches a handler or D&H. */
export function pickDeclaredArgs(tool: Tool, args: unknown): ToolArgs {
  const declared = Object.keys(tool.inputSchema.properties ?? {});
  const source = args && typeof args === 'object' && !Array.isArray(args) ? (args as ToolArgs) : {};
  const out: ToolArgs = {};
  for (const key of declared) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

const KNOWN_ERRORS = [ArgumentError, CredentialError, DandhApiError];

/** Only messages this server wrote are shown; anything unexpected becomes a generic message (and is logged redacted). */
function describeError(err: unknown): string {
  if (KNOWN_ERRORS.some((E) => err instanceof E)) return (err as Error).message;
  return 'Unexpected internal error while calling D&H.';
}

function secretsOf(creds: DandhCredentials | undefined): string[] {
  return [creds?.rest?.clientSecret, creds?.xml?.password].filter((s): s is string => !!s);
}

export function buildToolset(tiers: ReadonlySet<ToolTier>): Toolset {
  const enabled = ALL_TOOL_DEFS.filter((d) => tiers.has(d.tier));
  const byName = new Map(enabled.map((d) => [d.tool.name, d]));
  const tools = enabled.map((d) => d.tool);

  async function dispatch(name: string, rawArgs: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const def = byName.get(name);
    if (!def || !tiers.has(def.tier)) return errorResult(`Unknown tool: ${name}`);

    const started = Date.now();
    let creds: DandhCredentials | undefined;
    try {
      creds = resolveCredentials();
      const resolved = creds;
      const value = await runWithAbortSignal(signal, () => def.handler(pickDeclaredArgs(def.tool, rawArgs), resolved));
      logger.info('Tool call succeeded', { tool: name, ms: Date.now() - started });
      return { content: [{ type: 'text', text: renderSafe(value, maxResponseChars(), secretsOf(creds)) }] };
    } catch (err) {
      logger.warn('Tool call failed', {
        tool: name,
        ms: Date.now() - started,
        status: err instanceof DandhApiError ? err.status : undefined,
        requestId: err instanceof DandhApiError ? err.requestId : undefined,
        errorType: err instanceof Error ? err.constructor.name : typeof err,
      });
      if (!KNOWN_ERRORS.some((E) => err instanceof E)) {
        logger.error('Unexpected tool error', { tool: name, error: renderSafe(String(err), 500, secretsOf(creds)) });
      }
      return errorResult(renderSafe(describeError(err), 4000, secretsOf(creds)));
    }
  }

  return { tiers, tools, dispatch };
}

let defaultToolset: Toolset | undefined;
const toolsetCache = new Map<string, Toolset>();

/** Toolset for this process, from DANDH_TOOL_TIERS. Built once so tools/list is stable. */
export function getDefaultToolset(): Toolset {
  defaultToolset ??= buildToolset(parseToolTiers(process.env[TOOL_TIERS_ENV]));
  return defaultToolset;
}

/**
 * Toolset for a per-request tier set (already narrowed by the caller). Tiers
 * outside the process configuration are dropped here as well, so this can
 * never widen the surface.
 */
export function toolsetForTiers(requested: ReadonlySet<ToolTier>): Toolset {
  const base = getDefaultToolset();
  const tiers = ALL_TIERS.filter((t) => base.tiers.has(t) && requested.has(t));
  if (tiers.length === base.tiers.size) return base;
  const key = tiers.join(',');
  let toolset = toolsetCache.get(key);
  if (!toolset) {
    toolset = buildToolset(new Set(tiers));
    toolsetCache.set(key, toolset);
  }
  return toolset;
}

/** Test-only. */
export function resetToolsets(): void {
  defaultToolset = undefined;
  toolsetCache.clear();
}
