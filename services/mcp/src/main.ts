import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
process.umask(0o077);
const app = await createApp(config);
const server = createServer(toNodeHandler(app));
server.listen(config.port, config.host, () => console.log(`flint mcp listening on ${config.host}:${config.port}`));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
