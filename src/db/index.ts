import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

/** Creates a lazy pool; callers own close(). Creating it performs no network I/O. */
export function createDatabase(url: string) {
  const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
export type Database = ReturnType<typeof createDatabase>;
