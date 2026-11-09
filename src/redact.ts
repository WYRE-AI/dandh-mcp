/**
 * Output hygiene for anything returned to the model or written to logs.
 * Order matters: redact first, then truncate, so a secret straddling the
 * truncation boundary can never survive as a partial prefix.
 */

export const REDACTED = '[REDACTED]';

/** Normalized (lower-case, no `_`/`-`) key names whose string values are credentials. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'password',
  'secret',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'xmlpassword',
  'dropshippw',
  'cookie',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/** Recursively replaces string values under credential-named keys. Returns a new value; the input is not mutated. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && typeof v === 'string' && v.length > 0 ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/<(PASSWORD|DROPSHIPPW)>[\s\S]*?<\/\1>/gi, `<$1>${REDACTED}</$1>`],
  [/\b(client_secret|password|access_token|xmlDoc)=[^&\s"']*/gi, `$1=${REDACTED}`],
];

/** Shorter known secrets are not replaced literally: they would mangle ordinary text. Patterns still apply. */
const MIN_LITERAL_SECRET = 4;

/** Pattern-based redaction plus exact removal of any secrets known for this request. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  const secrets = knownSecrets.filter((s): s is string => !!s && s.length >= MIN_LITERAL_SECRET).sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated: ${omitted} more characters omitted. Narrow the query (fewer items, a smaller pageSize).]`;
}

/** Serializes, redacts, then truncates. The single exit path for tool output. */
export function renderSafe(value: unknown, maxChars: number, knownSecrets: readonly (string | undefined)[] = []): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(redactValue(value)) ?? 'null');
  return truncate(redactText(text, knownSecrets), maxChars);
}
