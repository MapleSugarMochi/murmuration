import { PgStore } from './pg-store.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const store = new PgStore(url);
const applied = await store.migrate();
console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'schema is up to date');
await store.close();
