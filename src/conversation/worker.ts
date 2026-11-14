import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../db/index.js';
import { ConversationError } from './types.js';
export interface WorkerGuard { readonly token: string; readonly signal: AbortSignal; assertActive(): Promise<void> }
const LOCK = 'galaxy_neegy_conversation_worker';
/** Dedicated database session owns a single worker lock. No expiry/lease takeover timer. */
export class PostgresWorkerGuard implements WorkerGuard {
  readonly token = randomUUID();
  private client: PoolClient | null = null; private active = false; private starting = false;
  private probes: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  constructor(private readonly database: Database) {}
  async start(): Promise<boolean> {
    if (this.active || this.starting || this.signal.aborted) return false;
    this.starting = true; let client: PoolClient | undefined;
    try {
      client = await this.database.pool.connect();
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[LOCK]);
      if (!result.rows[0].acquired) { client.release(); return false; }
      if (this.signal.aborted) { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[LOCK]); client.release(true); return false; }
      await client.query("INSERT INTO worker_ownership(name,token) VALUES('conversation',$1) ON CONFLICT(name) DO UPDATE SET token=EXCLUDED.token",[this.token]);
      if (this.signal.aborted) { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[LOCK]); client.release(true); return false; }
      this.client = client; this.active = true;
      const lost = () => { this.active = false; this.controller.abort(); };
      client.on('error',lost); client.on('end',lost); return true;
    } catch { client?.release(true); throw new ConversationError('worker_unavailable'); }
    finally { this.starting = false; }
  }
  async assertActive(): Promise<void> {
    const check = this.probes.then(async () => {
      if (!this.active || !this.client || this.signal.aborted) throw new ConversationError('worker_unavailable');
      try { const q = await this.client.query("SELECT token FROM worker_ownership WHERE name='conversation'"); if (!this.active || this.signal.aborted || q.rows[0]?.token !== this.token) throw new Error(); }
      catch { this.active = false; this.controller.abort(); throw new ConversationError('worker_unavailable'); }
    });
    this.probes = check.catch(() => undefined); return check;
  }
  async stop(): Promise<void> {
    this.active = false; this.controller.abort(); const client = this.client; this.client = null;
    await this.probes;
    if (client) { try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[LOCK]); } catch { /* Destroying the dedicated connection releases its lock. */ } finally { client.release(true); } }
  }
}
