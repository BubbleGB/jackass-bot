import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { webFixture,guildId,owner,delegate,otherGuild } from '../helpers/web-fixture.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_web_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database;
const origin = 'http://127.0.0.1:4173';
type Fixture = Awaited<ReturnType<typeof webFixture>>;
async function login(f: Fixture,code = 'owner',returnTo = `/servers/${guildId}`,previous?: string) {
  const start = await f.app.inject({ url: `/auth/discord?returnTo=${encodeURIComponent(returnTo)}` });
  const state = new URL(start.headers.location!).searchParams.get('state')!,binding = start.cookies[0]!;
  const r = await f.app.inject({ url: `/auth/discord/callback?code=${code}&state=${state}&iss=https%3A%2F%2Fdiscord.com`,cookies: { [binding.name]: binding.value,...(previous ? { gn_session: previous } : {}) } });
  const cookie = r.cookies.find(c => c.name === 'gn_session')!;
  const session = await f.app.inject({ url: '/api/session',cookies: { gn_session: cookie.value } });
  return { cookie: cookie.value,csrf: session.json().csrf as string,response: r,state,binding };
}
describe('dashboard HTTP authentication and current authorization',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => { await db.pool.query('TRUNCATE daily_usage,usage_reservations,request_receipts,guild_settings,approved_guilds,web_sessions,oauth_states CASCADE'); });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('requires one-use browser-bound state, rotates the session and preserves the Task6 deep link',async () => {
    const f = await webFixture(db);
    try {
      const a = await login(f); expect(a.response.statusCode).toBe(302); expect(a.response.headers.location).toBe(`/servers/${guildId}`);
      const replay = await f.app.inject({ url: `/auth/discord/callback?code=owner&state=${a.state}`,cookies: { [a.binding.name]: a.binding.value } }); expect(replay.statusCode).toBe(400);
      const b = await login(f,'owner','/servers',a.cookie); expect(b.cookie).not.toBe(a.cookie);
      expect((await f.app.inject({ url: '/api/session',cookies: { gn_session: a.cookie } })).statusCode).toBe(401);
      expect(a.response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/HttpOnly.*SameSite=Lax/)]));
      expect((await db.pool.query('SELECT token_ciphertext FROM web_sessions')).rows.every(r => r.token_ciphertext === null)).toBe(true);
    } finally { await f.app.close(); }
  });
  it('rejects state mismatch, absent browser cookie, expired state, unsafe redirect and raw OAuth errors',async () => {
    const f = await webFixture(db);
    try {
      const start = await f.app.inject({ url: '/auth/discord?returnTo=https://evil.test' }); expect(start.statusCode).toBe(400);
      const s = await f.app.inject({ url: '/auth/discord' }),state = new URL(s.headers.location!).searchParams.get('state')!;
      expect((await f.app.inject({ url: `/auth/discord/callback?state=${state}&code=owner&iss=https%3A%2F%2Fdiscord.com` })).statusCode).toBe(400);
      await db.pool.query("UPDATE oauth_states SET expires_at=now()-interval '1 second'");
      const expired = await f.app.inject({ url: `/auth/discord/callback?state=${state}&code=owner&iss=https%3A%2F%2Fdiscord.com`,cookies: { [s.cookies[0]!.name]: s.cookies[0]!.value } }); expect(expired.statusCode).toBe(400);
      const err = await f.app.inject({ url: '/auth/discord/callback?state=bad&code=private-oauth-secret' }); expect(err.body).not.toContain('private-oauth-secret');
    } finally { await f.app.close(); }
  });
  it('blocks cross-origin and missing-CSRF mutations even with a valid session, then logs out',async () => {
    const f = await webFixture(db);
    try {
      const a = await login(f),base = { method: 'PATCH' as const,url: `/api/guilds/${guildId}/settings`,cookies: { gn_session: a.cookie },payload: { revision: 2,patch: { instructions: 'Hi' } } };
      expect((await f.app.inject(base)).statusCode).toBe(403);
      expect((await f.app.inject({ ...base,headers: { origin: 'https://evil.test','x-csrf-token': a.csrf } })).statusCode).toBe(403);
      expect((await f.app.inject({ ...base,headers: { origin,'x-csrf-token': a.csrf } })).statusCode).toBe(200);
      expect((await f.app.inject({ method: 'POST',url: '/auth/logout',cookies: { gn_session: a.cookie },headers: { origin,'x-csrf-token': a.csrf } })).statusCode).toBe(204);
      expect((await f.app.inject({ url: '/api/session',cookies: { gn_session: a.cookie } })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it('revalidates forged server IDs, removed roles and departed members within the same session',async () => {
    const f = await webFixture(db);
    try {
      const a = await login(f,'delegate'),cookies = { gn_session: a.cookie };
      expect((await f.app.inject({ url: '/api/servers',cookies })).json().servers).toHaveLength(1);
      expect((await f.app.inject({ url: `/api/guilds/${otherGuild}/settings`,cookies })).statusCode).toBe(403);
      f.removeRole(); expect((await f.app.inject({ url: `/api/guilds/${guildId}/settings`,cookies })).statusCode).toBe(403);
      const b = await login(f); f.leave(); expect((await f.app.inject({ url: `/api/guilds/${guildId}/status`,cookies: { gn_session: b.cookie } })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });
  it('enforces write-only credentials and delegate restrictions through direct backend requests',async () => {
    const f = await webFixture(db);
    try {
      await f.settings.setCredential(owner,guildId,'openai','fake-provider-secret');
      const current = await f.settings.getSettings(owner,guildId);
      await f.settings.updateSettings(owner,guildId,{ providers: [{ provider: 'openai',dailyAllowance: '5000' }] },current.revision);
      const a = await login(f,'delegate'),cookies = { gn_session: a.cookie },headers = { origin,'x-csrf-token': a.csrf };
      const endpoint = `/api/guilds/${guildId}`;
      const read = await f.app.inject({ url: `${endpoint}/settings`,cookies }); expect(read.body).not.toMatch(/fake-provider-secret|ciphertext|nonce/);
      const revision = read.json().settings.revision;
      expect((await f.app.inject({ method: 'PATCH',url: `${endpoint}/settings`,cookies,headers,payload: { revision,patch: { providers: [{ provider: 'openai',dailyAllowance: '6000' }] } } })).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'PATCH',url: `${endpoint}/settings`,cookies,headers,payload: { revision,patch: { providers: [{ provider: 'openai',dailyAllowance: '4000' }] } } })).statusCode).toBe(200);
      expect((await f.app.inject({ method: 'PUT',url: `${endpoint}/providers/openai/key`,cookies,headers,payload: { key: 'fake-replacement' } })).statusCode).toBe(403);
      expect((await f.app.inject({ url: `${endpoint}/providers/openai/key`,cookies })).statusCode).toBe(404);
      expect((await f.app.inject({ method: 'POST',url: `${endpoint}/grants`,cookies,headers,payload: { revision: revision+1,subjectType: 'user',subjectId: delegate,acknowledgeSpendingRisk: true } })).statusCode).toBe(403);
      expect((await f.app.inject({ url: '/api/creator/approvals',cookies })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });
  it('returns a conflict without overwriting newer settings and protects approval management',async () => {
    const f = await webFixture(db);
    try {
      const a = await login(f),cookies = { gn_session: a.cookie },headers = { origin,'x-csrf-token': a.csrf },url = `/api/guilds/${guildId}/settings`;
      const first = await f.app.inject({ method: 'PATCH',url,cookies,headers,payload: { revision: 2,patch: { instructions: '<img src=x onerror=alert(1)>' } } }); expect(first.statusCode).toBe(200);
      const conflict = await f.app.inject({ method: 'PATCH',url,cookies,headers,payload: { revision: 2,patch: { instructions: 'stale' } } }); expect(conflict.statusCode).toBe(409);
      expect((await f.app.inject({ url,cookies })).json().settings.instructions).toContain('<img');
      expect((await f.app.inject({ url: '/api/creator/approvals',cookies })).json().guildIds).toEqual([guildId]);
    } finally { await f.app.close(); }
  });  it('uses host-only Secure production cookies and rejects expired sessions',async () => {
    const f = await webFixture(db,'https://galaxy.example.test');
    try {
      const start = await f.app.inject({ url: '/auth/discord' }),state = new URL(start.headers.location!).searchParams.get('state')!;
      const response = await f.app.inject({ url: `/auth/discord/callback?code=owner&state=${state}&iss=https%3A%2F%2Fdiscord.com`,cookies: { [start.cookies[0]!.name]: start.cookies[0]!.value } });
      const c = response.cookies.find(c => c.name === '__Host-gn_session')!; expect(c).toMatchObject({ httpOnly: true,secure: true,sameSite: 'Lax',path: '/' }); expect(c.domain).toBeUndefined();
      await db.pool.query("UPDATE web_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'");
      expect((await f.app.inject({ url: '/api/session',cookies: { [c.name]: c.value } })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it('rate limits login attempts without exposing raw request data',async () => {
    const f = await webFixture(db);
    try { for (let n = 0; n < 20; n++) expect((await f.app.inject({ url: '/auth/discord' })).statusCode).toBe(302); const blocked = await f.app.inject({ url: '/auth/discord?private=secret-value' }); expect(blocked.statusCode).toBe(429); expect(blocked.body).not.toContain('secret-value'); }
    finally { await f.app.close(); }
  });
  it('returns sanitized error codes and hides raw database text behind current guild access',async () => {
    const f = await webFixture(db);
    try {
      await db.pool.query("INSERT INTO operational_errors(guild_id,provider,safe_code,correlation_id) VALUES($1,'openai','provider_auth',$2),($1,'google','private_secret_token',$3)",[guildId,randomUUID(),randomUUID()]);
      const a = await login(f),r = await f.app.inject({ url: `/api/guilds/${guildId}/errors`,cookies: { gn_session: a.cookie } });
      expect(r.body).toContain('provider_auth'); expect(r.body).not.toMatch(/private_secret_token/); expect(r.json().errors.some((e: { code: string }) => e.code === 'provider_error')).toBe(true);
    } finally { await f.app.close(); }
  });
  it('rejects an unexpected OAuth issuer before creating a session',async () => {
    const f = await webFixture(db);
    try { const start = await f.app.inject({ url: '/auth/discord' }),state = new URL(start.headers.location!).searchParams.get('state')!;
      const r = await f.app.inject({ url: `/auth/discord/callback?code=owner&state=${state}&iss=https%3A%2F%2Fevil.test`,cookies: { [start.cookies[0]!.name]: start.cookies[0]!.value } }); expect(r.statusCode).toBe(400); expect((await db.pool.query('SELECT 1 FROM web_sessions')).rowCount).toBe(0);
    } finally { await f.app.close(); }
  });
  it('shows the last accounted provider without inferring billing from definitely-unsent work',async () => {
    const f = await webFixture(db);
    try {
      await db.pool.query("INSERT INTO usage_reservations(guild_id,provider,utc_date,reserved,attempt_id,state) VALUES($1,'google',current_date,100,$2,'uncertain')",[guildId,randomUUID()]);
      const a = await login(f),r = await f.app.inject({ url: `/api/guilds/${guildId}/status`,cookies: { gn_session: a.cookie } }); expect(r.json().lastAccountedProvider).toBe('google');
    } finally { await f.app.close(); }
  });
  it('publishes only the configured contact and least-required guild bot invitation',async () => {
    const f = await webFixture(db);
    try { const r = await f.app.inject({ url: '/api/site' }),body = r.json(),invite = new URL(body.inviteUrl); expect(body.contactUrl).toBeNull(); expect(invite.searchParams.get('client_id')).toBe(owner); expect(invite.searchParams.get('scope')).toBe('bot applications.commands'); expect(invite.searchParams.get('permissions')).toBe('84992'); }
    finally { await f.app.close(); }
  });

});
