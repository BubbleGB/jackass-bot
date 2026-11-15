import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { webFixture,guildId,otherGuild,owner } from '../helpers/web-fixture.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { KnowledgeRepository } from '../../src/knowledge/repository.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_knowledge_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database;
async function session(f: Awaited<ReturnType<typeof webFixture>>,who = 'owner') {
  const start = await f.app.inject('/auth/discord'),state = new URL(start.headers.location!).searchParams.get('state');
  const r = await f.app.inject({ url: `/auth/discord/callback?code=${who}&state=${state}&iss=https%3A%2F%2Fdiscord.com`,cookies: { [start.cookies[0]!.name]: start.cookies[0]!.value } });
  const cookies = { gn_session: r.cookies.find(c => c.name === 'gn_session')!.value },s = await f.app.inject({ url: '/api/session',cookies });
  return { cookies,headers: { origin: 'http://127.0.0.1:4173','x-csrf-token': s.json().csrf } };
}
const root = `/api/guilds/${guildId}/knowledge`;
describe('guild-owned knowledge HTTP, PostgreSQL and current access',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => { await db.pool.query('TRUNCATE guild_settings,approved_guilds,web_sessions,oauth_states CASCADE'); });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('creates/reads/edits/disables/deletes with independent revisions and content-free audit IDs',async () => {
    const f = await webFixture(db); try { const auth = await session(f),initial = await f.settings.getSettings(owner,guildId);
      expect((await f.app.inject({ url: root,...auth })).statusCode).toBe(200);
      const made = await f.app.inject({ method: 'POST',url: root,...auth,payload: { title: 'Moon policy',body: 'Synthetic private reference about lunar cheese.',enabled: true } });
      expect(made.statusCode).toBe(201); const e = made.json().entry; expect(e).toMatchObject({ title: 'Moon policy',revision: 1,enabled: true,bodyCharacters: 47 });
      const list = (await f.app.inject({ url: root,...auth })).json(); expect(list.entries[0]).not.toHaveProperty('body'); expect(list.totalBodyCharacters).toBe(47);
      expect((await f.app.inject({ url: root+'/'+e.id,...auth })).json().entry.body).toContain('lunar cheese');
      const edited = await f.app.inject({ method: 'PATCH',url: root+'/'+e.id,...auth,payload: { revision: 1,patch: { body: 'Updated lunar rules.',enabled: false } } });
      expect(edited.statusCode).toBe(200); expect(edited.json().entry).toMatchObject({ revision: 2,enabled: false });
      expect((await f.app.inject({ method: 'PATCH',url: root+'/'+e.id,...auth,payload: { revision: 1,patch: { title: 'stale' } } })).statusCode).toBe(409);
      expect((await f.app.inject({ method: 'DELETE',url: root+'/'+e.id,...auth,payload: { revision: 1 } })).statusCode).toBe(409);
      expect((await f.app.inject({ method: 'DELETE',url: root+'/'+e.id,...auth,payload: { revision: 2 } })).statusCode).toBe(204);
      expect((await f.app.inject({ url: root+'/'+e.id,...auth })).statusCode).toBe(404);
      expect((await f.settings.getSettings(owner,guildId)).revision).toBe(initial.revision);
      const audit = (await db.pool.query("SELECT action,changed_fields,target_entry_id FROM audit_events WHERE action LIKE 'knowledge_%' ORDER BY created_at")).rows;
      expect(audit).toHaveLength(3); expect(audit.every(r => r.target_entry_id === e.id)).toBe(true); expect(JSON.stringify(audit)).not.toMatch(/Moon policy|lunar cheese|Updated lunar/);
      expect((await db.pool.query('SELECT 1 FROM knowledge_chunks WHERE guild_id=$1',[guildId])).rowCount).toBe(0);
    } finally { await f.app.close(); }
  });
  it('allows delegates but denies revoked roles, forged guilds, missing CSRF and departed members',async () => {
    const f = await webFixture(db); try { const auth = await session(f,'delegate');
      const made = await f.app.inject({ method: 'POST',url: root,...auth,payload: { title: 'Delegate facts',body: 'Orbit reference.',enabled: true } }); expect(made.statusCode).toBe(201); const id = made.json().entry.id;
      expect((await f.app.inject({ url: `/api/guilds/${otherGuild}/knowledge/${id}`,...auth })).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'DELETE',url: root+'/'+id,cookies: auth.cookies,payload: { revision: 1 } })).statusCode).toBe(403);
      f.removeRole(); expect((await f.app.inject({ url: root,...auth })).statusCode).toBe(403);
      f.restoreMembership(); f.leave(); expect((await f.app.inject({ url: root+'/'+id,...auth })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });
  it('accepts 100,000 escaped astral code points and enforces Unicode, title/body and wire limits',async () => {
    const f = await webFixture(db); try { const auth = await session(f),escaped = '{"title":"Astral","body":"'+'\\ud83c\\udf0c'.repeat(100000)+'","enabled":true}';
      const made = await f.app.inject({ method: 'POST',url: root,...auth,headers: { ...auth.headers,'content-type': 'application/json' },payload: escaped });
      expect(made.statusCode).toBe(201); expect(made.json().entry.bodyCharacters).toBe(100000);
      for (const patch of [{ title: 'x'.repeat(121),body: 'valid' },{ title: 'Valid',body: '🌌'.repeat(100001) },{ title: 'Valid',body: '\u0000' },{ title: 'Valid',body: '\ud800' },{ title: ' ',body: 'data' }]) {
        expect((await f.app.inject({ method: 'POST',url: root,...auth,payload: patch })).statusCode).toBe(400);
      }
      expect((await f.app.inject({ method: 'POST',url: root,...auth,headers: { ...auth.headers,'content-type': 'application/json' },payload: ' '.repeat(2*1024*1024)+'{}' })).statusCode).toBe(413);
    } finally { await f.app.close(); }
  });
  it('retrieves only matching current guild passages and immediately observes disabled, edited and deleted entries',async () => {
    const f = await webFixture(db); try {
      const service = new KnowledgeService(db,f.access),repo = new KnowledgeRepository(db),signal = new AbortController().signal;
      const e = await service.create(owner,guildId,{ title: 'Café reference',body: 'Selenite is a lunar mineral. Cafe\u0301 月亮 guidance.',enabled: true });
      await db.pool.query('INSERT INTO guild_settings(guild_id) VALUES($1)',[otherGuild]);
      await db.pool.query('INSERT INTO knowledge_entries(guild_id,id,title,body) VALUES($1,$2,$3,$4)',[otherGuild,e.id,'Foreign selenite','Foreign secret selenite.']);
      await db.pool.query('INSERT INTO knowledge_chunks(guild_id,entry_id,ordinal,title,body) VALUES($1,$2,0,$3,$4)',[otherGuild,e.id,'Foreign selenite','Foreign secret selenite.']);
      const found = await repo.retrieve(guildId,'selenite?!',signal); expect(found).toHaveLength(1); expect(found[0]!.text).toContain('lunar mineral'); expect(JSON.stringify(found)).not.toContain('Foreign secret');
      expect(await repo.current(guildId,found,signal)).toBe(true); expect(await repo.current(otherGuild,found,signal)).toBe(false);
      expect(await repo.retrieve(guildId,'unmatched-xyzzy',signal)).toEqual([]); expect(await repo.retrieve(guildId,'!!! 🌌',signal)).toEqual([]);
      expect((await repo.retrieve(guildId,'cafe\u0301 月亮',signal)).length).toBeGreaterThan(0);
      let current = await service.update(owner,guildId,e.id,{ revision: 1,patch: { enabled: false } });
      expect(await repo.retrieve(guildId,'selenite',signal)).toEqual([]); expect(await repo.current(guildId,found,signal)).toBe(false);
      current = await service.update(owner,guildId,e.id,{ revision: current.revision,patch: { enabled: true,body: 'Nebula facts are now current.' } });
      expect(await repo.retrieve(guildId,'selenite',signal)).toEqual([]); expect((await repo.retrieve(guildId,'nebula',signal))[0]).toMatchObject({ revision: current.revision,text: 'Nebula facts are now current.' });
      expect(await repo.current(guildId,found,signal)).toBe(false);
      await service.remove(owner,guildId,e.id,{ revision: current.revision }); expect(await repo.retrieve(guildId,'nebula',signal)).toEqual([]);
      expect((await db.pool.query('SELECT 1 FROM knowledge_chunks WHERE guild_id=$1',[otherGuild])).rowCount).toBe(1);
      await db.pool.query('DELETE FROM guild_settings WHERE guild_id=$1',[otherGuild]); expect((await db.pool.query('SELECT 1 FROM knowledge_entries WHERE guild_id=$1',[otherGuild])).rowCount).toBe(0);
      expect((await db.pool.query('SELECT 1 FROM approved_guilds WHERE guild_id=$1',[guildId])).rowCount).toBe(1);
    } finally { await f.app.close(); }
  });
  it('enforces entry and total-body quotas atomically, including disabled entries',async () => {
    const f = await webFixture(db); try { const service = new KnowledgeService(db,f.access);
      await db.pool.query("INSERT INTO knowledge_entries(guild_id,title,body,enabled) SELECT $1,'Seed '||n,'x',false FROM generate_series(1,49) n",[guildId]);
      const race = await Promise.allSettled([service.create(owner,guildId,{ title: 'First',body: 'facts' }),service.create(owner,guildId,{ title: 'Second',body: 'facts' })]);
      expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(race.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'knowledge_limit' } });
      await db.pool.query('DELETE FROM knowledge_entries WHERE guild_id=$1',[guildId]);
      await db.pool.query("INSERT INTO knowledge_entries(guild_id,title,body) SELECT $1,'Seed '||n,repeat('x',100000) FROM generate_series(1,10) n",[guildId]);
      await expect(service.create(owner,guildId,{ title: 'Too much',body: 'x' })).rejects.toMatchObject({ code: 'knowledge_limit' });
      const row = (await service.list(owner,guildId)).entries[0]!; await service.update(owner,guildId,row.id,{ revision: row.revision,patch: { body: 'x' } });
      await expect(service.create(owner,guildId,{ title: 'One over',body: 'x'.repeat(100000) })).rejects.toMatchObject({ code: 'knowledge_limit' });
      await service.create(owner,guildId,{ title: 'Exactly full',body: 'x'.repeat(99999) }); expect((await service.list(owner,guildId)).totalBodyCharacters).toBe(1000000);
    } finally { await f.app.close(); }
  });
  it('keeps boundary whitespace in the saved body but never retrieves unusable title-only chunks',async () => {
    const f = await webFixture(db); try {
      const service = new KnowledgeService(db,f.access),repo = new KnowledgeRepository(db),signal = new AbortController().signal;
      const body = 'fact '.repeat(200)+'\n',e = await service.create(owner,guildId,{ title: 'Selenite reference',body });
      expect((await service.get(owner,guildId,e.id)).body).toBe(body);
      const found = await repo.retrieve(guildId,'selenite',signal);
      expect(found).toHaveLength(1); expect(found[0]!.text.trim()).not.toBe('');
      expect(await repo.current(guildId,found,signal)).toBe(true);
    } finally { await f.app.close(); }
  });
});
