import { ProviderRouter } from '../../src/providers/router.js';
import { PostgresProviderRepository } from '../../src/providers/store.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GoogleAdapter } from '../../src/providers/google.js';
import type { HttpTransport } from '../../src/providers/http.js';
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
  it('does not admit estimates beyond the allowance under concurrent attempts and records a duplicate attempt once', async () => {
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
      ['google',new GoogleAdapter(async r => { calls++; if (r.url.endsWith(':countTokens')) return { status: 200,headers: {},body: { totalTokens: 120 } }; return { status: 200,headers: {},body: { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { total_input_tokens: 20,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 30 } } }; })],
    ]);
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,cipher,adapters,() => now);
    const request: BotRequest = { id: 'event_1',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'ignored',context: [],modelId: 'ignored',mode: 'direct',maxGenerationTokens: 2048 };
    expect((await router.generateWithFallback(request,input)).kind).toBe('answer');
    expect(calls).toBe(4);
    expect((await db.pool.query('SELECT provider,requests,total_tokens,uncertain_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1 ORDER BY provider',[guild])).rows).toEqual([
      { provider: 'google',requests: '1',total_tokens: '30',uncertain_tokens: '0',reserved_tokens: '0' },
      { provider: 'openai',requests: '1',total_tokens: '0',uncertain_tokens: '2068',reserved_tokens: '0' },
    ]);
    expect((await db.pool.query("SELECT state FROM request_receipts WHERE guild_id=$1 AND event_id='generation:event_1'",[guild])).rows[0].state).toBe('uncertain');
    await expect(router.generateWithFallback(request,input)).rejects.toThrow('request_not_claimed'); expect(calls).toBe(4);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM operational_errors')).rows)).not.toContain('private upstream detail');
  });
  it.each([100,1000,2048,2199,2200,5000])('uses request-based Google reservations for a daily allowance of %i, without increasing it', async allowance => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=$2 WHERE guild_id=$1 AND provider='google'",[guild,allowance]);
    let counts = 0, generations = 0;
    const adapter = new GoogleAdapter(async r => {
      if (r.url.endsWith(':countTokens')) { counts++; return { status: 200,headers: {},body: { totalTokens: 120 } }; }
      generations++;
      expect((await db.pool.query("SELECT reserved_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].reserved_tokens).toBe('2200');
      return { status: 200,headers: {},body: { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { total_input_tokens: 20,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 30 } } };
    });
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([['google',adapter]]),() => now);
    const request: BotRequest = { id: 'short_google',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'Be kind.',context: [{ id: '1',authorId: other,kind: 'human',text: 'Hi',timestamp: now }],modelId: 'gemini-3.5-flash-lite',mode: 'direct',maxGenerationTokens: 2048 };
    if (allowance >= 2200) expect((await router.generateWithFallback(request,input)).kind).toBe('answer');
    else await expect(router.generateWithFallback(request,input)).rejects.toThrow('providers_unavailable');
    expect(counts).toBe(allowance >= 2048 ? 1 : 0); expect(generations).toBe(allowance >= 2200 ? 1 : 0);
    expect((await db.pool.query('SELECT count(*) FROM usage_reservations WHERE guild_id=$1',[guild])).rows[0].count).toBe(allowance >= 2200 ? '1' : '0');
    if (generations) expect((await db.pool.query("SELECT total_tokens,reserved_tokens,uncertain_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0]).toEqual({ total_tokens: '30',reserved_tokens: '0',uncertain_tokens: '0' });
    expect((await db.pool.query("SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].daily_allowance).toBe(String(allowance));
  });
  it.each(['total_tokens','uncertain_tokens','reserved_tokens'])('includes existing %s when admitting the counted Google estimate', async column => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=2200 WHERE guild_id=$1 AND provider='google'",[guild]);
    await db.pool.query(`INSERT INTO daily_usage(guild_id,provider,utc_date,${column}) VALUES($1,'google','2026-11-13',1)`,[guild]);
    expect((await new PostgresProviderRepository(db).load(guild,now))!.candidates).toHaveLength(1);
    expect(await usage.reserveUsage(guild,'google',randomUUID(),2200,now)).toBeNull();
    expect((await db.pool.query("SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].daily_allowance).toBe('2200');
  });
  it.each(['openai','google'] as const)('records underestimated %s input above the allowance and skips the next preflight', async provider => {
    await db.pool.query('DELETE FROM provider_configs WHERE guild_id=$1 AND provider<>$2',[guild,provider]);
    await db.pool.query('UPDATE provider_configs SET model_id=$3,daily_allowance=2200 WHERE guild_id=$1 AND provider=$2',[guild,provider,provider === 'openai' ? 'gpt-5.4-mini-2026-03-17' : 'gemini-3.5-flash-lite']);
    let calls = 0;
    const transport: HttpTransport = async r => {
      calls++;
      if (r.url.endsWith('/input_tokens')) return { status: 200,headers: {},body: { input_tokens: 120 } };
      if (r.url.endsWith(':countTokens')) return { status: 200,headers: {},body: { totalTokens: 120 } };
      expect((await db.pool.query('SELECT reserved_tokens FROM daily_usage WHERE guild_id=$1 AND provider=$2',[guild,provider])).rows[0].reserved_tokens).toBe(provider === 'google' ? '2200' : '2168');
      const text = '{"kind":"answer","text":"Hello"}';
      return { status: 200,headers: {},body: provider === 'openai'
        ? { status: 'completed',output: [{ type: 'message',content: [{ type: 'output_text',text }] }],usage: { input_tokens: 2290,output_tokens: 10,output_tokens_details: { reasoning_tokens: 4 },total_tokens: 2300 } }
        : { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text }] }],usage: { total_input_tokens: 2290,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 2300 } } };
    };
    const adapter = provider === 'openai' ? new OpenAIAdapter(transport) : new GoogleAdapter(transport);
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([[provider,adapter]]),() => now);
    const request: BotRequest = { id: 'underestimate',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'Be kind.',context: [],modelId: 'ignored',mode: 'direct',maxGenerationTokens: 2048 };
    expect((await router.generateWithFallback(request,input)).usage.totalTokens).toBe(2300);
    await expect(router.generateWithFallback({ ...request,id: 'exhausted' },input)).rejects.toThrow('providers_unavailable');
    expect(calls).toBe(2);
    expect((await db.pool.query('SELECT total_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1 AND provider=$2',[guild,provider])).rows[0]).toEqual({ total_tokens: '2300',reserved_tokens: '0' });
    expect((await db.pool.query('SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider=$2',[guild,provider])).rows[0].daily_allowance).toBe('2200');
    expect((await db.pool.query('SELECT * FROM provider_health WHERE guild_id=$1',[guild])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT safe_code FROM operational_errors WHERE guild_id=$1',[guild])).rows).toEqual([{ safe_code: 'usage_estimate_exceeded' }]);
  });
  it('keeps a small Google timeout reservation and stops later calls when remaining headroom is insufficient', async () => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE guild_settings SET answer_target_tokens=128,max_generation_tokens=256 WHERE guild_id=$1",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=500 WHERE guild_id=$1 AND provider='google'",[guild]);
    const instant = new Date('2026-11-13T12:00:00Z');
    let calls = 0;
    const adapter = new GoogleAdapter(async r => { calls++; if (r.url.endsWith(':countTokens')) return { status: 200,headers: {},body: { totalTokens: 120 } }; throw new Error('private transport timeout'); });
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([['google',adapter]]),() => instant);
    const request: BotRequest = { id: 'timeout',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'Be kind.',context: [],modelId: 'ignored',mode: 'direct',maxGenerationTokens: 2048 };
    await expect(router.generateWithFallback(request,input)).rejects.toThrow('providers_unavailable');
    expect((await db.pool.query("SELECT uncertain_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0]).toEqual({ uncertain_tokens: '408',reserved_tokens: '0' });
    // Advance beyond transient backoff: budget alone must still prevent another call.
    const later = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([['google',adapter]]),() => new Date(instant.getTime()+60000));
    await expect(later.generateWithFallback({ ...request,id: 'after_timeout' },input)).rejects.toThrow('providers_unavailable');
    expect(calls).toBe(2);
    expect((await db.pool.query("SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].daily_allowance).toBe('500');
  });
  it.each(['invalid_input','input_too_large'])('does not poison provider health after request-local %s', async code => {
    await db.pool.query('UPDATE provider_configs SET daily_allowance=1100000 WHERE guild_id=$1',[guild]);
    const store = new PostgresProviderRepository(db),c = (await store.load(guild,now))!.candidates[0]!;
    await store.failure(guild,c,new ProviderFailure('configuration',code,{ notSent: true }),now,randomUUID());
    expect((await db.pool.query('SELECT * FROM provider_health WHERE guild_id=$1',[guild])).rowCount).toBe(0);
    expect(await usage.reserveUsage(guild,'openai',randomUUID(),80,now)).not.toBeNull();
    // A request-local failure must also preserve an existing real auth fault.
    await store.failure(guild,c,new ProviderFailure('auth','provider_auth'),now,randomUUID());
    await store.failure(guild,c,new ProviderFailure('configuration',code,{ notSent: true }),now,randomUUID());
    expect((await store.load(guild,now))!.candidates[0]!.blocked).toBe(true);
  });
  it('allows a short Google request after rejecting an oversized counted request', async () => {
    await db.pool.query("DELETE FROM provider_configs WHERE guild_id=$1 AND provider='openai'",[guild]);
    await db.pool.query("UPDATE provider_configs SET model_id='gemini-3.5-flash-lite',daily_allowance=5000 WHERE guild_id=$1 AND provider='google'",[guild]);
    let counts = 0, generations = 0;
    const adapter = new GoogleAdapter(async r => {
      if (r.url.endsWith(':countTokens')) return { status: 200,headers: {},body: { totalTokens: ++counts === 1 ? 1048576 : 120 } };
      generations++; return { status: 200,headers: {},body: { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { total_input_tokens: 20,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 30 } } };
    });
    const router = new ProviderRouter(new PostgresProviderRepository(db),usage,{ open() { return 'fake-key'; } },new Map([['google',adapter]]),() => now);
    const request: BotRequest = { id: 'oversized',guildId: guild,channelId: other,userId: other,source: 'ask',receivedAt: now };
    const input: GenerationInput = { instructions: 'Be kind.',context: [],modelId: 'ignored',mode: 'direct',maxGenerationTokens: 2048 };
    await expect(router.generateWithFallback(request,input)).rejects.toThrow('providers_unavailable');
    expect((await router.generateWithFallback({ ...request,id: 'short_after_oversized' },input)).kind).toBe('answer');
    expect(counts).toBe(2); expect(generations).toBe(1);
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
  it('records late underestimated usage without blaming a replacement configuration', async () => {
    const r = (await usage.reserveUsage(guild,'openai',randomUUID(),20,now))!;
    await db.pool.query('UPDATE provider_configs SET nonce=$3,revision=revision+1 WHERE guild_id=$1 AND provider=$2',[guild,'openai',Buffer.alloc(12,8)]);
    await usage.settleUsage(r.id,known,'known');
    expect((await totals()).total_tokens).toBe('30');
    expect((await db.pool.query("SELECT * FROM provider_health WHERE guild_id=$1 AND provider='openai' AND blocked",[guild])).rowCount).toBe(0);
  });
  it('records underestimated usage without permanent blocking and does not free uncertain attempts as unsent', async () => {
    const a = (await usage.reserveUsage(guild,'openai',randomUUID(),20,now))!;
    await usage.settleUsage(a.id,known,'known');
    expect((await totals()).total_tokens).toBe('30');
    expect(await usage.reserveUsage(guild,'openai',randomUUID(),20,now)).not.toBeNull();
    expect((await db.pool.query("SELECT * FROM provider_health WHERE guild_id=$1 AND provider='openai' AND blocked",[guild])).rowCount).toBe(0);
    const b = (await usage.reserveUsage(guild,'google',randomUUID(),50,now))!;
    await usage.settleUsage(b.id,null,'uncertain'); await usage.settleUsage(b.id,null,'not_sent');
    expect((await db.pool.query("SELECT uncertain_tokens FROM daily_usage WHERE guild_id=$1 AND provider='google'",[guild])).rows[0].uncertain_tokens).toBe('50');
  });
  it.each(['openai','google'] as const)('settles concurrent underestimated %s calls in full, then blocks exhaustion until the next UTC day', async provider => {
    const reservations = await Promise.all([usage.reserveUsage(guild,provider,randomUUID(),40,now),usage.reserveUsage(guild,provider,randomUUID(),40,now)]);
    expect(reservations.every(Boolean)).toBe(true);
    const actual = { ...known,inputTokens: 50,totalTokens: 60 };
    await Promise.all(reservations.map(r => usage.settleUsage(r!.id,actual,'known')));
    await Promise.all(reservations.map(r => usage.settleUsage(r!.id,actual,'known')));
    expect((await db.pool.query('SELECT total_tokens,input_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1 AND provider=$2',[guild,provider])).rows[0]).toEqual({ total_tokens: '120',input_tokens: '100',reserved_tokens: '0' });
    expect(await usage.reserveUsage(guild,provider,randomUUID(),1,now)).toBeNull();
    await db.pool.query('UPDATE guild_settings SET answer_target_tokens=5,max_generation_tokens=10 WHERE guild_id=$1',[guild]);
    expect((await new PostgresProviderRepository(db).load(guild,now))!.candidates.some(c => c.provider === provider)).toBe(false);
    expect((await db.pool.query('SELECT daily_allowance FROM provider_configs WHERE guild_id=$1 AND provider=$2',[guild,provider])).rows[0].daily_allowance).toBe('100');
    expect(await usage.reserveUsage(guild,provider,randomUUID(),100,tomorrow)).not.toBeNull();
  });
  it('reconciles an uncertain underestimate above the allowance once, without truncating actual usage', async () => {
    const r = (await usage.reserveUsage(guild,'openai',randomUUID(),80,now))!;
    await usage.settleUsage(r.id,null,'uncertain');
    const actual = { ...known,inputTokens: 120,totalTokens: 130 };
    await usage.settleUsage(r.id,actual,'known'); await usage.settleUsage(r.id,actual,'known');
    expect(await totals()).toMatchObject({ total_tokens: '130',uncertain_tokens: '0',reserved_tokens: '0' });
    expect(await usage.reserveUsage(guild,'openai',randomUUID(),1,now)).toBeNull();
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
