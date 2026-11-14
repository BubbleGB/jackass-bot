import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { PostgresConversationConfigRepository } from '../../src/conversation/config.js';
import { DirectEligibility } from '../../src/conversation/eligibility.js';
import { ContextBuilder } from '../../src/conversation/context.js';
import { DirectService } from '../../src/conversation/direct.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import { PostgresProviderRepository } from '../../src/providers/store.js';
import { ProviderRouter } from '../../src/providers/router.js';
import { ProviderInputCounter } from '../../src/providers/context-counter.js';
import { GoogleAdapter } from '../../src/providers/google.js';
import type { ProviderId } from '../../src/domain/types.js';
import type { ProviderAdapter } from '../../src/providers/common.js';
import { ProviderFailure } from '../../src/providers/http.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { UsageService } from '../../src/usage/service.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { guild,channel,request,source,instant } from '../helpers/conversation.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_context_test_${randomUUID().replaceAll('-','')}`;
const admin = new Pool({ connectionString: url.toString(),max: 1 });
const cipher = new CredentialCipher(1,new Map([[1,Buffer.alloc(32,7)]]));
let db: Database,configs: PostgresConversationConfigRepository;
describe('isolated direct context to transactional providers',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); configs = new PostgresConversationConfigRepository(db); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE guild_settings,approved_guilds CASCADE');
    await db.pool.query('INSERT INTO guild_settings(guild_id,enabled,direct_enabled) VALUES($1,true,true)',[guild]);
    await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]);
    const e = cipher.seal(guild,'openai','fake-key');
    await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'openai',$2,$3,$4,'gpt-5.4-mini-2026-03-17',1,5000)",[guild,e.ciphertext,e.nonce,e.keyVersion]);
  });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('reads only the approved enabled guild snapshot with safe provider metadata',async () => {
    const config = await configs.load(guild);
    expect(config).toMatchObject({ guildId: guild,revision: 1,humanContextLimit: 30,selfContextLimit: 5,contextTokenLimit: 8000,providers: [{ provider: 'openai',dailyAllowance: '5000',credentialConfigured: true }] });
    expect(JSON.stringify(config)).not.toMatch(/fake-key|ciphertext|nonce/);
    expect(await configs.load(channel)).toBeNull();
    await db.pool.query('DELETE FROM approved_guilds WHERE guild_id=$1',[guild]); expect(await configs.load(guild)).toBeNull();
    await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]);
    await db.pool.query('UPDATE guild_settings SET enabled=false WHERE guild_id=$1',[guild]); expect(await configs.load(guild)).toBeNull();
  });
  function pipeline(changeBeforeRouting = false) {
    const history = source(),store = new PostgresProviderRepository(db); let counts = 0,generations = 0;
    const adapter = new OpenAIAdapter(async r => {
      if (r.url.endsWith('/input_tokens')) { counts++; return { status: 200,headers: {},body: { input_tokens: 120 } }; }
      generations++;
      expect(r.body.instructions).toContain('Server personality follows:');
      expect((r.body.input as { content: string }[])[0]!.content).toContain('hello');
      return { status: 200,headers: {},body: { status: 'completed',usage: { input_tokens: 20,output_tokens: 10,total_tokens: 30 },output: [{ type: 'message',content: [{ type: 'output_text',text: '{"kind":"answer","text":"Hello"}' }] }] } };
    });
    const adapters = new Map([['openai' as const,adapter]]),router = new ProviderRouter(store,new UsageService(db),cipher,adapters,() => instant);
    const counter = new ProviderInputCounter(store,cipher,adapters,() => instant);
    const gate = new DirectEligibility(configs,history,() => instant),context = new ContextBuilder(history,counter.countInput);
    const provider: Pick<ProviderRouter,'generateWithFallback'> = { async generateWithFallback(...args) { if (changeBeforeRouting) await db.pool.query('UPDATE guild_settings SET revision=revision+1 WHERE guild_id=$1',[guild]); return router.generateWithFallback(...args); } };
    return { service: new DirectService(gate,configs,history,context,provider),counts: () => counts,generations: () => generations };
  }
  it('fits actual request via counters then generates/reserves/settles once without persisting chat',async () => {
    const p = pipeline(); expect((await p.service.handleDirect(request)).status).toBe('accepted');
    expect(p.counts()).toBe(2); expect(p.generations()).toBe(1);
    expect((await db.pool.query('SELECT requests,total_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1',[guild])).rows[0]).toMatchObject({ requests: '1',total_tokens: '30',reserved_tokens: '0' });
    expect((await p.service.handleDirect(request)).status).toBe('cooldown'); expect(p.generations()).toBe(1);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM request_receipts')).rows)).not.toContain('hello');
  });
  it.each(['backoff','allowance'] as const)('enforces fitted input limits when a primary recovers %s before routing',async recovery => {
    await db.pool.query('UPDATE guild_settings SET context_token_limit=150 WHERE guild_id=$1',[guild]);
    const e = cipher.seal(guild,'google','fake-google-key');
    await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'google',$2,$3,$4,'gemini-3.5-flash-lite',2,5000)",[guild,e.ciphertext,e.nonce,e.keyVersion]);
    let time = instant,openGenerations = 0,googleGenerations = 0;
    const store = new PostgresProviderRepository(db),usage = new UsageService(db);
    const candidate = (await store.load(guild,time))!.candidates[0]!;
    const held = recovery === 'allowance' ? await usage.reserveUsage(guild,'openai',randomUUID(),4000,time) : null;
    if (recovery === 'backoff') await store.failure(guild,candidate,new ProviderFailure('transient','provider_transient'),time,randomUUID());
    const adapters = new Map<ProviderId,ProviderAdapter>([
      ['openai',new OpenAIAdapter(async r => { if (r.url.endsWith('/input_tokens')) return { status: 200,headers: {},body: { input_tokens: 200 } }; openGenerations++; throw new Error('oversized primary must not generate'); })],
      ['google',new GoogleAdapter(async r => { if (r.url.endsWith(':countTokens')) return { status: 200,headers: {},body: { totalTokens: 80 } }; googleGenerations++; return { status: 200,headers: {},body: { status: 'completed',steps: [{ type: 'model_output',content: [{ type: 'text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { total_input_tokens: 20,total_output_tokens: 6,total_thought_tokens: 4,total_tokens: 30 } } }; })],
    ]);
    const router = new ProviderRouter(store,usage,cipher,adapters,() => time),counter = new ProviderInputCounter(store,cipher,adapters,() => time),history = source();
    const context = new ContextBuilder(history,counter.countInput),gate = new DirectEligibility(configs,history,() => time);
    const provider: Pick<ProviderRouter,'generateWithFallback'> = { async generateWithFallback(...args) {
      if (held) await usage.settleUsage(held.id,{ inputTokens: 20,outputTokens: 10,reasoningTokens: 0,totalTokens: 30,certainty: 'reported' },'known');
      time = new Date(instant.getTime()+31000);
      return router.generateWithFallback(...args);
    } };
    const service = new DirectService(gate,configs,history,context,provider);
    expect((await service.handleDirect(request)).status).toBe('accepted');
    expect(openGenerations).toBe(0); expect(googleGenerations).toBe(1);
    expect((await db.pool.query("SELECT count(*) FROM usage_reservations WHERE provider='openai'")).rows[0].count).toBe(held ? '1' : '0');
    expect((await db.pool.query("SELECT count(*) FROM provider_health WHERE provider='openai' AND blocked")).rows[0].count).toBe('0');
  });
  it('rejects configuration changed after context was sized, with no generation or reservation',async () => {
    const p = pipeline(true); await expect(p.service.handleDirect(request)).rejects.toThrow('configuration_changed');
    expect(p.counts()).toBe(1); expect(p.generations()).toBe(0);
    expect((await db.pool.query('SELECT count(*) FROM usage_reservations')).rows[0].count).toBe('0');
  });
});
