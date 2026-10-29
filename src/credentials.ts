import { AsyncLocalStorage } from 'node:async_hooks';
import { credentialsFromEnv } from './config.js';
import type { DandhCredentials } from './types.js';

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials(); getCredentials() reads from it and,
// when a scope exists, never falls back to process.env (CWE-306). Outside a
// scope (stdio / single-tenant) it reads DANDH_* from process.env.
const credStore = new AsyncLocalStorage<DandhCredentials>();

export function runWithCredentials<T>(creds: DandhCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

/** Throws ConfigError on a partial/invalid env credential set. May return a set with neither service configured. */
export function getCredentials(): DandhCredentials {
  return credStore.getStore() ?? credentialsFromEnv();
}
