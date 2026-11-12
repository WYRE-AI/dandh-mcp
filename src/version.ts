import { readFileSync } from 'node:fs';

/** Read from package.json at runtime. The Dockerfile stamps the release version into package.json (semantic-release's bump is never committed). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
