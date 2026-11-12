import { createHmac } from 'node:crypto';
import { request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCredentials } from '../credentials.js';
import { resetGatewayLock } from '../config.js';
import { resolveHttpConfig, s2sSecretProblem, startHttpServer, StartupError, type HttpConfig } from '../http.js';
import { clearTokenCache } from '../rest-client.js';
import { resetToolsets } from '../tools/index.js';
import {
  API_ORIGIN,
  AUTH_ORIGIN,
  BASE_PATH,
  FAKE_CLIENT_SECRET,
  FAKE_ENV_CLIENT_SECRET,
  FAKE_ENV_XML_PASSWORD,
  FAKE_S2S_SECRET,
  FAKE_TOKEN,
  FAKE_XML_PASSWORD,
  GATEWAY_HEADERS,
  REST_ENV,
  jsonResponse,
  setEnv,
  tokenResponse,
  xmlResponse,
} from './helpers.js';

const OTHER_KEYS = ['CONDUIT_S2S_SECRET', 'MCP_ALLOW_INSECURE_DEV', 'MCP_HTTP_HOST', 'MCP_HTTP_PORT', 'MCP_ALLOWED_HOSTS'];
const saved = new Map(OTHER_KEYS.map((k) => [k, process.env[k]]));
const servers: Server[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  setEnv();
  for (const k of OTHER_KEYS) delete process.env[k];
  clearTokenCache();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetGatewayLock();
  resetToolsets();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function mint(secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`t=${t}`).digest('hex')}`;
}

async function listen(overrides: Partial<HttpConfig> = {}): Promise<number> {
  const config: HttpConfig = { s2sSecret: FAKE_S2S_SECRET, host: '127.0.0.1', port: 0, authMode: 'gateway', allowedHosts: null, ...overrides };
  const server = await startHttpServer(config);
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const callItem = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dandh_get_item', arguments: { itemId: 'ABC' } } });

function post(port: number, body: string, headers: Record<string, string> = {}, path = '/mcp') {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });
}

/** Loopback traffic goes to the real fetch (the server under test); D&H traffic is recorded and mocked. */
function stubDandhOnly() {
  const upstream: Array<{ url: string; clientSecret?: string | null; authorization?: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      if (url.origin === AUTH_ORIGIN) {
        upstream.push({ url: url.href, clientSecret: new URLSearchParams(String(init?.body)).get('client_secret') });
        return tokenResponse();
      }
      upstream.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });
      return jsonResponse({ itemId: 'ABC', description: 'Contoso widget' });
    }),
  );
  return upstream;
}

type RpcResult = { result: { tools?: Array<{ name: string; annotations?: Record<string, unknown> }>; content?: Array<{ text: string }>; isError?: boolean } };

describe('resolveHttpConfig (startup fails closed)', () => {
  it('refuses an empty S2S secret (the container default)', () => {
    expect(() => resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '8080', MCP_HTTP_HOST: '0.0.0.0', AUTH_MODE: 'gateway', DANDH_TOOL_TIERS: 'read' })).toThrow(
      /CONDUIT_S2S_SECRET is empty/,
    );
  });

  it.each([
    ['changeme', /placeholder/],
    ['replace-with-a-real-secret-0123456789abcdef', /placeholder/],
    ['unknown', /shorter than 32/],
    ['short-but-random-Xy7', /shorter than 32/],
    ['a'.repeat(64), /repeated/],
    ['abcd'.repeat(10), /repeated/],
  ])('refuses weak secret %j', (secret, why) => {
    expect(s2sSecretProblem(secret)).toMatch(why);
    expect(() => resolveHttpConfig({ CONDUIT_S2S_SECRET: secret, AUTH_MODE: 'gateway' })).toThrow(StartupError);
  });

  it('accepts a strong secret and defaults to 127.0.0.1:8080', () => {
    expect(resolveHttpConfig({ CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: 'gateway' })).toMatchObject({ host: '127.0.0.1', port: 8080, authMode: 'gateway' });
  });

  it('insecure dev mode binds loopback only and still refuses a placeholder', () => {
    expect(resolveHttpConfig({ MCP_ALLOW_INSECURE_DEV: '1', MCP_HTTP_HOST: '0.0.0.0', AUTH_MODE: 'gateway' })).toMatchObject({ host: '127.0.0.1', s2sSecret: '' });
    expect(() => resolveHttpConfig({ MCP_ALLOW_INSECURE_DEV: '1', CONDUIT_S2S_SECRET: 'changeme' })).toThrow(StartupError);
  });

  it('env mode requires a complete credential set; a startup error never echoes a secret', () => {
    const base = { CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, AUTH_MODE: 'env' };
    expect(() => resolveHttpConfig(base)).toThrow(/AUTH_MODE=env requires/);
    expect(() => resolveHttpConfig({ ...base, ...REST_ENV })).not.toThrow();
    try {
      resolveHttpConfig({ ...base, DANDH_CLIENT_SECRET: FAKE_CLIENT_SECRET });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/Incomplete D&H REST credential set/);
      expect((err as Error).message).not.toContain(FAKE_CLIENT_SECRET);
    }
  });

  it.each([
    [{ AUTH_MODE: 'gatway' }, /AUTH_MODE/],
    [{ AUTH_MODE: 'gateway', DANDH_ENVIRONMENT: 'staging' }, /DANDH_ENVIRONMENT/],
    [{ AUTH_MODE: 'gateway', DANDH_TOOL_TIERS: 'write' }, /DANDH_TOOL_TIERS/],
  ])('rejects bad settings %j', (env, re) => {
    expect(() => resolveHttpConfig({ CONDUIT_S2S_SECRET: FAKE_S2S_SECRET, ...env })).toThrow(re);
  });
});

describe('HTTP transport', () => {
  const signed = () => ({ ...GATEWAY_HEADERS, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) });

  it('/health is open and reveals no credentials', async () => {
    setEnv(REST_ENV);
    const port = await listen();
    const res = await realFetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ status: 'ok', mode: 'gateway' });
    expect(body).not.toContain(FAKE_CLIENT_SECRET);
  });

  it.each(['//', '///', 'http://['])('answers the request target %j with 404 and keeps serving, with no credentials sent', async (target) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const port = await listen();
      const status = await new Promise<number>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (c: string) => (text += c));
        socket.on('error', reject);
        socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)));
      });
      expect([400, 404]).toContain(status);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
      expect((await realFetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects /mcp without a valid S2S header', async () => {
    const port = await listen();
    expect((await post(port, listTools, GATEWAY_HEADERS)).status).toBe(401);
    expect((await post(port, listTools, { ...GATEWAY_HEADERS, 'x-gateway-s2s': mint('wrong-secret-wrong-secret-wrong-secret') })).status).toBe(401);
    expect((await post(port, listTools, { ...GATEWAY_HEADERS, 'x-gateway-s2s': mint(FAKE_S2S_SECRET, Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
  });

  it('rejects non-POST methods and oversized bodies', async () => {
    const port = await listen();
    expect((await realFetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', headers: { 'x-gateway-s2s': mint(FAKE_S2S_SECRET) } })).status).toBe(405);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1024 * 1024) } });
    const outcome = await post(port, big, signed()).then(
      (res) => res.status,
      (err: Error & { cause?: { code?: string } }) => err.cause?.code,
    );
    expect([413, 'EPIPE', 'ECONNRESET']).toContain(outcome);
  });

  it('gateway mode: no credential headers is 401 even when DANDH_* env is set, and nothing goes upstream', async () => {
    setEnv({ ...REST_ENV, DANDH_CLIENT_SECRET: FAKE_ENV_CLIENT_SECRET });
    const upstream = stubDandhOnly();
    const port = await listen();
    const res = await post(port, callItem, { 'x-gateway-s2s': mint(FAKE_S2S_SECRET) });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/missing required gateway credential headers/);
    expect(upstream).toEqual([]);
  });

  it('gateway mode: a partial header set is 401 naming the missing headers, never their values', async () => {
    const port = await listen();
    const res = await post(port, listTools, { 'x-gateway-s2s': mint(FAKE_S2S_SECRET), 'x-dandh-client-secret': FAKE_CLIENT_SECRET });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toMatch(/X-DandH-Client-Id/);
    expect(text).not.toContain(FAKE_CLIENT_SECRET);
  });

  it('gateway mode: tools/list returns 14 read-only tools; a call uses the header credentials and ignores env', async () => {
    setEnv({ ...REST_ENV, DANDH_CLIENT_SECRET: FAKE_ENV_CLIENT_SECRET, DANDH_XML_PASSWORD: FAKE_ENV_XML_PASSWORD, AUTH_MODE: 'gateway' });
    const upstream = stubDandhOnly();
    const port = await listen();

    const list = (await (await post(port, listTools, signed())).json()) as RpcResult;
    expect(list.result.tools).toHaveLength(14);
    expect(list.result.tools!.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);

    const res = (await (await post(port, callItem, signed())).json()) as RpcResult;
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content?.[0].text).toContain('Contoso widget');
    expect(upstream).toEqual([
      { url: `${AUTH_ORIGIN}/api/oauth/token`, clientSecret: FAKE_CLIENT_SECRET },
      { url: `${API_ORIGIN}${BASE_PATH}/items/ABC`, authorization: `Bearer ${FAKE_TOKEN}` },
    ]);
  });

  it('gateway mode: a credential header sent twice is 401 naming it, and nothing goes upstream', async () => {
    const upstream = stubDandhOnly();
    const port = await listen();
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST' }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      for (const [k, v] of Object.entries({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...signed() })) req.setHeader(k, v);
      req.setHeader('x-dandh-client-id', ['tenant-a', 'tenant-b']);
      req.on('error', reject);
      req.end(callItem);
    });
    expect(status).toBe(401);
    expect(body).toMatch(/X-DandH-Client-Id was sent more than once/);
    expect(upstream).toEqual([]);
  });

  it('gateway mode: concurrent requests from different tenants never mix credentials or responses', async () => {
    const tenants = [1, 2, 3, 4].map((i) => ({
      clientId: `tenant-${i}-client`,
      account: String(i).repeat(10),
      xmlUser: `tenant-${i}-xml`,
      headers: {
        'x-dandh-client-id': `tenant-${i}-client`,
        'x-dandh-client-secret': `${FAKE_CLIENT_SECRET}-${i}`,
        'x-dandh-account-number': String(i).repeat(10),
        'x-dandh-xml-user-code': `tenant-${i}-xml`,
        'x-dandh-xml-password': `${FAKE_XML_PASSWORD}-${i}`,
      },
    }));
    const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 20));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === '127.0.0.1') return realFetch(input, init);
        await jitter();
        const form = new URLSearchParams(String(init?.body ?? ''));
        if (url.origin === AUTH_ORIGIN) return jsonResponse({ access_token: `token-of-${form.get('client_id')}`, expires_in: 3600 });
        if (url.origin === API_ORIGIN) {
          const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer token-of-', '');
          return jsonResponse({ marker: `${bearer}|${url.pathname.split('/')[4]}` });
        }
        const user = /<USERID>([^<]*)<\/USERID>/.exec(form.get('xmlDoc') ?? '')?.[1];
        return xmlResponse(`<XMLRESPONSE><ITEM><PARTNUM>${user}</PARTNUM><DESCRIPTION>${user}</DESCRIPTION></ITEM><STATUS>success</STATUS></XMLRESPONSE>`);
      }),
    );
    const port = await listen();
    const xmlCall = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dandh_xml_item_inquiry', arguments: { partNumber: 'A' } } });

    const jobs = Array.from({ length: 40 }, (_, n) => {
      const t = tenants[n % tenants.length];
      const xml = n % 2 === 1;
      return post(port, xml ? xmlCall : callItem, { ...t.headers, 'x-gateway-s2s': mint(FAKE_S2S_SECRET) })
        .then((res) => res.json() as Promise<RpcResult>)
        .then((rpc) => ({ t, xml, text: rpc.result.content?.[0].text ?? '' }));
    });
    for (const { t, xml, text } of await Promise.all(jobs)) {
      expect(text).toContain(xml ? t.xmlUser : `${t.clientId}|${t.account}`);
      for (const other of tenants.filter((o) => o !== t)) expect(text).not.toContain(`tenant-${other.clientId.split('-')[1]}-`);
    }
  });

  it('starting in gateway mode locks the process out of env credentials', async () => {
    await listen();
    setEnv(REST_ENV);
    expect(() => resolveCredentials()).toThrow(/X-DandH-\* headers/);
  });

  describe('X-Conduit-Tool-Tiers (reduce-only)', () => {
    async function listWith(port: number, extra: Record<string, string>): Promise<string[]> {
      const res = await post(port, listTools, { ...signed(), ...extra });
      expect(res.status).toBe(200);
      return ((await res.json()) as RpcResult).result.tools!.map((t) => t.name);
    }

    it('absent header or "read" exposes all 14 read tools', async () => {
      const port = await listen();
      expect(await listWith(port, {})).toHaveLength(14);
      expect(await listWith(port, { 'x-conduit-tool-tiers': 'read' })).toHaveLength(14);
      expect(await listWith(port, { 'x-conduit-tool-tiers': 'READ, write, admin' })).toHaveLength(14);
    });

    it('an empty or non-read header exposes zero tools and blocks calls', async () => {
      const upstream = stubDandhOnly();
      const port = await listen();
      expect(await listWith(port, { 'x-conduit-tool-tiers': '' })).toEqual([]);
      expect(await listWith(port, { 'x-conduit-tool-tiers': 'write,admin' })).toEqual([]);
      const res = (await (await post(port, callItem, { ...signed(), 'x-conduit-tool-tiers': '' })).json()) as RpcResult;
      expect(res.result.isError).toBe(true);
      expect(res.result.content?.[0].text).toBe('Error: Unknown tool: dandh_get_item');
      expect(upstream).toEqual([]);
    });
  });
});
