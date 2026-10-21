import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { PgStore } from './pg-store.ts';
import { MemoryStore, type Store } from './store.ts';

const config = loadConfig();
let store: Store;
if (config.databaseUrl) {
  const pg = new PgStore(config.databaseUrl);
  await pg.migrate();
  store = pg;
} else {
  store = new MemoryStore();
}

const app = await buildApp(config, store);
if (!config.databaseUrl)
  app.fastify.log.warn('DATABASE_URL not set; documents are kept in memory only');

await app.fastify.listen({ host: config.host, port: config.port });

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.fastify.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await app.shutdown();
    process.exit(0);
  } catch (err) {
    app.fastify.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
