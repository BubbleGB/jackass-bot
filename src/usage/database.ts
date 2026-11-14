import type { PoolClient } from 'pg';
import type { Database } from '../db/index.js';
export class UsageError extends Error { constructor(readonly code: string) { super(code); this.name = 'UsageError'; } }
export async function transaction<T>(database: Database,run: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try { client = await database.pool.connect(); await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
  catch (error) { if (client) await client.query('ROLLBACK').catch(() => undefined); if (error instanceof UsageError) throw error; throw new UsageError('usage_storage_failed'); }
  finally { client?.release(); }
}
export async function guildLock(client: PoolClient,guildId: string): Promise<void> { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[guildId]); }
