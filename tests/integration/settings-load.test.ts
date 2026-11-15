import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { webFixture,guildId,otherGuild,owner } from '../helpers/web-fixture.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_load_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database;
const reads = ['settings','channels','status','errors'] as const;
async function login(f: Awaited<ReturnType<typeof webFixture>>) {
  const start = await f.app.inject('/auth/discord'),state = new URL(start.headers.location!).searchParams.get('state');
  const r = await f.app.inject({ url: `/auth/discord/callback?code=owner&state=${state}&iss=https%3A%2F%2Fdiscord.com`,cookies: { [start.cookies[0]!.name]: start.cookies[0]!.value } });
  return { gn_session: r.cookies.find(c => c.name === 'gn_session')!.value };
}
describe('actual settings page HTTP load through Discord REST membership',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => { await db.pool.query('TRUNCATE daily_usage,usage_reservations,request_receipts,guild_settings,approved_guilds,web_sessions,oauth_states CASCADE'); });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('bounds a healthy overlapping complete load to nine upstream requests without reusing settled membership',async () => {
    const f = await webFixture(db); try { const cookies = await login(f); f.discord.fault('slow');
      const results = await Promise.all(reads.map(p => f.app.inject({ url: `/api/guilds/${guildId}/${p}`,cookies })));
      expect(results.map(r => r.statusCode)).toEqual([200,200,200,200]);
      expect((await f.app.inject({ url: `/api/guilds/${guildId}/grants`,cookies })).statusCode).toBe(200);
      expect(f.discord.trace().discordReads).toBe(9);
      f.leave(); expect((await f.app.inject({ url: `/api/guilds/${guildId}/settings`,cookies })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });
  it('repeated complete loads honour Discord bucket resets instead of amplifying rate-limit failures',async () => {
    const f = await webFixture(db); try { const cookies = await login(f); f.discord.fault('bucket');
      for (let i = 0; i < 4; i++) {
        const initial = await Promise.all(reads.map(p => f.app.inject({ url: `/api/guilds/${guildId}/${p}`,cookies })));
        expect(initial.map(r => r.statusCode)).toEqual([200,200,200,200]);
        expect((await f.app.inject({ url: `/api/guilds/${guildId}/grants`,cookies })).statusCode).toBe(200);
      }
      expect(f.discord.trace().discordReads).toBeLessThanOrEqual(36);
    } finally { await f.app.close(); }
  });
  it('performs four initial reads with one shared lookup, then verifies grants afresh',async () => {
    const f = await webFixture(db); try { const cookies = await login(f); f.discord.fault('slow');
      const results = await Promise.all(reads.map(p => f.app.inject({ url: `/api/guilds/${guildId}/${p}`,cookies })));
      expect(results.map(r => r.statusCode)).toEqual([200,200,200,200]); expect(results[0]!.json().level).toBe('creator'); expect(f.discord.trace()).toEqual({ lookups: 1,discordReads: 5 });
      expect((await f.app.inject({ url: `/api/guilds/${guildId}/grants`,cookies })).statusCode).toBe(200); expect(f.discord.trace()).toEqual({ lookups: 2,discordReads: 9 });
    } finally { await f.app.close(); }
  });
  it('avoids the former concurrent burst and keeps individual reads fresh',async () => {
    const f = await webFixture(db); try { const cookies = await login(f); f.discord.fault('burst');
      const results = await Promise.all(reads.map(p => f.app.inject({ url: `/api/guilds/${guildId}/${p}`,cookies })));
      expect(results.map(r => r.statusCode)).toEqual([200,200,200,200]);
      for (const p of [...reads,'grants']) expect((await f.app.inject({ url: `/api/guilds/${guildId}/${p}`,cookies })).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it.each(['timeout','unavailable'] as const)('keeps later grants %s retryable after all initial reads return creator access',async mode => {
    const f = await webFixture(db); try { const cookies = await login(f); f.discord.fault('slow');
      const results = await Promise.all(reads.map(p => f.app.inject({ url: `/api/guilds/${guildId}/${p}`,cookies })));
      expect(results.map(r => r.statusCode)).toEqual([200,200,200,200]); expect(results[0]!.json().level).toBe('creator');
      f.discord.fault(mode); const grants = await f.app.inject({ url: `/api/guilds/${guildId}/grants`,cookies }); expect(grants.statusCode).toBe(503); expect(grants.json()).toEqual({ error: 'verification_unavailable' });
      expect(f.diagnostics.at(-1)?.category).toBe('verification_'+(mode === 'timeout' ? 'timeout' : 'unavailable'));
    } finally { await f.app.close(); }
  });
  it('keeps temporary failure closed without mutating settings and emits only safe failure metadata',async () => {
    const f = await webFixture(db); try {
      const cookies = await login(f),session = await f.app.inject({ url: '/api/session',cookies }),current = await f.settings.getSettings(owner,guildId);
      f.discord.fault('unavailable',1);
      const r = await f.app.inject({ method: 'PATCH',url: `/api/guilds/${guildId}/settings?private=secret-query`,cookies,headers: { origin: 'http://127.0.0.1:4173','x-csrf-token': session.json().csrf },payload: { revision: current.revision,patch: { instructions: 'private staff text' } } });
      expect(r.statusCode).toBe(503); expect((await f.settings.getSettings(owner,guildId)).revision).toBe(current.revision);
      expect(f.diagnostics).toHaveLength(1); expect(f.diagnostics[0]).toEqual({ route: '/api/guilds/:guildId/settings',status: 503,timingMs: expect.any(Number),category: 'verification_unavailable' });
      expect(Object.keys(f.diagnostics[0]!).sort()).toEqual(['category','route','status','timingMs']);
      expect(JSON.stringify(f.diagnostics)).not.toMatch(/secret-query|private staff text|gn_session|synthetic-discord-token|222222222222222222/);
    } finally { await f.app.close(); }
  });
  it('still denies member/bot departure, forged servers and approval revocation immediately',async () => {
    const f = await webFixture(db); try { const cookies = await login(f),read = (g = guildId) => f.app.inject({ url: `/api/guilds/${g}/settings`,cookies });
      expect((await read()).statusCode).toBe(200); f.leave(); expect((await read()).statusCode).toBe(403);
      f.restoreMembership(); f.discord.removeBot(); expect((await read()).statusCode).toBe(403);
      f.restoreMembership(); expect((await read(otherGuild)).statusCode).toBe(403);
      await f.settings.setApproval(owner,guildId,false); expect((await read()).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });
});
