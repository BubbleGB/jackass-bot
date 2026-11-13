import { MODELS } from './catalog.js';
import { createHash } from 'node:crypto';
import type { Database } from '../db/index.js';
import type { ProviderId } from '../domain/types.js';
import type { CredentialEnvelope } from '../settings/credentials.js';
import { guildLock,transaction,UsageError } from '../usage/database.js';
import type { ProviderFailure } from './http.js';
export interface Candidate extends CredentialEnvelope {
  provider: ProviderId; modelId: string; effort: string | null; revision: number; configurationKey: string;
  blocked: boolean; retryAt: number; failures: number;
}
export interface RoutingConfig { revision: number; instructions: string; maxGenerationTokens: number; autoPolicy: 'always' | 'conditional'; candidates: Candidate[] }
export interface ProviderRepository {
  claim(guildId: string,requestId: string): Promise<boolean>;
  finish(guildId: string,requestId: string,state: 'completed' | 'failed' | 'uncertain'): Promise<void>;
  load(guildId: string,now?: Date): Promise<RoutingConfig | null>;
  current(guildId: string,config: RoutingConfig,candidate: Candidate): Promise<boolean>;
  failure(guildId: string,candidate: Candidate,error: ProviderFailure,now: Date,correlationId: string): Promise<void>;
  success(guildId: string,candidate: Candidate): Promise<void>;
}
export function configurationKey(row: { ciphertext: Buffer; nonce: Buffer; keyVersion: number; modelId: string | null; effort: string | null }): string {
  return createHash('sha256').update(JSON.stringify([row.ciphertext.toString('base64'),row.nonce.toString('base64'),row.keyVersion,row.modelId,row.effort])).digest('hex');
}
export class PostgresProviderRepository implements ProviderRepository {
  constructor(private readonly database: Database) {}
  async claim(guildId: string,requestId: string): Promise<boolean> {
    return transaction(this.database,async client => {
      await guildLock(client,guildId);
      const q = await client.query("INSERT INTO request_receipts(guild_id,event_id,state) SELECT guild_id,$2,'processing' FROM guild_settings WHERE guild_id=$1 AND enabled AND EXISTS(SELECT 1 FROM approved_guilds WHERE guild_id=$1) ON CONFLICT DO NOTHING RETURNING event_id",[guildId,`generation:${requestId}`]);
      return q.rowCount === 1;
    });
  }
  async finish(guildId: string,requestId: string,state: 'completed' | 'failed' | 'uncertain'): Promise<void> {
    try { await this.database.pool.query("UPDATE request_receipts SET state=$3,updated_at=now() WHERE guild_id=$1 AND event_id=$2 AND state='processing'",[guildId,`generation:${requestId}`,state]); }
    catch { throw new UsageError('usage_storage_failed'); }
  }
  async load(guildId: string,now = new Date()): Promise<RoutingConfig | null> {
    return transaction(this.database,async client => {
      await guildLock(client,guildId);
      const settings = (await client.query('SELECT s.* FROM guild_settings s JOIN approved_guilds a USING(guild_id) WHERE s.guild_id=$1 AND s.enabled',[guildId])).rows[0];
      if (!settings) return null;
      const rows = (await client.query('SELECT p.*,h.configuration_key AS health_key,h.failures,h.blocked,h.next_retry_at,d.total_tokens,d.uncertain_tokens,d.reserved_tokens FROM provider_configs p LEFT JOIN provider_health h USING(guild_id,provider) LEFT JOIN daily_usage d ON d.guild_id=p.guild_id AND d.provider=p.provider AND d.utc_date=$2 WHERE p.guild_id=$1 AND p.model_id IS NOT NULL AND p.daily_allowance>0 ORDER BY p.priority',[guildId,now.toISOString().slice(0,10)])).rows.filter(row => {
        const minimum = settings.max_generation_tokens+(row.provider === 'google' ? MODELS[1].inputLimit : 0);
        return BigInt(row.daily_allowance)-BigInt(row.total_tokens ?? 0)-BigInt(row.uncertain_tokens ?? 0)-BigInt(row.reserved_tokens ?? 0) >= BigInt(minimum);
      });
      const candidates: Candidate[] = rows.map(row => {
        const e = { ciphertext: row.ciphertext as Buffer,nonce: row.nonce as Buffer,keyVersion: row.key_version as number,modelId: row.model_id as string,effort: row.effort as string | null };
        const key = configurationKey(e),same = key === row.health_key;
        return { ...e,provider: row.provider as ProviderId,revision: row.revision as number,configurationKey: key,blocked: same && row.blocked === true,retryAt: same && row.next_retry_at ? (row.next_retry_at as Date).getTime() : 0,failures: same ? row.failures as number : 0 };
      });
      return { revision: settings.revision,instructions: settings.instructions,maxGenerationTokens: settings.max_generation_tokens,autoPolicy: settings.auto_policy,candidates };
    });
  }
  async current(guildId: string,config: RoutingConfig,candidate: Candidate): Promise<boolean> {
    try { return (await this.database.pool.query('SELECT 1 FROM guild_settings s JOIN approved_guilds a USING(guild_id) JOIN provider_configs p USING(guild_id) WHERE s.guild_id=$1 AND s.enabled AND s.revision=$2 AND p.provider=$3 AND p.revision=$4',[guildId,config.revision,candidate.provider,candidate.revision])).rowCount === 1; }
    catch { throw new UsageError('usage_storage_failed'); }
  }
  async failure(guildId: string,candidate: Candidate,error: ProviderFailure,now: Date,correlationId: string): Promise<void> {
    await transaction(this.database,async client => {
      await guildLock(client,guildId);
      const row = (await client.query('SELECT * FROM provider_configs WHERE guild_id=$1 AND provider=$2',[guildId,candidate.provider])).rows[0];
      if (row && configurationKey({ ciphertext: row.ciphertext,nonce: row.nonce,keyVersion: row.key_version,modelId: row.model_id,effort: row.effort }) === candidate.configurationKey) {
        const health = (await client.query('SELECT * FROM provider_health WHERE guild_id=$1 AND provider=$2',[guildId,candidate.provider])).rows[0];
        const failures = Math.min(30,(health?.configuration_key === candidate.configurationKey ? health.failures as number : 0)+1);
        const blocked = ['auth','configuration'].includes(error.category);
        const delay = Math.max(Math.min(900000,30000*2**Math.min(failures-1,10)),error.retryAfterMs ?? 0);
        const next = blocked ? null : new Date(Math.min(8640000000000000,now.getTime()+delay));
        await client.query('INSERT INTO provider_health(guild_id,provider,configuration_revision,configuration_key,failures,blocked,next_retry_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(guild_id,provider) DO UPDATE SET configuration_revision=EXCLUDED.configuration_revision,configuration_key=EXCLUDED.configuration_key,failures=EXCLUDED.failures,blocked=CASE WHEN provider_health.configuration_key=EXCLUDED.configuration_key THEN provider_health.blocked OR EXCLUDED.blocked ELSE EXCLUDED.blocked END,next_retry_at=CASE WHEN provider_health.configuration_key=EXCLUDED.configuration_key AND provider_health.blocked THEN NULL ELSE EXCLUDED.next_retry_at END',[guildId,candidate.provider,candidate.revision,candidate.configurationKey,failures,blocked,next]);
      }
      await client.query('INSERT INTO operational_errors(guild_id,provider,safe_code,correlation_id) SELECT guild_id,$2,$3,$4 FROM guild_settings WHERE guild_id=$1',[guildId,candidate.provider,error.safeCode,correlationId]);
    });
  }
  async success(guildId: string,candidate: Candidate): Promise<void> {
    try { await this.database.pool.query('DELETE FROM provider_health WHERE guild_id=$1 AND provider=$2 AND configuration_key=$3 AND NOT blocked',[guildId,candidate.provider,candidate.configurationKey]); }
    catch { throw new UsageError('usage_storage_failed'); }
  }
}
