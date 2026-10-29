import type { DandhCredentials } from '../types.js';

const REDACTED = '[redacted]';

// Patterns that identify secret material even when we don't hold the exact
// value (e.g. a token echoed back by the vendor).
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const XML_SECRET_TAG_RE = /<(PASSWORD|DROPSHIPPW)>[\s\S]*?<\/\1>/gi;
const FORM_SECRET_RE = /\b(client_secret|password|access_token|xmlDoc)=[^&\s"']*/gi;
const URL_WITH_QUERY_RE = /https?:\/\/[^\s"']+\?[^\s"']*/gi;

/**
 * Removes secrets from free text. `secrets` are the exact values this process
 * holds for the current request; the patterns cover vendor-echoed tokens and
 * credential-bearing request fragments.
 */
export function redact(text: string, secrets: Iterable<string | undefined> = []): string {
  let out = text;
  const list = [...secrets].filter((s): s is string => typeof s === 'string' && s.length > 0);
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) out = out.split(secret).join(REDACTED);
  return out
    .replace(XML_SECRET_TAG_RE, `<$1>${REDACTED}</$1>`)
    .replace(FORM_SECRET_RE, `$1=${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(URL_WITH_QUERY_RE, '[redacted URL]');
}

/** Exact secret values held by a credential set, for use with redact(). */
export function secretsOf(creds: DandhCredentials | null | undefined, extra: string[] = []): string[] {
  const out = [...extra];
  if (creds?.rest) out.push(creds.rest.clientSecret);
  if (creds?.xml) out.push(creds.xml.password);
  return out;
}

const SENSITIVE_KEY_RE = /secret|password|passwd|token|authorization|dropshippw|xmldoc|cookie/i;

/** Deep-copies a log context, masking sensitive keys and scrubbing string values. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) return '[truncated]';
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map((v) => sanitizeForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : sanitizeForLog(v, depth + 1);
  }
  return out;
}
