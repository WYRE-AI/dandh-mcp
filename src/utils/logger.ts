import { redact, sanitizeForLog } from './redact.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function getConfiguredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (env in LEVELS) ? env as LogLevel : 'info';
}

// Both the message and the context are scrubbed (sensitive keys masked,
// Bearer tokens / PASSWORD tags / credential-bearing URLs removed) so a caller
// that forgets to filter cannot leak a vendor secret into stderr.
function log(level: LogLevel, message: string, context?: unknown): void {
  if (LEVELS[level] < LEVELS[getConfiguredLevel()]) return;
  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} [${level.toUpperCase()}]`;
  const safeMessage = redact(message);
  if (context !== undefined) {
    let contextStr: string;
    const safe = sanitizeForLog(context);
    try { contextStr = JSON.stringify(safe); }
    catch { contextStr = String(safe); }
    console.error(`${prefix} ${safeMessage} ${contextStr}`);
  } else {
    console.error(`${prefix} ${safeMessage}`);
  }
}

export const logger = {
  debug: (msg: string, ctx?: unknown) => log('debug', msg, ctx),
  info: (msg: string, ctx?: unknown) => log('info', msg, ctx),
  warn: (msg: string, ctx?: unknown) => log('warn', msg, ctx),
  error: (msg: string, ctx?: unknown) => log('error', msg, ctx),
};
