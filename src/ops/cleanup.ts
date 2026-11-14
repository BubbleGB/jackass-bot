import type { PoolClient } from 'pg';
import type { Database } from '../db/index.js';
import type { WorkerGuard } from '../conversation/worker.js';
import type { DiscordTransport } from '../discord/transport.js';
import { discordBounded } from '../discord/transport.js';
import { isSnowflake } from '../access/policy.js';
import { UsageService } from '../usage/service.js';
import { transaction,guildLock,UsageError } from '../usage/database.js';
/** Membership snapshots must be complete and successful before any mutation. */
export class Maintenance {
  constructor(private readonly db: Database,private readonly guard: WorkerGuard,private readonly discord: DiscordTransport,private readonly now: () => Date = () => new Date()) {}
  private async fence(c: PoolClient): Promise<void> {
    if (this.guard.signal.aborted) throw new UsageError('worker_unavailable');
    const row = (await c.query("SELECT token FROM worker_ownership WHERE name='conversation' FOR SHARE")).rows[0];
    if (row?.token !== this.guard.token) throw new UsageError('worker_unavailable');
  }
  private async operation(guild: string | null,run: (c: PoolClient) => Promise<void>): Promise<void> {
    await this.guard.assertActive();
    await transaction(this.db,async c => { await this.fence(c); if (guild) await guildLock(c,guild); await run(c); await this.guard.assertActive(); if (this.guard.signal.aborted) throw new UsageError('worker_unavailable'); });
  }
  private async installed(): Promise<Set<string>> {
    const signal = AbortSignal.any([this.guard.signal,AbortSignal.timeout(30000)]),ids = new Set<string>(); let after = '';
    for (let page = 0; page < 10; page++) {
      const rows = await discordBounded(() => this.discord.call({ method: 'GET',path: `/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`,signal }),signal);
      if (!Array.isArray(rows) || rows.length > 200) throw new Error('membership_unavailable');
      for (const row of rows) { if (!row || !isSnowflake(row.id) || ids.has(row.id) || (after && BigInt(row.id) <= BigInt(after))) throw new Error('membership_unavailable'); ids.add(row.id); }
      if (rows.length < 200) return ids;
      after = rows.reduce((max: string,r: { id: string }) => BigInt(r.id) > BigInt(max) ? r.id : max,'0');
    }
    throw new Error('membership_incomplete');
  }
  async reconcile(): Promise<void> {
    await this.guard.assertActive(); const installed = await this.installed();
    const current = (await this.db.pool.query('SELECT guild_id FROM guild_settings')).rows.map(r => r.guild_id as string);
    for (const id of installed) await this.operation(id,async c => { await c.query('INSERT INTO guild_settings(guild_id) VALUES($1) ON CONFLICT DO NOTHING',[id]); });
    for (const id of current) if (!installed.has(id)) await this.operation(id,async c => { await c.query('DELETE FROM guild_settings WHERE guild_id=$1',[id]); });
  }
  async recoverUsage(): Promise<void> {
    await this.guard.assertActive();
    const ids = (await this.db.pool.query("SELECT id FROM usage_reservations WHERE state='reserved'")).rows;
    for (const row of ids) { await this.guard.assertActive(); await new UsageService(this.db).settleUsage(row.id,null,'uncertain'); }
    await this.guard.assertActive();
  }
  async cleanup(): Promise<void> {
    const now = this.now(),seven = new Date(now.getTime()-7*86400000),ninety = new Date(now.getTime()-90*86400000);
    const ids = (await this.db.pool.query('SELECT guild_id FROM guild_settings UNION SELECT guild_id FROM daily_usage UNION SELECT guild_id FROM usage_reservations UNION SELECT guild_id FROM request_receipts')).rows.map(r => r.guild_id as string);
    for (const id of ids) await this.operation(id,async c => {
      await c.query('DELETE FROM operational_errors WHERE guild_id=$1 AND created_at<$2',[id,seven]);
      await c.query('DELETE FROM audit_events WHERE guild_id=$1 AND created_at<$2',[id,ninety]);
      await c.query("DELETE FROM request_receipts WHERE guild_id=$1 AND state IN ('completed','failed') AND updated_at<$2",[id,seven]);
      await c.query("DELETE FROM usage_reservations r WHERE guild_id=$1 AND state IN ('known','not_sent') AND updated_at<$2 AND EXISTS(SELECT 1 FROM daily_usage d WHERE d.guild_id=r.guild_id AND d.provider=r.provider AND d.utc_date=r.utc_date)",[id,seven]);
      await c.query("DELETE FROM daily_usage d WHERE guild_id=$1 AND utc_date<$2 AND uncertain_tokens=0 AND reserved_tokens=0 AND NOT EXISTS(SELECT 1 FROM usage_reservations r WHERE r.guild_id=d.guild_id AND r.provider=d.provider AND r.utc_date=d.utc_date AND r.state IN ('reserved','uncertain'))",[id,ninety.toISOString().slice(0,10)]);
    });
    await this.operation(null,async c => {
      await c.query('DELETE FROM web_sessions WHERE expires_at<=$1',[now]); await c.query('DELETE FROM oauth_states WHERE expires_at<=$1',[now]);
      await c.query('DELETE FROM audit_events WHERE guild_id IS NULL AND created_at<$1',[ninety]);
    });
  }
}
