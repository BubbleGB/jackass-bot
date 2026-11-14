import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { runtimeFixture,deferred } from '../helpers/runtime-fixture.js';
import { request,guild,user } from '../helpers/conversation.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_lifecycle_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database;
describe('production lifecycle with real services and mocked external adapters',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => { await db.pool.query('TRUNCATE guild_settings,approved_guilds,daily_usage,usage_reservations,request_receipts CASCADE'); });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('exposes starting readiness, gates events, drains in-flight work and restarts without replay',async () => {
    const f = await runtimeFixture(db,url.toString()),releaseLogin = f.holdLogin(),starting = f.start(); await f.loginStarted.promise;
    expect((await f.servers[0]!.inject('/health/live')).statusCode).toBe(200); expect((await f.servers[0]!.inject('/health/ready')).statusCode).toBe(503); f.message(); expect(f.generations()).toBe(0);
    releaseLogin(); const app = await starting;
    try {
      expect((await app.server.inject('/health/ready')).body).toBe('{"status":"ready"}');
      await expect(f.start()).rejects.toThrow(); expect(f.logins()).toBe(1);
      const release = f.holdGeneration(); f.message(); await f.generationStarted.promise; const stopping = app.stop(); await new Promise<void>(r => setImmediate(r));
      await expect(f.start()).rejects.toThrow(); release(); await stopping;
      expect((await db.pool.query('SELECT total_tokens,reserved_tokens FROM daily_usage')).rows[0]).toEqual({ total_tokens: '30',reserved_tokens: '0' });
      const again = await f.start(); try { f.message(); await new Promise<void>(r => setTimeout(r,30)); await again.conversation.queue.idle(); expect(f.generations()).toBe(1); f.disconnect(); expect((await again.server.inject('/health/ready')).statusCode).toBe(503); } finally { await again.stop(); }
      expect(f.logs.join('')).not.toMatch(/private conversation|Private generated answer|fake-provider-secret|fake-discord-secret|fake-oauth-secret/);
    } finally { await app.stop(); }
  });
  it.each(['disable','revoke'] as const)('stops a queued request after staff %s before generation',async action => {
    const f = await runtimeFixture(db,url.toString()),app = await f.start(),gate = deferred();
    try {
      app.conversation.queue.enqueue({ ...request,receivedAt: new Date() },() => gate.promise); await app.conversation.handlers.handleMessage({ id: request.id,guildId: guild,channelId: request.channelId,channelType: 0,userId: user,bot: false,webhookId: null });
      if (action === 'disable') { const s = await app.conversation.settings.getSettings(user,guild); await app.conversation.settings.updateSettings(user,guild,{ enabled: false },s.revision); }
      else await app.conversation.settings.setApproval(user,guild,false);
      gate.resolve(); await app.conversation.queue.idle(); expect(f.generations()).toBe(0); expect(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/messages'))).toHaveLength(0); expect((await db.pool.query('SELECT 1 FROM usage_reservations')).rowCount).toBe(0);
    } finally { gate.resolve(); await app.stop(); }
  });
  it('settles actual provider usage but blocks delivery after permission is lost',async () => {
    const f = await runtimeFixture(db,url.toString()),app = await f.start();
    try { f.losePermission(); f.message(); await f.generationStarted.promise; await app.conversation.queue.idle(); expect(f.generations()).toBe(1); expect((await db.pool.query('SELECT total_tokens FROM daily_usage')).rows[0].total_tokens).toBe('30'); expect(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/messages'))).toHaveLength(0); }
    finally { await app.stop(); }
  });
  it('fails startup on a Discord membership outage without deleting keys/configuration',async () => {
    const f = await runtimeFixture(db,url.toString()); f.outage(); await expect(f.start()).rejects.toThrow(); expect((await db.pool.query('SELECT 1 FROM provider_configs')).rowCount).toBe(1); expect((await db.pool.query('SELECT 1 FROM guild_settings')).rowCount).toBe(1);
  });
  it('cleans up a signal during startup without later opening ingress',async () => {
    const f = await runtimeFixture(db,url.toString()),release = f.holdLogin(),controller = new AbortController(),starting = f.start(controller.signal); await f.loginStarted.promise; controller.abort(); await expect(starting).rejects.toThrow(); release(); await new Promise<void>(r => setImmediate(r)); f.message(); expect(f.generations()).toBe(0);
  });  it('retains uncertainty after cancellation and never replays that attempt on restart',async () => {
    const f = await runtimeFixture(db,url.toString()),app = await f.start(undefined,20),release = f.holdGeneration();
    f.message(); await f.generationStarted.promise; await app.stop();
    expect((await db.pool.query('SELECT state FROM usage_reservations')).rows[0].state).toBe('uncertain');
    expect(BigInt((await db.pool.query('SELECT uncertain_tokens FROM daily_usage')).rows[0].uncertain_tokens)).toBeGreaterThan(0n);
    release(); const again = await f.start(); try { f.message(); await new Promise<void>(r => setTimeout(r,30)); await again.conversation.queue.idle(); expect(f.generations()).toBe(1); } finally { await again.stop(); }
  });
  it('keeps another server event out of the real generation/accounting path',async () => {
    const f = await runtimeFixture(db,url.toString()),app = await f.start();
    try { f.message(request.id,'999999999999999999'); await new Promise<void>(r => setTimeout(r,30)); expect(f.generations()).toBe(0); f.message(); await f.generationStarted.promise; await app.conversation.queue.idle(); expect(f.generations()).toBe(1); expect((await db.pool.query('SELECT guild_id,total_tokens FROM daily_usage')).rows).toEqual([{ guild_id: guild,total_tokens: '30' }]); }
    finally { await app.stop(); }
  });
  it('closes HTTP and releases ownership even if SDK shutdown fails, without leaking its error',async () => {
    const f = await runtimeFixture(db,url.toString()),app = await f.start(); f.failDestroy();
    try { await expect(app.stop()).rejects.toThrow('runtime_shutdown_failed'); expect(app.server.server.listening).toBe(false); const again = await f.start(); await again.stop(); expect(f.logs.join('')).not.toContain('private-sdk-token'); }
    finally { await app.server.close(); }
  });

});
