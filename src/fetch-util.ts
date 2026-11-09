/**
 * The request contract shared by every call to D&H (REST, OAuth, XML):
 * redirect: "manual" and every 3xx is an error; a timeout plus the MCP
 * caller's cancellation signal; response bodies bounded while streaming;
 * vendor request ids kept for error messages.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestTimeoutMs } from './config.js';
import { DandhApiError } from './types.js';
import { VERSION } from './version.js';

export const USER_AGENT = `dandh-mcp/${VERSION}`;

const callerSignal = new AsyncLocalStorage<AbortSignal>();

/** Runs fn with the MCP request's cancellation signal, so upstream calls abort when the client cancels or disconnects. */
export function runWithAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? callerSignal.run(signal, fn) : fn();
}

function requestSignal(): AbortSignal {
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const caller = callerSignal.getStore();
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

/**
 * Response headers that may carry a vendor request id, most specific first.
 * x-correlationid is the header D&H's API gateway returned to live probes of
 * api.dandh.com on 2026-11-09 (the id D&H support asks for); cf-ray is
 * Cloudflare's, which fronts the dandh.com API and auth hosts.
 */
const REQUEST_ID_HEADERS = ['x-correlationid', 'x-request-id', 'x-correlation-id', 'request-id', 'cf-ray'];

export function requestIdOf(res: Response): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = res.headers.get(name)?.trim();
    if (value) return value.slice(0, 128);
  }
  return undefined;
}

export function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request id: ${requestId})` : message;
}

/**
 * fetch with the shared contract. `service` names the D&H endpoint in
 * errors. Network failures and redirects become DandhApiError; any other
 * status is returned for the caller to map.
 */
export async function dandhFetch(url: URL, init: RequestInit & { method: 'GET' | 'POST' }, service: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: requestSignal() });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new DandhApiError(aborted ? `The request to ${service} timed out or was cancelled.` : `Could not reach ${service} (network error).`);
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    await res.body?.cancel().catch(() => undefined);
    const requestId = requestIdOf(res);
    throw new DandhApiError(
      withRequestId(`${service} answered ${init.method} ${url.pathname} with a redirect (HTTP ${res.status}); refusing to follow it.`, requestId),
      res.status,
      requestId,
    );
  }
  return res;
}

/** Reads a response body as text, cancelling the stream as soon as it exceeds maxBytes. */
export async function readBoundedText(res: Response, maxBytes: number, service: string): Promise<string> {
  const tooLarge = () => new DandhApiError(`${service} response exceeded ${maxBytes} bytes; narrow the query (fewer items, a smaller pageSize).`, res.status);
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof DandhApiError) throw err;
    throw new DandhApiError(`Could not read the ${service} response (HTTP ${res.status}).`, res.status);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Drains an error body without letting its size or a stream failure mask the status. */
export async function readErrorBody(res: Response): Promise<string> {
  return readBoundedText(res, 64 * 1024, 'D&H').catch(() => '');
}
