import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/db/index.js';
import { AccessPolicy } from '../../src/access/policy.js';
import type { MembershipRepository, MembershipSnapshot } from '../../src/access/discord-membership.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import { SettingsService, accessRepository } from '../../src/settings/service.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
const guild = '111111111111111111', other = '222222222222222222', owner = '333333333333333333', creator = '444444444444444444', delegate = '555555555555555555', role = '666666666666666666', channel = '777777777777777777';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL), databaseName = `galaxy_settings_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url.toString(), max: 1 });
let database: Database, service: SettingsService;
let departed = false, roleRevoked = false, lookupFails = false, catalogAvailable = true;
const membership: MembershipRepository = {
  async lookup(userId, guildId): Promise<MembershipSnapshot | null> {
    if (lookupFails) throw new Error('private Discord error');
    if (departed && userId === delegate) return null;
    if (![guild, other].includes(guildId)) return null;
    return { userId, guildId, ownerId: guildId === guild ? owner : creator, botPresent: true, roleIds: userId === delegate && !roleRevoked ? [role] : [], roles: [{ id: role, permissions: '0' }] };
  },
  async isTextChannel(guildId, id) { return guildId === guild && id === channel; },
};
const support = (p: { modelId: string; effort: string | null; contextTokenLimit: number; maxGenerationTokens: number }) => catalogAvailable && ['test-model', 'test-alternate'].includes(p.modelId) && (p.effort === null || p.effort === 'low') && p.contextTokenLimit + p.maxGenerationTokens <= 32000;
async function settings(actor = owner, id = guild) { return service.getSettings(actor, id); }
async function funded() {
  await service.setCredential(owner, guild, 'openai', 'private-openai-key');
  return service.updateSettings(owner, guild, { providers: [{ provider: 'openai', modelId: 'test-model', dailyAllowance: '1000' }] }, (await settings()).revision);
}
describe('settings/credentials against isolated PostgreSQL', () => {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); url.pathname = `/${databaseName}`;
    database = createDatabase(url.toString()); await migrate(database.db, { migrationsFolder: './drizzle' });
    service = new SettingsService(database, new AccessPolicy(creator, membership, accessRepository(database.pool)), new CredentialCipher(1, new Map([[1, Buffer.alloc(32, 9)]])), support);
  });
  beforeEach(async () => {
    departed = roleRevoked = lookupFails = false; catalogAvailable = true;
    await database.pool.query('TRUNCATE guild_settings, approved_guilds, audit_events CASCADE');
    for (const id of [guild, other]) {
      await database.pool.query('INSERT INTO guild_settings(guild_id) VALUES ($1)', [id]);
      await service.setApproval(creator, id, true);
    }
    await service.grantAccess(owner, guild, { subjectType: 'role', subjectId: role }, (await settings()).revision, true);
  });
  afterAll(async () => { await database?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); } finally { await admin.end(); } });
  it('returns safe projections to delegates, with immutable guild isolation', async () => {
    await funded();
    const view = await settings(delegate);
    expect(view.providers[0]).toMatchObject({ credentialConfigured: true, modelId: 'test-model', dailyAllowance: '1000' });
    const serialized = JSON.stringify(view);
    for (const field of ['private-openai-key', 'ciphertext', 'nonce', 'encryptionKey']) expect(serialized).not.toContain(field);
    await expect(settings(delegate, other)).rejects.toThrow('forbidden');
    await expect(service.updateSettings(owner, guild, { guildId: other } as never, view.revision)).rejects.toThrow('invalid_settings');
    expect((await settings(creator, other)).instructions).toBe('');
  });
  it('enforces write-only keys for owner and creator; encrypted bytes bind server and provider', async () => {
    await funded();
    const result = await database.pool.query('SELECT ciphertext,nonce,key_version FROM provider_configs WHERE guild_id=$1', [guild]);
    expect(result.rows[0].ciphertext.toString()).not.toContain('private-openai-key');
    expect(JSON.stringify(await settings(creator))).not.toContain('private-openai-key');
    await expect(service.setCredential(delegate, guild, 'openai', 'other-key')).rejects.toThrow('forbidden');
    await expect(service.removeCredential(delegate, guild, 'openai')).rejects.toThrow('forbidden');
    const audit = JSON.stringify((await database.pool.query('SELECT * FROM audit_events')).rows);
    expect(audit).not.toContain('private-openai-key'); expect(audit).not.toContain('test-model');
  });
  it('permits ordinary edits and lowering allowance, refusing budget reset/reorder/recreate bypasses', async () => {
    await funded(); let revision = (await settings()).revision;
    await service.updateSettings(delegate, guild, { instructions: 'plain <script>instructions</script>', autoThreshold: 10, providers: [{ provider: 'openai', dailyAllowance: '500' }] }, revision);
    expect((await settings()).providers[0]?.dailyAllowance).toBe('500');
    for (const patch of [
      { providers: [{ provider: 'openai', dailyAllowance: '501' }] },
      { providers: [{ provider: 'openai', dailyAllowance: null }] },
      { providers: [{ provider: 'openai', priority: 2 }] },
      { providers: [{ provider: 'google', modelId: 'test-model', dailyAllowance: '100' }] },
      { providers: null }, { reset: true }, { enabled: true, providers: [] },
    ]) {
      revision = (await settings()).revision;
      await expect(service.updateSettings(delegate, guild, patch as never, revision)).rejects.toThrow();
    }
    const after = await service.updateSettings(delegate, guild, { autoGapSeconds: 90 }, (await settings()).revision);
    expect(after.providers[0]?.dailyAllowance).toBe('500');
    await expect(service.grantAccess(delegate, guild, { subjectType: 'user', subjectId: owner }, after.revision, true)).rejects.toThrow('forbidden');
  });
  it('rechecks departed members, changed roles, unapproved guilds and lookup outages', async () => {
    expect((await settings(delegate)).guildId).toBe(guild);
    roleRevoked = true; await expect(settings(delegate)).rejects.toThrow('forbidden'); roleRevoked = false;
    departed = true; await expect(settings(delegate)).rejects.toThrow('forbidden'); departed = false;
    lookupFails = true; await expect(settings(owner)).rejects.toThrow('forbidden'); lookupFails = false;
    await service.setApproval(creator, guild, false); await expect(settings(owner)).rejects.toThrow('forbidden');
    await expect(service.setApproval(owner, guild, true)).rejects.toThrow('forbidden');
  });
  it('rejects a concurrent stale revision without losing edits', async () => {
    const revision = (await settings()).revision;
    const result = await Promise.allSettled([service.updateSettings(owner, guild, { instructions: 'one' }, revision), service.updateSettings(owner, guild, { instructions: 'two' }, revision)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(r => r.status === 'rejected').map(r => String(r.reason))).toEqual(['SettingsError: revision_conflict']);
  });
  it('requires a supported funded model to enable; lower-to-zero fails closed', async () => {
    await expect(service.updateSettings(owner, guild, { enabled: true }, (await settings()).revision)).rejects.toThrow('not_configured');
    await funded();
    await service.updateSettings(owner, guild, { enabled: true, autoChannels: [channel] }, (await settings()).revision);
    expect((await settings()).enabled).toBe(true);
    await expect(service.updateSettings(owner, guild, { autoChannels: ['888888888888888888'] }, (await settings()).revision)).rejects.toThrow('invalid_settings');
    await expect(service.updateSettings(owner, guild, { providers: [{ provider: 'openai', modelId: 'unsupported' }] }, (await settings()).revision)).rejects.toThrow('invalid_settings');
    const lowered = await service.updateSettings(delegate, guild, { providers: [{ provider: 'openai', dailyAllowance: '0' }] }, (await settings()).revision);
    expect(lowered.enabled).toBe(false);
  });
  it('revocation disables and deletes keys; reapproval does not re-enable or erase usage', async () => {
    await funded(); await service.updateSettings(owner, guild, { enabled: true }, (await settings()).revision);
    await database.pool.query("INSERT INTO daily_usage(guild_id,provider,utc_date,total_tokens) VALUES ($1,'openai','2026-11-13',500)", [guild]);
    await service.setApproval(creator, guild, false);
    expect((await database.pool.query('SELECT count(*) FROM provider_configs WHERE guild_id=$1', [guild])).rows[0].count).toBe('0');
    await service.setApproval(creator, guild, true);
    expect((await settings()).enabled).toBe(false); expect((await settings()).providers).toEqual([]);
    expect((await database.pool.query('SELECT total_tokens FROM daily_usage WHERE guild_id=$1', [guild])).rows[0].total_tokens).toBe('500');
  });
  it('permits delegate model/effort edits and safe disablement after a model retires', async () => {
    await funded();
    await service.updateSettings(delegate,guild,{ providers: [{ provider: 'openai',modelId: 'test-alternate',effort: 'low' }],enabled: true },(await settings()).revision);
    expect((await settings()).providers[0]).toMatchObject({ modelId: 'test-alternate',effort: 'low',dailyAllowance: '1000' });
    catalogAvailable = false;
    const disabled = await service.updateSettings(delegate,guild,{ enabled: false },(await settings()).revision);
    expect(disabled.enabled).toBe(false);
    await expect(service.updateSettings(delegate,guild,{ enabled: true },disabled.revision)).rejects.toThrow('not_configured');
  });
  it('supports full-manager priority swaps without losing keys or resetting usage', async () => {
    await funded(); await service.setCredential(owner,guild,'google','private-google-key');
    await service.updateSettings(owner,guild,{ providers: [{ provider: 'google',modelId: 'test-model',dailyAllowance: '2000' }] },(await settings()).revision);
    const before = (await database.pool.query('SELECT provider,ciphertext,nonce FROM provider_configs WHERE guild_id=$1 ORDER BY provider',[guild])).rows;
    await database.pool.query("INSERT INTO daily_usage(guild_id,provider,utc_date,total_tokens) VALUES ($1,'openai','2026-11-13',500)",[guild]);
    const swapped = await service.updateSettings(owner,guild,{ providers: [{ provider: 'openai',priority: 2 },{ provider: 'google',priority: 1 }] },(await settings()).revision);
    expect(swapped.providers.map(p => [p.provider,p.dailyAllowance])).toEqual([['google','2000'],['openai','1000']]);
    expect((await database.pool.query('SELECT provider,ciphertext,nonce FROM provider_configs WHERE guild_id=$1 ORDER BY provider',[guild])).rows).toEqual(before);
    expect((await database.pool.query('SELECT total_tokens FROM daily_usage WHERE guild_id=$1',[guild])).rows[0].total_tokens).toBe('500');
    await service.setCredential(owner,guild,'openai','replacement-secret');
    expect((await settings()).providers.find(p => p.provider === 'openai')).toMatchObject({ dailyAllowance: '1000', modelId: 'test-model',priority: 2 });
  });
  it('revokes delegated grants without removing owner/admin authority', async () => {
    await service.revokeAccess(owner,guild,{ subjectType: 'role',subjectId: role },(await settings()).revision);
    await expect(settings(delegate)).rejects.toThrow('forbidden');
    await service.grantAccess(owner,guild,{ subjectType: 'user',subjectId: owner },(await settings()).revision,true);
    await service.revokeAccess(owner,guild,{ subjectType: 'user',subjectId: owner },(await settings()).revision);
    expect((await settings()).guildId).toBe(guild);
    await expect(service.grantAccess(owner,guild,{ subjectType: 'role',subjectId: channel },(await settings()).revision,true)).rejects.toThrow('invalid_settings');
  });
  it('preserves retained channel counters and rejects cross-server writes', async () => {
    await service.updateSettings(owner,guild,{ autoChannels: [channel] },(await settings()).revision);
    await database.pool.query('INSERT INTO channel_state(guild_id,channel_id,pending_count) VALUES($1,$2,7)',[guild,channel]);
    await service.updateSettings(owner,guild,{ autoChannels: [channel] },(await settings()).revision);
    expect((await database.pool.query('SELECT pending_count FROM channel_state WHERE guild_id=$1',[guild])).rows[0].pending_count).toBe('7');
    await expect(service.setCredential(owner,other,'openai','cross-server-secret')).rejects.toThrow('forbidden');
    await expect(service.removeCredential(owner,other,'openai')).rejects.toThrow('forbidden');
    await expect(service.updateSettings(owner,other,{ instructions: 'cross-server' },(await settings(creator,other)).revision)).rejects.toThrow('forbidden');
    expect((await settings(creator,other)).providers).toEqual([]);
  });
  it('records global approval target IDs without granting the creator server-data access', async () => {
    const original = membership.lookup;
    membership.lookup = async (actor,id) => actor === creator ? null : original(actor,id);
    try {
      await service.setApproval(creator,guild,false); await service.setApproval(creator,guild,true);
      expect(await service.listApprovals(creator)).toContain(guild);
      await expect(settings(creator)).rejects.toThrow('forbidden');
      const audit = (await database.pool.query("SELECT * FROM audit_events WHERE action='approval.revoke' ORDER BY created_at DESC")).rows[0];
      expect(audit.guild_id).toBeNull(); expect(audit.target_guild_id).toBe(guild);
    } finally { membership.lookup = original; }
  });
  it('can revoke approval while channel validation is blocked, denying the pending edit', async () => {
    await funded(); const revision = (await settings()).revision;
    let entered!: () => void, unblock!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const original = membership.isTextChannel;
    membership.isTextChannel = async () => { entered(); await blocked; return true; };
    const update = service.updateSettings(owner,guild,{ autoChannels: [channel] },revision);
    // Attach a rejection handler immediately; a revoked pending update must reject.
    const outcome = update.then(() => 'updated',error => String(error));
    let revocation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      revocation = service.setApproval(creator,guild,false);
      const finished = await Promise.race([revocation.then(() => true),new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false),5000); })]);
      expect(finished).toBe(true);
      unblock(); expect(await outcome).toBe('SettingsError: forbidden');
      expect((await database.pool.query('SELECT count(*) FROM provider_configs WHERE guild_id=$1',[guild])).rows[0].count).toBe('0');
    } finally { clearTimeout(timer); unblock(); await Promise.allSettled([outcome,revocation]); membership.isTextChannel = original; }
  });
  it('a concurrent revocation prevents further key writes and leaves no credentials', async () => {
    await funded();
    await Promise.allSettled([service.setCredential(owner,guild,'openai','race-secret'),service.setApproval(creator,guild,false)]);
    await expect(service.setCredential(owner,guild,'google','late-secret')).rejects.toThrow('forbidden');
    expect((await database.pool.query('SELECT count(*) FROM provider_configs WHERE guild_id=$1',[guild])).rows[0].count).toBe('0');
    expect((await database.pool.query('SELECT enabled FROM guild_settings WHERE guild_id=$1',[guild])).rows[0].enabled).toBe(false);
  });
  it('validates before writing and rolls back safe errors without auditing private values', async () => {
    const before = await settings();
    for (const patch of [{ autoThreshold: 0 }, { instructions: 'x'.repeat(8001) }, { enabled: 'true' }, { revision: 0 }, { autoPolicy: 'sometimes' }]) {
      await expect(service.updateSettings(owner, guild, patch as never, before.revision)).rejects.toThrow('invalid_settings');
    }
    expect((await settings()).revision).toBe(before.revision);
    await expect(service.grantAccess(owner, guild, { subjectType: 'user', subjectId: delegate }, before.revision, false)).rejects.toThrow('invalid_settings');
  });
});
