import { ProviderRouter } from '../../src/providers/router.js';
import { PostgresProviderRepository } from '../../src/providers/store.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GoogleAdapter } from '../../src/providers/google.js';
import { ProviderFailure } from '../../src/providers/http.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import type { BotRequest,GenerationInput,ProviderId } from '../../src/domain/types.js';
import type { ProviderAdapter } from '../../src/providers/common.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,expect,it } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { UsageService } from '../../src/usage/service.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
const guild = '111111111111111111', other = '222222222222222222';
const now = new Date('2026-11-13T23:59:59Z'), tomorrow = new Date('2026-11-14T00:00:01Z');
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL), name = `galaxy_usage_test_${randomUUID().replaceAll('-','')}`;
const admin = new Pool({ connectionString: url.toString(),max: 1 });
let db: Database, usage: UsageService;
const known = { inputTokens: 20,outputTokens: 10,reasoningTokens: 4,totalTokens: 30,certainty: 'reported' as const };
async function totals(day = '2026-11-13') { return (await db.pool.query('SELECT * FROM daily_usage WHERE guild_id=$1 AND provider=$2 AND utc_date=$3',[guild,'openai',day])).rows[0]; }
describe('atomic usage reservations and settlement', () => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); usage = new UsageService(db); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE guild_settings,approved_guilds,web_sessions,audit_events CASCADE');
    for (const id of [guild,other]) {
      await db.pool.query('INSERT INTO guild_settings(guild_id,enabled) VALUES($1,true)',[id]);
      await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[id]);
      for (const [provider,priority] of [['openai',1],['google',2]]) await db.pool.query('INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,$2,$3,$4,1,$5,$6,100)',[id,provider,Buffer.alloc(32),Buffer.alloc(12),'test-model',priority]);
    }
  });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('does not overspend under concurrent attempts and records a duplicate attempt once', async () => {
    const attempt = randomUUID();
    const results = await Promise.all([usage.reserveUsage(guild,'openai',attempt,70,now),usage.reserveUsage(guild,'openai',randomUUID(),70,now)]);
    expect(results.filter(Boolean)).toHaveLength(1); expect((await totals()).reserved_tokens).toBe('70');
    const accepted = results.find(Boolean)!;
    expect(await usage.reserveUsage(guild,'openai',accepted.attemptId,70,now)).toBeNull();
    expect((await totals()).requests).toBe('1');
  });
  it('settles once across midnight into the original UTC bucket', async () => {
    const r = (await usage.reserveUsage(guild,'openai',randomUUID(),80,now))!;
    await Promise.all([usage.settleUsage(r.id,known,'known'),usage.settleUsage(r.id,known,'known')]);
    expect(await totals()).toMatchObject({ total_tokens: '30',input_tokens: '20',output_tokens: '10',reasoning_tokens: '4',reserved_tokens: '0',requests: '1' });
    expect(await totals('2026-11-14')).toBeUndefined();
    const next = await usage.reserveUsage(guild,'openai',randomUUID(),100,tomorrow);
    expect(next?.utcDate).toBe('2026-11-14'); expect((await totals()).total_tokens).toBe('30');
  });
  it('retains the full timeout charge, then reconciles verified usage idempotently', async () => {
    const r = (await usage.reserveUsage(guild,'openai',randomUUID(),80,now))!;
    await usage.settleUsage(r.id,null,'uncertain'); await usage.settleUsage(r.id,null,'uncertain');
    expect(await totals()).toMatchObject({ uncertain_tokens: '80',reserved_tokens: '0',total_tokens: '0' });
    expect(await usage.reserveUsage(guild,'openai',randomUUID(),21,now)).toBeNull();
    await usage.settleUsage(r.id,known,'known'); await usage.settleUsage(r.id,known,'known');
    expect(await totals()).toMatchObject({ uncertain_tokens: '0',total_tokens: '30',requests: '1' });
  });
  it('releases provably unsent calls, but rejects invalid usage and cross-guild attempt reuse', async () => {
    const attempt = randomUUID(), r = (await usage.reserveUsage(guild,'openai',attempt,80,now))!;
    await expect(usage.settleUsage(r.id,{ ...known,totalTokens: 29 },'known')).rejects.toThrow();
    expect((await totals()).reserved_tokens).toBe('80');
    expect(await usage.reserveUsage(other,'openai',attempt,80,now)).toBeNull();
    await usage.settleUsage(r.id,null,'not_sent'); await usage.settleUsage(r.id,null,'not_sent');
    expect((await totals()).reserved_tokens).toBe('0');
  });
  it('routes a failed primary and successful fallback through the real ledger and suppresses replay', async () => {
    const cipher = new CredentialCipher(1,new Map([[1,Buffer.alloc(32,7)]]));
    for (const provider of ['openai','google'] as const) {
      const e = cipher.seal(guild,provider,'fake-provider-key');
      await db.pool.query('UPDATE provider_configs SET ciphertext=$3,nonce=$4,key_version=$5,model_id=$6,daily_allowance=1100000 WHERE guild_id=$1 AND provider=$2',[guild,provider,e.ciphertext,e.nonce,e.keyVersion,provider === 'openai' ? 'gpt-5.4-mini-2026-03-17' : 'gemini-3.5-flash-lite']);
    }
    let calls = 0;
    const adapters = new Map<ProviderId,ProviderAdapter>([
      ['openai',new OpenAIAdapter(async r => { calls++; return r.url.endsWith('/input_tokens') ? { status: 200,headers: {},body: { input_tokens: 20 } } : { status: 500,headers: {},body: { error: { message: 'private upstream detail' } } }; })],
      ['google',new GoogleAdapter(async () => { calls++; return { status: 200,headers: {},body: { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { total_input_tokens: 20,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 30 } } }; })],
    ]);
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,cipher,adapters,() => now);
    const request: BotRequest = { id: 'event_1',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'ignored',context: [],modelId: 'ignored',mode: 'direct',maxGenerationTokens: 2048 };
    expect((await router.generateWithFallback(request,input)).kind).toBe('answer');
    expect(calls).toBe(3);
    expect((await db.pool.query('SELECT provider,requests,total_tokens,uncertain_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1 ORDER BY provider',[guild])).rows).toEqual([
      { provider: 'google',requests: '1',total_tokens: '30',uncertain_tokens: '0',reserved_tokens: '0' },
      { provider: 'openai',requests: '1',total_tokens: '0',uncertain_tokens: '2068',reserved_tokens: '0' },
    ]);
    expect((await db.pool.query("SELECT state FROM request_receipts WHERE guild_id=$1 AND event_id='generation:event_1'",[guild])).rows[0].state).toBe('uncertain');
    await expect(router.generateWithFallback(request,input)).rejects.toThrow('request_not_claimed'); expect(calls).toBe(3);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM operational_errors')).rows)).not.toContain('private upstream detail');
  });
  it.each([100,1000,2048,5000,50000,1050623])('keeps a short Google request within a small daily allowance of %i without increasing it', async allowance => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=$2 WHERE guild_id=$1 AND provider='google'",[guild,allowance]);
    let calls = 0;
    const adapter = new GoogleAdapter(async () => { calls++; throw new Error('generation must not start'); });
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([['google',adapter]]),() => now);
    const request: BotRequest = { id: 'short_google',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'Be kind.',context: [{ id: '1',authorId: other,kind: 'human',text: 'Hi',timestamp: now }],modelId: 'gemini-3.5-flash-lite',mode: 'direct',maxGenerationTokens: 2048 };
    await expect(router.generateWithFallback(request,input)).rejects.toThrow('providers_unavailable');
    expect(calls).toBe(0);
    expect((await db.pool.query('SELECT count(*) FROM usage_reservations WHERE guild_id=$1',[guild])).rows[0].count).toBe('0');
    expect((await db.pool.query("SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].daily_allowance).toBe(String(allowance));
  });
  it('holds the full Google ceiling before a short mocked call, then reconciles without changing the allowance', async () => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=1050624 WHERE guild_id=$1 AND provider='google'",[guild]);
    let calls = 0;
    const adapter = new GoogleAdapter(async r => {
      calls++; expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect((await db.pool.query("SELECT reserved_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].reserved_tokens).toBe('1050624');
      return { status: 200,headers: {},body: { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { total_input_tokens: 20,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 30 } } };
    });
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([['google',adapter]]),() => now);
    const request: BotRequest = { id: 'short_google_exact',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'Be kind.',context: [{ id: '1',authorId: other,kind: 'human',text: 'Hi',timestamp: now }],modelId: 'gemini-3.5-flash-lite',mode: 'direct',maxGenerationTokens: 2048 };
    expect((await router.generateWithFallback(request,input)).kind).toBe('answer'); expect(calls).toBe(1);
    expect((await db.pool.query("SELECT total_tokens,reserved_tokens,uncertain_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0]).toEqual({ total_tokens: '30',reserved_tokens: '0',uncertain_tokens: '0' });
    expect((await db.pool.query("SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].daily_allowance).toBe('1050624');
  });
  it.each(['total_tokens','uncertain_tokens','reserved_tokens'])('counts existing %s against Google headroom rather than treating the daily allowance as available balance', async column => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=1050624 WHERE guild_id=$1 AND provider='google'",[guild]);
    await db.pool.query(`INSERT INTO daily_usage(guild_id,provider,utc_date,${column}) VALUES($1,'google','2026-11-13',1)`,[guild]);
    expect((await new PostgresProviderRepository(db).load(guild,now))!.candidates).toEqual([]);
    expect(await usage.reserveUsage(guild,'google',randomUUID(),1050624,now)).toBeNull();
    expect((await db.pool.query("SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].daily_allowance).toBe('1050624');
  });
  it('persists Retry-After and permanent faults, without resetting on allowance/priority edits', async () => {
    await db.pool.query('UPDATE provider_configs SET daily_allowance=1100000 WHERE guild_id=$1',[guild]);
    const store = new PostgresProviderRepository(db),c = (await store.load(guild))!.candidates[0]!;
    await store.failure(guild,c,new ProviderFailure('rate_limit','provider_rate_limit',{ retryAfterMs: 120000 }),now,randomUUID());
    const limited = (await store.load(guild))!.candidates[0]!;
    expect(limited.retryAt).toBe(now.getTime()+120000);
    await store.failure(guild,limited,new ProviderFailure('auth','provider_auth'),now,randomUUID());
    expect((await store.load(guild))!.candidates[0]!.blocked).toBe(true);
    await db.pool.query('UPDATE provider_configs SET daily_allowance=1099999,revision=revision+1 WHERE guild_id=$1 AND provider=$2',[guild,'openai']);
    expect((await store.load(guild))!.candidates[0]!.blocked).toBe(true);
    await db.pool.query('UPDATE provider_configs SET nonce=$3,revision=revision+1 WHERE guild_id=$1 AND provider=$2',[guild,'openai',Buffer.alloc(12,5)]);
    const replaced = (await store.load(guild))!.candidates[0]!; expect(replaced.blocked).toBe(false);
    await store.failure(guild,replaced,new ProviderFailure('transient','provider_transient'),now,randomUUID());
    const recovered = (await store.load(guild))!.candidates[0]!; expect(recovered.blocked).toBe(false); expect(recovered.retryAt).toBe(now.getTime()+30000);
    for (let n = 0; n < 8; n++) await store.failure(guild,replaced,new ProviderFailure('transient','provider_transient'),now,randomUUID());
    expect((await store.load(guild))!.candidates[0]!.retryAt).toBe(now.getTime()+900000);
    await store.failure(guild,replaced,new ProviderFailure('rate_limit','provider_rate_limit',{ retryAfterMs: 3600000 }),now,randomUUID());
    expect((await store.load(guild))!.candidates[0]!.retryAt).toBe(now.getTime()+3600000);
  });
  it('does not blame a replacement configuration for a late over-bound result', async () => {
    const r = (await usage.reserveUsage(guild,'openai',randomUUID(),20,now))!;
    await db.pool.query('UPDATE provider_configs SET nonce=$3,revision=revision+1 WHERE guild_id=$1 AND provider=$2',[guild,'openai',Buffer.alloc(12,8)]);
    await usage.settleUsage(r.id,known,'known');
    expect((await totals()).total_tokens).toBe('30');
    expect((await db.pool.query("SELECT * FROM provider_health WHERE guild_id=$1 AND provider='openai' AND blocked",[guild])).rowCount).toBe(0);
  });
  it('records over-bound actual usage, blocks that configuration and does not free uncertain attempts as unsent', async () => {
    const a = (await usage.reserveUsage(guild,'openai',randomUUID(),20,now))!;
    await usage.settleUsage(a.id,known,'known');
    expect((await totals()).total_tokens).toBe('30');
    expect(await usage.reserveUsage(guild,'openai',randomUUID(),20,now)).toBeNull();
    expect((await db.pool.query("SELECT blocked FROM provider_health WHERE guild_id=$1 AND provider='openai'",[guild])).rows[0].blocked).toBe(true);
    const b = (await usage.reserveUsage(guild,'google',randomUUID(),50,now))!;
    await usage.settleUsage(b.id,null,'uncertain'); await usage.settleUsage(b.id,null,'not_sent');
    expect((await db.pool.query("SELECT uncertain_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].uncertain_tokens).toBe('50');
  });
  it('refuses revoked/disabled/unfunded guilds and counts each provider separately', async () => {
    await db.pool.query('DELETE FROM approved_guilds WHERE guild_id=$1',[guild]);
    expect(await usage.reserveUsage(guild,'openai',randomUUID(),50,now)).toBeNull();
    await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]);
    const a = (await usage.reserveUsage(guild,'openai',randomUUID(),80,now))!;
    const b = (await usage.reserveUsage(guild,'google',randomUUID(),80,now))!;
    await usage.settleUsage(a.id,null,'uncertain'); await usage.settleUsage(b.id,known,'known');
    expect((await db.pool.query('SELECT provider,uncertain_tokens,total_tokens,requests FROM daily_usage WHERE guild_id=$1 ORDER BY provider',[guild])).rows).toEqual([{ provider: 'google',uncertain_tokens: '0',total_tokens: '30',requests: '1' },{ provider: 'openai',uncertain_tokens: '80',total_tokens: '0',requests: '1' }]);
  });
});
