import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../../src/db/index.js';
import { guildSettings } from '../../src/db/schema.js';

// Never default to DATABASE_URL: this suite creates and drops its own database.
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const databaseName = `galaxy_neegy_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url.toString(), max: 1 });
let database: Database | undefined;
const guild = '99999999999999999999';
const otherGuild = '88888888888888888888';
const channel = '77777777777777777777';
const actor = '66666666666666666666';
function db(): Database { if (!database) throw new Error('Test database unavailable'); return database; }
async function seedGuild(id = guild) {
  await db().pool.query('INSERT INTO guild_settings (guild_id) VALUES ($1)', [id]);
}
async function seedProvider(provider = 'openai', priority = 1, guildId = guild) {
  await db().pool.query('INSERT INTO provider_configs (guild_id, provider, ciphertext, nonce, key_version, model_id, priority, daily_allowance) VALUES ($1,$2,$3,$4,1,$5,$6,1000)', [guildId, provider, Buffer.alloc(32, 1), Buffer.alloc(12, 2), 'test-model', priority]);
}

describe('migrations and guild deletion boundaries', () => {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    database = createDatabase(url.toString());
    await migrate(db().db, { migrationsFolder: './drizzle' });
    // A repeated migration must be a no-op.
    await migrate(db().db, { migrationsFolder: './drizzle' });
  });
  beforeEach(async () => {
    await db().pool.query('TRUNCATE guild_settings, approved_guilds, web_sessions, audit_events CASCADE');
    await seedGuild();
  });
  afterAll(async () => {
    await database?.close();
    try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); } finally { await admin.end(); }
  });
  it('preserves large snowflakes and disables new guilds without a funded default', async () => {
    const [row] = await db().db.select().from(guildSettings).where(eq(guildSettings.guildId, guild));
    expect(row?.guildId).toBe('99999999999999999999');
    expect(row?.enabled).toBe(false);
    expect(row?.directEnabled).toBe(false);
    expect((await db().pool.query('SELECT * FROM provider_configs')).rowCount).toBe(0);
  });
  it('rejects duplicate provider priorities in a guild but permits them in other guilds', async () => {
    await seedProvider();
    await expect(seedProvider('google', 1)).rejects.toMatchObject({ code: '23505' });
    await seedGuild(otherGuild);
    await expect(seedProvider('google', 1, otherGuild)).resolves.toBeUndefined();
  });
  it.each(['input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens', 'uncertain_tokens', 'reserved_tokens', 'requests'])('rejects negative usage in %s', async (column) => {
    await expect(db().pool.query(`INSERT INTO daily_usage (guild_id, provider, utc_date, ${column}) VALUES ($1,'openai','2026-11-13',-1)`, [guild])).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects negative reservations and counters', async () => {
    await expect(db().pool.query("INSERT INTO usage_reservations (guild_id,provider,utc_date,reserved,attempt_id) VALUES ($1,'openai','2026-11-13',-1,$2)", [guild, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await db().pool.query('INSERT INTO auto_channels (guild_id,channel_id) VALUES ($1,$2)', [guild,channel]);
    await expect(db().pool.query('INSERT INTO channel_state (guild_id,channel_id,pending_count) VALUES ($1,$2,-1)', [guild,channel])).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects channel state attached to another guild and duplicate event receipts', async () => {
    await seedGuild(otherGuild);
    await db().pool.query('INSERT INTO auto_channels (guild_id,channel_id) VALUES ($1,$2)', [otherGuild,channel]);
    await expect(db().pool.query('INSERT INTO channel_state (guild_id,channel_id) VALUES ($1,$2)', [guild,channel])).rejects.toMatchObject({ code: '23503' });
    await db().pool.query("INSERT INTO request_receipts (guild_id,event_id) VALUES ($1,'event-1')", [guild]);
    await expect(db().pool.query("INSERT INTO request_receipts (guild_id,event_id) VALUES ($1,'event-1')", [guild])).rejects.toMatchObject({ code: '23505' });
  });
  it('keeps exact large token totals and the original UTC usage bucket', async () => {
    await db().pool.query("INSERT INTO daily_usage (guild_id,provider,utc_date,total_tokens) VALUES ($1,'openai','2026-11-13',9007199254740993)", [guild]);
    const result = await db().pool.query('SELECT total_tokens,utc_date::text FROM daily_usage');
    expect(result.rows[0]).toEqual({ total_tokens: '9007199254740993', utc_date: '2026-11-13' });
  });
  it('retains usage and unresolved reservations when a credential is replaced', async () => {
    await seedProvider();
    await db().pool.query("INSERT INTO daily_usage (guild_id,provider,utc_date,total_tokens,reserved_tokens) VALUES ($1,'openai','2026-11-13',400,100)", [guild]);
    await db().pool.query("INSERT INTO usage_reservations (guild_id,provider,utc_date,reserved,attempt_id) VALUES ($1,'openai','2026-11-13',100,$2)", [guild,randomUUID()]);
    await db().pool.query('DELETE FROM provider_configs WHERE guild_id=$1', [guild]);
    await seedProvider();
    expect((await db().pool.query('SELECT total_tokens,reserved_tokens FROM daily_usage')).rows).toEqual([{ total_tokens: '400', reserved_tokens: '100' }]);
    expect((await db().pool.query('SELECT state,reserved FROM usage_reservations')).rows).toEqual([{ state: 'reserved', reserved: '100' }]);
  });
  it('defaults provider allowances to zero and rejects negative allowances', async () => {
    await seedProvider();
    await db().pool.query('UPDATE provider_configs SET daily_allowance=DEFAULT WHERE guild_id=$1', [guild]);
    expect((await db().pool.query('SELECT daily_allowance FROM provider_configs')).rows).toEqual([{ daily_allowance: '0' }]);
    await expect(db().pool.query('UPDATE provider_configs SET daily_allowance=-1 WHERE guild_id=$1', [guild])).rejects.toMatchObject({ code: '23514' });
  });
  it('requires coherent assessment state and a snapshot bounded by the pending count', async () => {
    await db().pool.query('INSERT INTO auto_channels (guild_id,channel_id) VALUES ($1,$2)', [guild,channel]);
    await db().pool.query('INSERT INTO channel_state (guild_id,channel_id,pending_count) VALUES ($1,$2,5)', [guild,channel]);
    await expect(db().pool.query('UPDATE channel_state SET assessment_snapshot=3 WHERE guild_id=$1', [guild])).rejects.toMatchObject({ code: '23514' });
    await expect(db().pool.query('UPDATE channel_state SET assessment_snapshot=6,assessment_id=$2,assessment_started_at=now() WHERE guild_id=$1', [guild,randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await db().pool.query('UPDATE channel_state SET assessment_snapshot=3,assessment_id=$2,assessment_started_at=now() WHERE guild_id=$1', [guild,randomUUID()]);
    expect((await db().pool.query('SELECT pending_count,assessment_snapshot FROM channel_state')).rows).toEqual([{ pending_count: '5', assessment_snapshot: '3' }]);
  });
  it('rejects partial encrypted session envelopes and expired-at-creation sessions', async () => {
    await expect(db().pool.query("INSERT INTO web_sessions (session_hash,user_id,token_ciphertext,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", ['a'.repeat(64),actor,Buffer.alloc(32)])).rejects.toMatchObject({ code: '23514' });
    await expect(db().pool.query('INSERT INTO web_sessions (session_hash,user_id,expires_at) VALUES ($1,$2,now())', ['b'.repeat(64),actor])).rejects.toMatchObject({ code: '23514' });
  });
  it('deletes guild-owned data while retaining approvals, global sessions, approval audit and another guild', async () => {
    await seedGuild(otherGuild);
    await db().pool.query('INSERT INTO approved_guilds (guild_id,approved_by) VALUES ($1,$2)', [guild, actor]);
    await seedProvider();
    await db().pool.query('INSERT INTO auto_channels (guild_id,channel_id) VALUES ($1,$2)', [guild,channel]);
    await db().pool.query('INSERT INTO channel_state (guild_id,channel_id) VALUES ($1,$2)', [guild,channel]);
    await db().pool.query("INSERT INTO access_grants (guild_id,subject_type,subject_id,granted_by) VALUES ($1,'user',$2,$2)", [guild,actor]);
    await db().pool.query("INSERT INTO daily_usage (guild_id,provider,utc_date) VALUES ($1,'openai','2026-11-13')", [guild]);
    await db().pool.query("INSERT INTO usage_reservations (guild_id,provider,utc_date,reserved,attempt_id) VALUES ($1,'openai','2026-11-13',100,$2)", [guild,randomUUID()]);
    await db().pool.query("INSERT INTO request_receipts (guild_id,event_id) VALUES ($1,'event-1')", [guild]);
    await db().pool.query("INSERT INTO operational_errors (guild_id,provider,safe_code,correlation_id) VALUES ($1,'openai','rate_limit',$2)", [guild,randomUUID()]);
    await db().pool.query("INSERT INTO audit_events (guild_id,actor,action,changed_fields) VALUES ($1,$2,'settings.update',ARRAY['enabled']), (NULL,$2,'approval.add',ARRAY[]::text[])", [guild,actor]);
    await db().pool.query("INSERT INTO web_sessions (session_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')", ['a'.repeat(64),actor]);
    await db().pool.query('DELETE FROM guild_settings WHERE guild_id=$1', [guild]);
    for (const table of ['provider_configs','auto_channels','channel_state','access_grants','daily_usage','usage_reservations','request_receipts','operational_errors']) {
      expect((await db().pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, table).toBe('0');
    }
    expect((await db().pool.query('SELECT guild_id FROM approved_guilds')).rows).toEqual([{ guild_id: guild }]);
    expect((await db().pool.query('SELECT guild_id FROM guild_settings')).rows).toEqual([{ guild_id: otherGuild }]);
    expect((await db().pool.query('SELECT action FROM audit_events')).rows).toEqual([{ action: 'approval.add' }]);
    expect((await db().pool.query('SELECT count(*) FROM web_sessions')).rows[0].count).toBe('1');
  });
});
