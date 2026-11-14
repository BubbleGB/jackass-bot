import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { PostgresWorkerGuard } from '../../src/conversation/worker.js';
import { Maintenance } from '../../src/ops/cleanup.js';
import { UsageService } from '../../src/usage/service.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_maintenance_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database;
const guild = '111111111111111111',other = '222222222222222222',now = new Date('2026-11-14T12:00:00Z');
describe('confirmed guild removal and conservative retention',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => { await db.pool.query('TRUNCATE request_receipts,guild_settings,approved_guilds,daily_usage,usage_reservations,web_sessions,oauth_states CASCADE'); await db.pool.query('INSERT INTO guild_settings(guild_id,instructions) VALUES($1,$2)',[guild,'private personality']); await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]); await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,priority) VALUES($1,'openai',$2,$3,1,1)",[guild,Buffer.alloc(32),Buffer.alloc(12)]); });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  async function setup(list: () => Promise<unknown>) { const guard = new PostgresWorkerGuard(db); expect(await guard.start()).toBe(true); return { guard,maintenance: new Maintenance(db,guard,{ call: list },() => now) }; }
  it('purges actual configuration and keys only after confirmed absence, keeping approval and unresolved usage',async () => {
    const reservation = randomUUID(); await db.pool.query("INSERT INTO daily_usage(guild_id,provider,utc_date,reserved_tokens) VALUES($1,'openai','2026-11-14',100)",[guild]);
    await db.pool.query("INSERT INTO usage_reservations(id,guild_id,provider,utc_date,reserved,attempt_id) VALUES($1,$2,'openai','2026-11-14',100,$3)",[reservation,guild,randomUUID()]);
    await db.pool.query("INSERT INTO request_receipts(guild_id,event_id,state) VALUES($1,'generation:uncertain','uncertain')",[guild]);
    const f = await setup(async () => []);
    try { await f.maintenance.reconcile(); expect((await db.pool.query('SELECT 1 FROM guild_settings')).rowCount).toBe(0); expect((await db.pool.query('SELECT 1 FROM provider_configs')).rowCount).toBe(0); expect((await db.pool.query('SELECT 1 FROM approved_guilds')).rowCount).toBe(1); expect((await db.pool.query("SELECT 1 FROM request_receipts WHERE state='uncertain'")).rowCount).toBe(1); expect((await db.pool.query('SELECT reserved_tokens FROM daily_usage')).rows[0].reserved_tokens).toBe('100');
      await new UsageService(db).settleUsage(reservation,{ inputTokens: 100,outputTokens: 50,reasoningTokens: 0,totalTokens: 150,certainty: 'reported' },'known');
      expect((await db.pool.query('SELECT total_tokens,reserved_tokens FROM daily_usage')).rows[0]).toEqual({ total_tokens: '150',reserved_tokens: '0' });
    } finally { await f.guard.stop(); }
  });
  it.each(['outage','partial','invalid'] as const)('never deletes or provisions from an %s membership listing',async kind => {
    let calls = 0; const f = await setup(async () => { calls++; if (kind === 'outage' || calls > 1) throw new Error('private outage'); if (kind === 'invalid') return [{ id: 'invalid' }]; return Array.from({ length: 200 },(_,i) => ({ id: String(BigInt(guild)+BigInt(i)) })); });
    try { await expect(f.maintenance.reconcile()).rejects.toThrow(); expect((await db.pool.query('SELECT 1 FROM guild_settings')).rowCount).toBe(1); expect((await db.pool.query('SELECT 1 FROM provider_configs')).rowCount).toBe(1); } finally { await f.guard.stop(); }
  });
  it('provisions disabled defaults without approval and rejects a stale worker',async () => {
    const f = await setup(async () => [{ id: guild },{ id: other }]);
    await f.maintenance.reconcile(); expect((await db.pool.query('SELECT enabled,direct_enabled,instructions FROM guild_settings WHERE guild_id=$1',[other])).rows[0]).toEqual({ enabled: false,direct_enabled: false,instructions: '' });
    expect((await db.pool.query('SELECT 1 FROM approved_guilds WHERE guild_id=$1',[other])).rowCount).toBe(0);
    await f.guard.stop(); await expect(f.maintenance.reconcile()).rejects.toThrow(); expect((await db.pool.query('SELECT 1 FROM guild_settings')).rowCount).toBe(2);
  });
  it('prunes expired/aggregated records while preserving unresolved reservations, buckets and receipts',async () => {
    await db.pool.query("INSERT INTO daily_usage(guild_id,provider,utc_date,uncertain_tokens) VALUES($1,'openai','2026-01-01',77),($1,'google','2026-01-01',0)",[guild]);
    await db.pool.query("INSERT INTO usage_reservations(guild_id,provider,utc_date,reserved,attempt_id,state,created_at,updated_at) VALUES($1,'openai','2026-01-01',77,$2,'uncertain','2026-01-01','2026-01-01'),($1,'google','2026-01-01',10,$3,'not_sent','2026-01-01','2026-01-01')",[guild,randomUUID(),randomUUID()]);
    await db.pool.query("INSERT INTO request_receipts(guild_id,event_id,state,created_at,updated_at) VALUES($1,'event:old','completed','2026-01-01','2026-01-01'),($1,'generation:old','uncertain','2026-01-01','2026-01-01')",[guild]);
    await db.pool.query("INSERT INTO web_sessions(session_hash,user_id,created_at,expires_at) VALUES($1,$2,'2026-01-01','2026-01-02')",['a'.repeat(64),guild]);
    const f = await setup(async () => [{ id: guild }]);
    try { await f.maintenance.cleanup(); expect((await db.pool.query('SELECT state FROM usage_reservations')).rows).toEqual([{ state: 'uncertain' }]); expect((await db.pool.query('SELECT provider,uncertain_tokens FROM daily_usage')).rows).toEqual([{ provider: 'openai',uncertain_tokens: '77' }]); expect((await db.pool.query('SELECT state FROM request_receipts')).rows).toEqual([{ state: 'uncertain' }]); expect((await db.pool.query('SELECT 1 FROM web_sessions')).rowCount).toBe(0); } finally { await f.guard.stop(); }
  });
});
