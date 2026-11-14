import { randomUUID } from 'node:crypto';
import type { BotRequest } from '../domain/types.js';
import type { Database } from '../db/index.js';
import type { PoolClient } from 'pg';
import { UsageError,guildLock,transaction } from '../usage/database.js';
import { validContextRequest } from './types.js';
export interface Observation { status: 'counted' | 'eligible' | 'ignored'; direct: boolean }
export interface Assessment { id: string; snapshot: bigint; revision: number; request: BotRequest }
export class AutomaticRepository {
  constructor(private readonly database: Database) {}
  private async fence(client: PoolClient,token: string,exclusive = false): Promise<void> {
    const row = (await client.query(`SELECT token FROM worker_ownership WHERE name='conversation' FOR ${exclusive ? 'UPDATE' : 'SHARE'}`)).rows[0];
    if (!row || row.token !== token) throw new UsageError('worker_unavailable');
  }
  async observe(r: BotRequest,flags: { mentionsBot: boolean; repliesToBot: boolean },revision: number,now: Date,token: string): Promise<Observation> {
    if (!validContextRequest(r) || r.source === 'ask' || !Number.isFinite(now.getTime())) return { status: 'ignored',direct: false };
    return transaction(this.database,async client => {
      await this.fence(client,token);
      await guildLock(client,r.guildId);
      const s = (await client.query('SELECT s.*,EXISTS(SELECT 1 FROM auto_channels WHERE guild_id=s.guild_id AND channel_id=$2) AS selected FROM guild_settings s JOIN approved_guilds a USING(guild_id) WHERE s.guild_id=$1 AND s.enabled AND s.revision=$3',[r.guildId,r.channelId,revision])).rows[0];
      if (!s) return { status: 'ignored',direct: false };
      const direct = s.direct_enabled && (flags.mentionsBot || flags.repliesToBot);
      if (!s.selected && !direct) return { status: 'ignored',direct: false };
      const inserted = await client.query("INSERT INTO request_receipts(guild_id,event_id,state) VALUES($1,$2,'completed') ON CONFLICT DO NOTHING RETURNING event_id",[r.guildId,`event:${r.id}`]);
      if (!inserted.rowCount) return { status: 'ignored',direct: false };
      if (!s.selected) return { status: 'ignored',direct };
      await client.query('INSERT INTO channel_state(guild_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.guildId,r.channelId]);
      const old = (await client.query('SELECT * FROM channel_state WHERE guild_id=$1 AND channel_id=$2 FOR UPDATE',[r.guildId,r.channelId])).rows[0];
      const latest = !old.last_event_id || BigInt(r.id) > BigInt(old.last_event_id);
      const count = BigInt(old.pending_count)+1n;
      const lastDirect = latest ? direct : old.last_was_direct;
      const eligible = !direct && !lastDirect && old.assessment_id === null && count >= BigInt(s.auto_threshold) && (!old.last_success_at || now.getTime()-(old.last_success_at as Date).getTime() >= s.auto_gap_seconds*1000);
      await client.query('UPDATE channel_state SET pending_count=$3,last_event_id=$4,last_user_id=$5,last_event_at=$6,last_was_direct=$7,ready_event_id=$8,updated_at=$9 WHERE guild_id=$1 AND channel_id=$2',[r.guildId,r.channelId,count.toString(),latest ? r.id : old.last_event_id,latest ? r.userId : old.last_user_id,latest ? r.receivedAt : old.last_event_at,lastDirect,eligible ? (latest ? r.id : old.last_event_id) : null,now]);
      return { status: eligible ? 'eligible' : 'counted',direct };
    });
  }
  async begin(guildId: string,channelId: string,now: Date,token: string): Promise<Assessment | null> {
    return transaction(this.database,async client => {
      await this.fence(client,token);
      await guildLock(client,guildId);
      const s = (await client.query('SELECT s.* FROM guild_settings s JOIN approved_guilds a USING(guild_id) JOIN auto_channels c USING(guild_id) WHERE s.guild_id=$1 AND c.channel_id=$2 AND s.enabled',[guildId,channelId])).rows[0];
      if (!s) return null;
      const row = (await client.query('SELECT * FROM channel_state WHERE guild_id=$1 AND channel_id=$2 FOR UPDATE',[guildId,channelId])).rows[0];
      if (!row || row.assessment_id || !row.ready_event_id || row.last_was_direct || !row.last_event_id || !row.last_user_id || !row.last_event_at || BigInt(row.pending_count) < BigInt(s.auto_threshold) || (row.last_success_at && now.getTime()-(row.last_success_at as Date).getTime() < s.auto_gap_seconds*1000)) return null;
      const id = randomUUID();
      await client.query('UPDATE channel_state SET assessment_snapshot=pending_count,assessment_id=$3,assessment_started_at=$4,assessment_event_id=last_event_id,ready_event_id=NULL,updated_at=$4 WHERE guild_id=$1 AND channel_id=$2',[guildId,channelId,id,now]);
      return { id,snapshot: BigInt(row.pending_count),revision: s.revision,request: { id: row.last_event_id,guildId,channelId,userId: row.last_user_id,source: 'automatic',receivedAt: row.last_event_at } };
    });
  }
  async finish(a: Assessment,succeeded: boolean,now: Date,token: string): Promise<boolean> {
    return transaction(this.database,async client => {
      await this.fence(client,token);
      await guildLock(client,a.request.guildId);
      const result = await client.query('UPDATE channel_state SET pending_count=pending_count-CASE WHEN $5 THEN assessment_snapshot ELSE 0 END,assessment_snapshot=NULL,assessment_id=NULL,assessment_started_at=NULL,assessment_event_id=NULL,ready_event_id=NULL,last_success_at=CASE WHEN $5 THEN $6 ELSE last_success_at END,updated_at=$6 WHERE guild_id=$1 AND channel_id=$2 AND assessment_id=$3 AND assessment_snapshot=$4 RETURNING channel_id',[a.request.guildId,a.request.channelId,a.id,a.snapshot.toString(),succeeded,now]);
      return result.rowCount === 1;
    });
  }
  /** Call only after taking the exclusive worker session lock, before accepting events. */
  async recover(token: string): Promise<void> {
    await transaction(this.database,async client => {
      await this.fence(client,token,true);
      const rows = (await client.query('SELECT guild_id,assessment_event_id FROM channel_state WHERE assessment_id IS NOT NULL')).rows;
      for (const row of rows) if (row.assessment_event_id) await client.query("INSERT INTO request_receipts(guild_id,event_id,state) VALUES($1,$2,'uncertain') ON CONFLICT(guild_id,event_id) DO UPDATE SET state='uncertain',updated_at=now() WHERE request_receipts.state='processing'",[row.guild_id,`generation:${row.assessment_event_id}`]);
      await client.query("UPDATE request_receipts SET state='uncertain',updated_at=now() WHERE event_id LIKE 'generation:%' AND state='processing'");
      await client.query('UPDATE channel_state SET assessment_snapshot=NULL,assessment_id=NULL,assessment_started_at=NULL,assessment_event_id=NULL,ready_event_id=NULL');
      // No usage holds are freed. Pending counts remain; only new events create readiness.
    });
  }
}
