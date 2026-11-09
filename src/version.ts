import { readFileSync } from 'node:fs';

/** Read from package.json at runtime so the user-agent follows semantic-release version bumps. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
