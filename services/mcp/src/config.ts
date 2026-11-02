import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Config = {
  // public https origin that serves /mcp; the mcp resource is `${origin}/mcp`.
  origin: string;
  // the snapback backend the accounts belong to.
  backendUrl: string;
  dataDir: string;
  host: string;
  port: number;
  // signs oauth state and derives the key that encrypts stored snapback sessions.
  secret: string;
};

function origin(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required.`);
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value.replace(/\/+$/, '') || (url.protocol !== 'https:' && !loopback)) {
    throw new Error(`${name} must be a bare https origin.`);
  }
  return url.origin;
}

// systemd LoadCredential places the secret under $CREDENTIALS_DIRECTORY.
function secret(env: NodeJS.ProcessEnv): string {
  const value = env.FLINT_MCP_SECRET ??
    (env.CREDENTIALS_DIRECTORY ? readFileSync(join(env.CREDENTIALS_DIRECTORY, 'flint-mcp-secret'), 'utf8').trim() : '');
  if (value.length < 32) throw new Error('FLINT_MCP_SECRET must be at least 32 characters.');
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.FLINT_MCP_PORT ?? 4413);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('FLINT_MCP_PORT is invalid.');
  if (!env.FLINT_MCP_DATA_DIR) throw new Error('FLINT_MCP_DATA_DIR is required.');
  return {
    origin: origin('FLINT_MCP_ORIGIN', env.FLINT_MCP_ORIGIN),
    backendUrl: origin('FLINT_MCP_BACKEND_URL', env.FLINT_MCP_BACKEND_URL),
    dataDir: env.FLINT_MCP_DATA_DIR,
    host: env.FLINT_MCP_HOST ?? '127.0.0.1',
    port,
    secret: secret(env),
  };
}
