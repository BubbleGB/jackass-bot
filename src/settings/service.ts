import { supportsModel } from '../providers/catalog.js';
import type { Pool, PoolClient } from 'pg';
import type { Database } from '../db/index.js';
import type { AccessLevel, ProviderId } from '../domain/types.js';
import { AccessPolicy, SettingsError, isSnowflake, type AccessAction, type AccessGrant, type AccessRepository } from '../access/policy.js';
import { CredentialCipher, type CredentialService } from './credentials.js';
import { object, validatePatch, validateProvider, validateNewChannels, type GuildSettings, type SettingsPatch, type ModelSupport } from './validation.js';
export type { GuildSettings, SettingsPatch } from './validation.js';
export const DELEGATE_SPENDING_WARNING = 'Delegates can change models and response frequency, which can affect spending even without raising token allowances.';
export function accessRepository(client: Pick<Pool, 'query'>): AccessRepository {
  return {
    async isApproved(guildId) { return (await client.query('SELECT 1 FROM approved_guilds WHERE guild_id=$1', [guildId])).rowCount === 1; },
    async grants(guildId) { return (await client.query('SELECT subject_type AS "subjectType",subject_id AS "subjectId" FROM access_grants WHERE guild_id=$1', [guildId])).rows as AccessGrant[]; },
  };
}
const fields = {
  instructions: 'instructions', enabled: 'enabled', directEnabled: 'direct_enabled', humanContextLimit: 'human_context_limit',
  selfContextLimit: 'self_context_limit', contextTokenLimit: 'context_token_limit', autoPolicy: 'auto_policy',
  autoGapSeconds: 'auto_gap_seconds', autoThreshold: 'auto_threshold', answerTargetTokens: 'answer_target_tokens', maxGenerationTokens: 'max_generation_tokens',
} as const;
/** Every public operation expects an authenticated actor ID from the backend,
 * never a claimed identity from a browser body. No permission/session caches.
 */
