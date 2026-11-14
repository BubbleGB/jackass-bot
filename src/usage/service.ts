import { configurationKey } from '../providers/store.js';
import type { Database } from '../db/index.js';
import type { NormalizedUsage,ProviderId } from '../domain/types.js';
import { isSnowflake } from '../access/policy.js';
import { guildLock,transaction,UsageError } from './database.js';
export interface Reservation { id: string; guildId: string; provider: ProviderId; utcDate: string; amount: number; state: 'reserved' | 'known' | 'uncertain' | 'not_sent'; attemptId: string }
export function validUsage(u: NormalizedUsage): boolean {
  return u.certainty === 'reported' && [u.inputTokens,u.outputTokens,u.reasoningTokens,u.totalTokens].every(n => Number.isSafeInteger(n) && n >= 0) && u.reasoningTokens <= u.outputTokens && u.inputTokens+u.outputTokens === u.totalTokens;
}
export class UsageService {
  constructor(private readonly database: Database) {}
  async reserveUsage(guildId: string,provider: ProviderId,attemptId: string,estimate: number,now: Date): Promise<Reservation | null> {
    if (!isSnowflake(guildId) || !['openai','google'].includes(provider) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId) || !Number.isSafeInteger(estimate) || estimate <= 0 || !Number.isFinite(now.getTime())) throw new UsageError('invalid_reservation');
    const utcDate = now.toISOString().slice(0,10);
    return transaction(this.database,async client => {
      await guildLock(client,guildId);
      if ((await client.query('SELECT 1 FROM usage_reservations WHERE attempt_id=$1',[attemptId])).rowCount) return null;
      const config = (await client.query('SELECT p.* FROM provider_configs p JOIN guild_settings s USING(guild_id) JOIN approved_guilds a USING(guild_id) WHERE p.guild_id=$1 AND p.provider=$2 AND s.enabled AND p.model_id IS NOT NULL',[guildId,provider])).rows[0];
      if (!config || BigInt(config.daily_allowance) < BigInt(estimate)) return null;
      const health = (await client.query('SELECT * FROM provider_health WHERE guild_id=$1 AND provider=$2',[guildId,provider])).rows[0];
      const fingerprint = configurationKey({ ciphertext: config.ciphertext,nonce: config.nonce,keyVersion: config.key_version,modelId: config.model_id,effort: config.effort });
      if (health?.configuration_key === fingerprint && (health.blocked || (health.next_retry_at && (health.next_retry_at as Date).getTime() > now.getTime()))) return null;
      await client.query('INSERT INTO daily_usage(guild_id,provider,utc_date) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[guildId,provider,utcDate]);
      const bucket = (await client.query('SELECT * FROM daily_usage WHERE guild_id=$1 AND provider=$2 AND utc_date=$3 FOR UPDATE',[guildId,provider,utcDate])).rows[0];
      const spent = BigInt(bucket.total_tokens)+BigInt(bucket.uncertain_tokens)+BigInt(bucket.reserved_tokens);
      if (spent+BigInt(estimate) > BigInt(config.daily_allowance)) return null;
      // ON CONFLICT also closes cross-guild races on the globally unique attempt ID.
      const inserted = await client.query('INSERT INTO usage_reservations(guild_id,provider,utc_date,reserved,attempt_id,configuration_key,configuration_revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(attempt_id) DO NOTHING RETURNING id',[guildId,provider,utcDate,estimate,attemptId,fingerprint,config.revision]);
      if (!inserted.rows[0]) return null;
      await client.query('UPDATE daily_usage SET reserved_tokens=reserved_tokens+$4,requests=requests+1 WHERE guild_id=$1 AND provider=$2 AND utc_date=$3',[guildId,provider,utcDate,estimate]);
      return { id: inserted.rows[0].id as string,guildId,provider,utcDate,amount: estimate,state: 'reserved',attemptId };
    });
  }
  async settleUsage(id: string,usage: NormalizedUsage | null,outcome: 'known' | 'uncertain' | 'not_sent'): Promise<void> {
    if (!['known','uncertain','not_sent'].includes(outcome) || (outcome === 'known' && (!usage || !validUsage(usage)))) throw new UsageError('invalid_usage');
    await transaction(this.database,async client => {
      const first = (await client.query('SELECT guild_id FROM usage_reservations WHERE id=$1',[id])).rows[0];
      if (!first) throw new UsageError('reservation_missing');
      await guildLock(client,first.guild_id);
      const r = (await client.query('SELECT *,utc_date::text AS original_date FROM usage_reservations WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (r.state === 'known' || r.state === 'not_sent' || (r.state === 'uncertain' && outcome !== 'known')) return;
      const reserved = r.state === 'reserved' ? r.reserved : '0', uncertain = r.state === 'uncertain' ? r.reserved : '0';
      const u = outcome === 'known' ? usage! : { inputTokens: 0,outputTokens: 0,reasoningTokens: 0,totalTokens: 0 };
      await client.query('UPDATE daily_usage SET reserved_tokens=reserved_tokens-$4,uncertain_tokens=uncertain_tokens-$5+$6,input_tokens=input_tokens+$7,output_tokens=output_tokens+$8,reasoning_tokens=reasoning_tokens+$9,total_tokens=total_tokens+$10 WHERE guild_id=$1 AND provider=$2 AND utc_date=$3',[r.guild_id,r.provider,r.original_date,reserved,uncertain,outcome === 'uncertain' ? r.reserved : '0',u.inputTokens,u.outputTokens,u.reasoningTokens,u.totalTokens]);
      await client.query('UPDATE usage_reservations SET state=$2,known_input=$3,known_output=$4,known_reasoning=$5,known_total=$6,updated_at=now() WHERE id=$1',[id,outcome,outcome === 'known' ? u.inputTokens : null,outcome === 'known' ? u.outputTokens : null,outcome === 'known' ? u.reasoningTokens : null,outcome === 'known' ? u.totalTokens : null]);
      if (outcome === 'known' && BigInt(u.totalTokens) > BigInt(r.reserved)) {
        // Estimates can be low. Record the full actual amount without changing the
        // allowance or permanently blocking a healthy configuration. Admission checks
        // include this amount and all other in-flight/uncertain usage.
        await client.query("INSERT INTO operational_errors(guild_id,provider,safe_code,correlation_id) VALUES($1,$2,'usage_estimate_exceeded',$3)",[r.guild_id,r.provider,r.attempt_id]);
      }
    });
  }
}
