import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMcpConfig, McpRuntimeError } from './config';
import { startMcpService } from './startup';

// only this executable installs process handlers. importing the factory never starts a listener.
export async function runMcpMain(): Promise<void> {
  try {
    if (process.argv.length !== 2) throw new McpRuntimeError('CONFIG_INVALID');
    process.umask(0o077);
    const service = await startMcpService(loadMcpConfig());
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => {
        process.stderr.write('MCP service could not shut down cleanly.\n'); process.exit(1);
      }, 30_000);
      void service.close().then(() => {
        process.stdout.write('MCP service stopped.\n');
      }, () => {
        process.stderr.write('MCP service could not shut down cleanly.\n'); process.exit(1);
      }).finally(() => {
        clearTimeout(deadline); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      });
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    process.stdout.write('MCP service ready.\n');
  } catch (error) {
    process.stderr.write((error instanceof McpRuntimeError ? error.message : 'MCP service could not start.') + '\n');
    process.exitCode = 1;
  }
}

// bun folds import.meta.main while bundling. compare node's entry path at runtime instead.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runMcpMain();
