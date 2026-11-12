import { ENV_NAMES, scopedSecrets } from '../credentials.js';
import { redactText, redactValue } from '../redact.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function getConfiguredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return env in LEVELS ? (env as LogLevel) : 'info';
}

/** Logs to stderr (stdout is the stdio transport). Every line is redacted, including the message itself. */
function log(level: LogLevel, message: string, context?: unknown): void {
  if (LEVELS[level] < LEVELS[getConfiguredLevel()]) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  if (context !== undefined) {
    let contextStr: string;
    try {
      contextStr = JSON.stringify(redactValue(context));
    } catch {
      contextStr = String(context);
    }
    line += ` ${contextStr}`;
  }
  // Redact the env secrets (stdio/env mode) and the per-request gateway secrets in scope.
  const envSecrets = [process.env[ENV_NAMES.clientSecret]?.trim(), process.env[ENV_NAMES.xmlPassword]?.trim()];
  console.error(redactText(line, [...envSecrets, ...scopedSecrets()]));
}

export const logger = {
  debug: (msg: string, ctx?: unknown) => log('debug', msg, ctx),
  info: (msg: string, ctx?: unknown) => log('info', msg, ctx),
  warn: (msg: string, ctx?: unknown) => log('warn', msg, ctx),
  error: (msg: string, ctx?: unknown) => log('error', msg, ctx),
};