export class SettingsService implements CredentialService {
  constructor(private readonly database: Database, private readonly access: AccessPolicy, private readonly cipher: CredentialCipher, private readonly modelSupport: ModelSupport = supportsModel) {}
  private async transaction<T>(guildId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!isSnowflake(guildId)) throw new SettingsError('invalid_settings');
    let client: PoolClient | undefined;
    try {
      client = await this.database.pool.connect(); await client.query('BEGIN');
      // All settings, key, grant and approval paths share this database lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [guildId]);
      const result = await action(client); await client.query('COMMIT'); return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof SettingsError) throw error;
      throw new SettingsError('storage_failed');
    } finally { client?.release(); }
  }
  private async protected<T>(actorId: string, guildId: string, action: AccessAction, callback: (client: PoolClient, level: AccessLevel) => Promise<T>): Promise<T> {
    return this.transaction(guildId, async client => {
      const level = await this.access.require(actorId, guildId, action, accessRepository(client));
      return callback(client,level);
    });
  }
  private async load(client: PoolClient, guildId: string): Promise<GuildSettings> {
    const row = (await client.query('SELECT * FROM guild_settings WHERE guild_id=$1', [guildId])).rows[0];
    if (!row) throw new SettingsError('not_configured');
    const providers = (await client.query('SELECT provider,model_id,effort,priority,daily_allowance FROM provider_configs WHERE guild_id=$1 ORDER BY priority', [guildId])).rows.map(p => ({ provider: p.provider as ProviderId, modelId: p.model_id as string | null, effort: p.effort as string | null, priority: p.priority as number, dailyAllowance: String(p.daily_allowance), credentialConfigured: true as const }));
    const autoChannels = (await client.query('SELECT channel_id FROM auto_channels WHERE guild_id=$1 ORDER BY channel_id', [guildId])).rows.map(r => r.channel_id as string);
    return { guildId, revision: row.revision, instructions: row.instructions, enabled: row.enabled, directEnabled: row.direct_enabled,
      humanContextLimit: row.human_context_limit, selfContextLimit: row.self_context_limit, contextTokenLimit: row.context_token_limit,
      autoPolicy: row.auto_policy, autoGapSeconds: row.auto_gap_seconds, autoThreshold: row.auto_threshold,
      answerTargetTokens: row.answer_target_tokens, maxGenerationTokens: row.max_generation_tokens, providers, autoChannels };
  }
  private async audit(client: PoolClient, guildId: string | null, actor: string, action: string, changed: string[], targetGuildId: string | null = null): Promise<void> {
    await client.query('INSERT INTO audit_events(guild_id,actor,action,changed_fields,target_guild_id) VALUES ($1,$2,$3,$4,$5)', [guildId,actor,action,changed,targetGuildId]);
  }
  private async bump(client: PoolClient, guildId: string): Promise<void> { await client.query('UPDATE guild_settings SET revision=revision+1,updated_at=now() WHERE guild_id=$1', [guildId]); }
  private revision(current: GuildSettings, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 1) throw new SettingsError('invalid_settings');
    if (current.revision !== expected) throw new SettingsError('revision_conflict');
  }
  private viable(settings: GuildSettings): boolean {
    return settings.providers.some(p => p.modelId !== null && BigInt(p.dailyAllowance) > 0n && this.modelSupport({ provider: p.provider, modelId: p.modelId, effort: p.effort, contextTokenLimit: settings.contextTokenLimit, maxGenerationTokens: settings.maxGenerationTokens }));
  }
  async getSettings(actorId: string, guildId: string): Promise<GuildSettings> { return this.protected(actorId, guildId, 'read', client => this.load(client, guildId)); }
  async updateSettings(actorId: string, guildId: string, input: SettingsPatch, expectedRevision: number): Promise<GuildSettings> {
    const patch = validatePatch(input);
    if (patch.autoChannels) {
      const before = await this.getSettings(actorId,guildId);
      this.revision(before,expectedRevision);
      await validateNewChannels(guildId,patch.autoChannels.filter(id => !before.autoChannels.includes(id)),this.access.membership);
    }
    return this.protected(actorId, guildId, 'settings', async (client,level) => {
      const current = await this.load(client, guildId); this.revision(current, expectedRevision);
      const next: GuildSettings = { ...current, ...patch, providers: current.providers.map(p => ({ ...p })), autoChannels: patch.autoChannels ?? current.autoChannels };
      if (patch.providers) for (const change of patch.providers) {
        const existing = next.providers.find(p => p.provider === change.provider);
        if (!existing) throw new SettingsError('invalid_settings'); // Only key managers create provider rows.
        if (level === 'delegate' && ((change.dailyAllowance !== undefined && BigInt(change.dailyAllowance) > BigInt(existing.dailyAllowance)) || (change.priority !== undefined && change.priority !== existing.priority))) throw new SettingsError('forbidden');
        Object.assign(existing, change);
      }
      if (new Set(next.providers.map(p => p.priority)).size !== next.providers.length || next.answerTargetTokens > next.maxGenerationTokens) throw new SettingsError('invalid_settings');
      for (const p of next.providers) {
        const selectionChanged = patch.providers?.some(change => change.provider === p.provider && (change.modelId !== undefined || change.effort !== undefined));
        const boundsChanged = patch.contextTokenLimit !== undefined || patch.maxGenerationTokens !== undefined;
        if ((selectionChanged || boundsChanged) && (p.modelId === null ? p.effort !== null : !this.modelSupport({ provider: p.provider, modelId: p.modelId, effort: p.effort, contextTokenLimit: next.contextTokenLimit, maxGenerationTokens: next.maxGenerationTokens }))) throw new SettingsError('invalid_settings');
      }
      if (!this.viable(next)) {
        if (patch.enabled === true) throw new SettingsError('not_configured');
        next.enabled = false;
      }
      const columns = Object.entries(fields);
      await client.query(`UPDATE guild_settings SET ${columns.map(([, column], i) => `${column}=$${i + 2}`).join(',')} WHERE guild_id=$1`, [guildId, ...columns.map(([key]) => next[key as keyof typeof fields])]);
      if (patch.providers) {
        // Preserve full envelopes, funding and revisions during an authorised priority
        // swap. Usage is guild-owned and never removed/recreated here.
        const envelopes = (await client.query('SELECT * FROM provider_configs WHERE guild_id=$1', [guildId])).rows;
        const reorders = next.providers.some(p => p.priority !== current.providers.find(c => c.provider === p.provider)?.priority);
        if (reorders) await client.query('DELETE FROM provider_configs WHERE guild_id=$1', [guildId]);
        for (const p of next.providers) {
          if (reorders) {
            const e = envelopes.find(e => e.provider === p.provider)!;
            await client.query('INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,effort,priority,daily_allowance,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())', [guildId,p.provider,e.ciphertext,e.nonce,e.key_version,p.modelId,p.effort,p.priority,p.dailyAllowance,e.revision+1,e.created_at]);
          } else await client.query('UPDATE provider_configs SET model_id=$3,effort=$4,priority=$5,daily_allowance=$6,revision=revision+1,updated_at=now() WHERE guild_id=$1 AND provider=$2', [guildId,p.provider,p.modelId,p.effort,p.priority,p.dailyAllowance]);
        }
      }
      if (patch.autoChannels) {
        // Keep retained channels/state intact; deleting the entire list would reset counters.
        await client.query('DELETE FROM auto_channels WHERE guild_id=$1 AND NOT(channel_id=ANY($2::text[]))', [guildId, next.autoChannels]);
        for (const id of next.autoChannels) await client.query('INSERT INTO auto_channels(guild_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [guildId,id]);
      }
      await this.bump(client, guildId); await this.audit(client, guildId, actorId, 'settings.update', Object.keys(patch));
      return this.load(client, guildId);
    });
  }
  async setCredential(actorId: string, guildId: string, provider: ProviderId, key: string): Promise<void> {
    await this.protected(actorId, guildId, 'credentials', async client => {
      validateProvider(provider); const current = await this.load(client, guildId);
      const envelope = this.cipher.seal(guildId, provider, key);
      const existing = current.providers.find(p => p.provider === provider);
      const priority = existing?.priority ?? ([1,2].find(n => !current.providers.some(p => p.priority === n))!);
      await client.query('INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority) VALUES($1,$2,$3,$4,$5,NULL,$6) ON CONFLICT(guild_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,key_version=EXCLUDED.key_version,revision=provider_configs.revision+1,updated_at=now()', [guildId,provider,envelope.ciphertext,envelope.nonce,envelope.keyVersion,priority]);
      await this.bump(client, guildId); await this.audit(client, guildId, actorId, 'credential.set', ['credentials']);
    });
  }
  async removeCredential(actorId: string, guildId: string, provider: ProviderId): Promise<void> {
    await this.protected(actorId, guildId, 'credentials', async client => {
      validateProvider(provider); await this.load(client, guildId);
      await client.query('DELETE FROM provider_configs WHERE guild_id=$1 AND provider=$2', [guildId,provider]);
      if (!this.viable(await this.load(client,guildId))) await client.query('UPDATE guild_settings SET enabled=false WHERE guild_id=$1', [guildId]);
      await this.bump(client, guildId); await this.audit(client, guildId, actorId, 'credential.remove', ['credentials']);
    });
  }
  async credentialStatus(actorId: string, guildId: string, provider: ProviderId): Promise<{ configured: boolean }> {
    validateProvider(provider); return { configured: (await this.getSettings(actorId,guildId)).providers.some(p => p.provider === provider) };
  }
  async grantAccess(actorId: string, guildId: string, input: AccessGrant, expectedRevision: number, acknowledgeSpendingRisk: boolean): Promise<void> {
    await this.protected(actorId, guildId, 'grants', async client => {
      const grant = object(input);
      if (Object.keys(grant).some(k => !['subjectType','subjectId'].includes(k)) || !['user','role'].includes(String(grant.subjectType)) || !isSnowflake(grant.subjectId) || acknowledgeSpendingRisk !== true) throw new SettingsError('invalid_settings');
      const current = await this.load(client,guildId); this.revision(current,expectedRevision);
      const member = await this.access.member(grant.subjectType === 'user' ? grant.subjectId : actorId,guildId);
      if (!member || (grant.subjectType === 'role' && !member.roles.some(r => r.id === grant.subjectId))) throw new SettingsError('invalid_settings');
      await client.query('INSERT INTO access_grants(guild_id,subject_type,subject_id,granted_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [guildId,grant.subjectType,grant.subjectId,actorId]);
      await this.bump(client,guildId); await this.audit(client,guildId,actorId,'access.grant',['accessGrants']);
    });
  }
  async revokeAccess(actorId: string, guildId: string, input: AccessGrant, expectedRevision: number): Promise<void> {
    await this.protected(actorId,guildId,'grants',async client => {
      const grant = object(input);
      if (Object.keys(grant).some(k => !['subjectType','subjectId'].includes(k)) || !['user','role'].includes(String(grant.subjectType)) || !isSnowflake(grant.subjectId)) throw new SettingsError('invalid_settings');
      this.revision(await this.load(client,guildId),expectedRevision);
      await client.query('DELETE FROM access_grants WHERE guild_id=$1 AND subject_type=$2 AND subject_id=$3',[guildId,grant.subjectType,grant.subjectId]);
      await this.bump(client,guildId); await this.audit(client,guildId,actorId,'access.revoke',['accessGrants']);
    });
  }
  async listAccess(actorId: string,guildId: string): Promise<{ grants: readonly AccessGrant[]; warning: string }> {
    return this.protected(actorId,guildId,'grants',async client => ({ grants: await accessRepository(client).grants(guildId),warning: DELEGATE_SPENDING_WARNING }));
  }
  async setApproval(actorId: string,guildId: string,approved: boolean): Promise<void> {
    this.access.requireCreator(actorId);
    if (typeof approved !== 'boolean') throw new SettingsError('invalid_settings');
    await this.transaction(guildId,async client => {
      if (approved) await client.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[guildId,actorId]);
      else {
        await client.query('DELETE FROM approved_guilds WHERE guild_id=$1',[guildId]);
        await client.query('UPDATE guild_settings SET enabled=false,revision=revision+1,updated_at=now() WHERE guild_id=$1',[guildId]);
        await client.query('DELETE FROM provider_configs WHERE guild_id=$1',[guildId]);
      }
      // Global audit keeps only the target ID, never server settings or keys.
      await this.audit(client,null,actorId,approved ? 'approval.add' : 'approval.revoke',['approval'],guildId);
    });
  }
  async listApprovals(actorId: string): Promise<string[]> {
    this.access.requireCreator(actorId);
    try { return (await this.database.pool.query('SELECT guild_id FROM approved_guilds ORDER BY guild_id')).rows.map(r => r.guild_id as string); }
    catch { throw new SettingsError('storage_failed'); }
  }
}
