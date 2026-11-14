import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Database } from '../db/index.js';
/** Read-only check; migrations are always an explicit operator command. */
export async function verifySchema(db: Database,folder: string): Promise<void> {
  const expected = readMigrationFiles({ migrationsFolder: folder }).at(-1)?.hash;
  const actual = (await db.pool.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0]?.hash;
  if (!expected || actual !== expected) throw new Error('schema_unavailable');
}
