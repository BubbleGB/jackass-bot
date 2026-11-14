import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { AutomaticService } from '../../src/conversation/automatic.js';
import { ConversationQueue } from '../../src/conversation/queue.js';
import { ContextBuilder } from '../../src/conversation/context.js';
import { DirectService } from '../../src/conversation/direct.js';
import { DirectEligibility } from '../../src/conversation/eligibility.js';
import { PostgresConversationConfigRepository } from '../../src/conversation/config.js';
import { ProviderRouter } from '../../src/providers/router.js';
import { ProviderInputCounter } from '../../src/providers/context-counter.js';
import { PostgresProviderRepository } from '../../src/providers/store.js';
import { UsageService } from '../../src/usage/service.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { source,message } from '../helpers/conversation.js';
import type { BotRequest } from '../../src/domain/types.js';
import { AutomaticRepository,type Assessment } from '../../src/conversation/receipts.js';
import { PostgresWorkerGuard } from '../../src/conversation/worker.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { guild,channel,user,request,instant } from '../helpers/conversation.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_channel_test_${randomUUID().replaceAll('-','')}`;
const admin = new Pool({ connectionString: url.toString(),max: 1 });
let db: Database,rawRepository: AutomaticRepository;
const epoch = randomUUID();
const repository = {
  observe(r: BotRequest,f: typeof flags,revision: number,now: Date,token: string = epoch) { return rawRepository.observe(r,f,revision,now,token); },
  begin(g: string,c: string,now: Date,token: string = epoch) { return rawRepository.begin(g,c,now,token); },
  finish(a: Assessment,success: boolean,now: Date,token: string = epoch) { return rawRepository.finish(a,success,now,token); },
  recover(token: string = epoch) { return rawRepository.recover(token); },
};
const event = (n: number) => ({ ...request,id: String(BigInt(request.id)+BigInt(n)),source: 'automatic' as const });
const flags = { mentionsBot: false,repliesToBot: false };
async function state() { return (await db.pool.query('SELECT * FROM channel_state WHERE guild_id=$1 AND channel_id=$2',[guild,channel])).rows[0]; }
describe('durable message activity and assessment snapshots',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); rawRepository = new AutomaticRepository(db); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE guild_settings,approved_guilds CASCADE');
    await db.pool.query("INSERT INTO worker_ownership(name,token) VALUES('conversation',$1) ON CONFLICT(name) DO UPDATE SET token=EXCLUDED.token",[epoch]);
    await db.pool.query('INSERT INTO guild_settings(guild_id,enabled,direct_enabled,auto_threshold) VALUES($1,true,true,3)',[guild]);
    await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]);
    await db.pool.query('INSERT INTO auto_channels(guild_id,channel_id) VALUES($1,$2)',[guild,channel]);
  });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('atomically deduplicates simultaneous events and increments each distinct message once',async () => {
    const duplicates = await Promise.all(Array.from({ length: 8 },() => repository.observe(event(1),flags,1,instant)));
    expect(duplicates.filter(x => x.status === 'counted')).toHaveLength(1); expect((await state()).pending_count).toBe('1');
    await Promise.all([repository.observe(event(2),flags,1,instant),repository.observe(event(3),flags,1,instant)]);
    expect((await state()).pending_count).toBe('3');
    expect((await db.pool.query('SELECT count(*) FROM request_receipts')).rows[0].count).toBe('3');
  });
  it.each(['mentionsBot','repliesToBot'] as const)('counts a threshold-reaching %s but schedules only a later ordinary human message',async flag => {
    await repository.observe(event(1),flags,1,instant); await repository.observe(event(2),flags,1,instant);
    const direct = await repository.observe(event(3),{ ...flags,[flag]: true },1,instant);
    expect(direct).toMatchObject({ status: 'counted',direct: true }); expect(await repository.begin(guild,channel,instant)).toBeNull();
    expect((await repository.observe(event(4),flags,1,instant)).status).toBe('eligible');
    const snapshot = await repository.begin(guild,channel,instant); expect(snapshot?.snapshot).toBe(4n); expect(snapshot?.request.id).toBe(event(4).id);
  });
  it('does not turn elapsed time into readiness after threshold is reached during the gap',async () => {
    for (let n = 1; n <= 3; n++) await repository.observe(event(n),flags,1,instant);
    const a = (await repository.begin(guild,channel,instant))!; await repository.finish(a,true,instant);
    const within = new Date(instant.getTime()+59999),after = new Date(instant.getTime()+60000);
    for (let n = 4; n <= 6; n++) expect((await repository.observe(event(n),flags,1,within)).status).toBe('counted');
    expect(await repository.begin(guild,channel,after)).toBeNull();
    expect((await repository.observe(event(7),flags,1,after)).status).toBe('eligible'); expect((await repository.begin(guild,channel,after))?.snapshot).toBe(4n);
  });
  it('captures 30, preserves three in-flight arrivals, and consumes the snapshot once',async () => {
    await db.pool.query('UPDATE guild_settings SET auto_threshold=30 WHERE guild_id=$1',[guild]);
    for (let n = 1; n <= 30; n++) await repository.observe(event(n),flags,1,instant);
    const [a,b] = await Promise.all([repository.begin(guild,channel,instant),repository.begin(guild,channel,instant)]);
    const accepted = a ?? b; expect([a,b].filter(Boolean)).toHaveLength(1); expect(accepted?.snapshot).toBe(30n);
    for (let n = 31; n <= 33; n++) await repository.observe(event(n),flags,1,instant);
    await Promise.all([repository.finish(accepted!,true,instant),repository.finish(accepted!,true,instant)]);
    expect((await state()).pending_count).toBe('3'); expect((await state()).last_success_at).toEqual(instant);
  });
  it('retains counts after failure/context skip, clears readiness and rejects stale completion',async () => {
    for (let n = 1; n <= 3; n++) await repository.observe(event(n),flags,1,instant);
    const old = (await repository.begin(guild,channel,instant))!; await repository.finish(old,false,instant);
    expect((await state()).pending_count).toBe('3'); expect((await state()).last_success_at).toBeNull();
    expect(await repository.begin(guild,channel,instant)).toBeNull();
    await repository.observe(event(4),flags,1,instant); const next = (await repository.begin(guild,channel,instant))!;
    expect(await repository.finish(old,true,instant)).toBe(false); expect((await state()).assessment_id).toBe(next.id);
  });
  it('preserves metadata/counts on restart and marks unfinished generation uncertain without replay',async () => {
    for (let n = 1; n <= 3; n++) await repository.observe(event(n),flags,1,instant);
    const a = (await repository.begin(guild,channel,instant))!;
    await db.pool.query("INSERT INTO request_receipts(guild_id,event_id,state) VALUES($1,$2,'processing')",[guild,`generation:${a.request.id}`]);
    const restarted = new AutomaticRepository(db); await restarted.recover(epoch);
    expect(await state()).toMatchObject({ pending_count: '3',assessment_id: null,ready_event_id: null });
    expect((await db.pool.query('SELECT state FROM request_receipts WHERE event_id=$1',[`generation:${a.request.id}`])).rows[0].state).toBe('uncertain');
    expect(await restarted.begin(guild,channel,new Date(instant.getTime()+3600000),epoch)).toBeNull();
    expect((await restarted.observe(a.request,flags,1,instant,epoch)).status).toBe('ignored');
    expect((await restarted.observe(event(4),flags,1,instant,epoch)).status).toBe('eligible');
  });
  it('ignores revoked, disabled, unselected and stale settings without counting',async () => {
    expect((await repository.observe({ ...event(1),channelId: user },flags,1,instant)).status).toBe('ignored');
    expect((await repository.observe(event(1),flags,2,instant)).status).toBe('ignored');
    await db.pool.query('DELETE FROM approved_guilds WHERE guild_id=$1',[guild]); expect((await repository.observe(event(1),flags,1,instant)).status).toBe('ignored');
    expect(await state()).toBeUndefined();
  });
  async function pipeline(kind: 'answer' | 'silence' | 'failure' = 'answer',hold?: Promise<void>) {
    const cipher = new CredentialCipher(1,new Map([[1,Buffer.alloc(32,7)]])),e = cipher.seal(guild,'openai','fake-key');
    await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'openai',$2,$3,$4,'gpt-5.4-mini-2026-03-17',1,50000) ON CONFLICT DO NOTHING",[guild,e.ciphertext,e.nonce,e.keyVersion]);
    let calls = 0,time = instant,mode = 'human',started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
    const inputs: Record<string,unknown>[] = [],outcomes: unknown[] = [];
    const history = source(); history.fetchTrigger = async r => message(r.id,'hello',{ authorId: r.userId,channelId: r.channelId,guildId: r.guildId,mentionsBot: mode === 'mention' || r.source === 'mention',repliesToBot: mode === 'reply' || r.source === 'reply',authorBot: mode === 'bot',webhookId: mode === 'webhook' ? user : null });
    history.canRead = async () => mode !== 'unsupported';
    const configs = new PostgresConversationConfigRepository(db),providers = new PostgresProviderRepository(db);
    const adapter = new OpenAIAdapter(async r => {
      if (r.url.endsWith('/input_tokens')) return { status: 200,headers: {},body: { input_tokens: 120 } };
      calls++; inputs.push(r.body); started(); if (hold) await hold;
      if (kind === 'failure') throw new Error('private upstream text');
      const text = JSON.stringify({ kind,text: kind === 'silence' ? '' : 'Hello' });
      return { status: 200,headers: {},body: { status: 'completed',usage: { input_tokens: 20,output_tokens: 10,total_tokens: 30 },output: [{ type: 'message',content: [{ type: 'output_text',text }] }] } };
    });
    const adapters = new Map([['openai' as const,adapter]]),router = new ProviderRouter(providers,new UsageService(db),cipher,adapters,() => time),counter = new ProviderInputCounter(providers,cipher,adapters,() => time);
    const context = new ContextBuilder(history,counter.countInput),gate = new DirectEligibility(configs,history,() => time),direct = new DirectService(gate,configs,history,context,router),guard = new PostgresWorkerGuard(db),queue = new ConversationQueue(() => time);
    const service = new AutomaticService({ repository,config: configs,history,context,direct,provider: router,queue,worker: guard,now: () => time,onOutcome: (_r,outcome) => { outcomes.push(outcome); } });
    expect(await service.start()).toBe(true);
    return { service,queue,guard,calls: () => calls,inputs,outcomes,begun,setMode(value: string) { mode = value; },advance(n: number) { time = new Date(time.getTime()+n); } };
  }
  it.each(['always','conditional'] as const)('executes %s policy through Task4 context and Task3 accounting and counts deliberate silence as success',async policy => {
    await db.pool.query('UPDATE guild_settings SET auto_policy=$2 WHERE guild_id=$1',[guild,policy]);
    const p = await pipeline('silence');
    try {
      for (let n = 1; n <= 3; n++) await p.service.observeMessage(event(n)); await p.queue.idle();
      expect(p.calls()).toBe(1); expect((await state()).pending_count).toBe('0'); expect((await state()).last_success_at).toEqual(instant);
      expect(p.inputs[0]!.instructions).toContain(policy === 'always' ? 'auto_always' : 'auto_conditional');
      expect((await db.pool.query('SELECT total_tokens FROM daily_usage WHERE guild_id=$1',[guild])).rows[0].total_tokens).toBe('30');
    } finally { await p.service.stop(); }
  });
  it('preserves three arrivals while a 30-message assessment runs and ignores duplicate gateway delivery',async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    await db.pool.query('UPDATE guild_settings SET auto_threshold=30 WHERE guild_id=$1',[guild]);
    const p = await pipeline('answer',hold);
    try {
      for (let n = 1; n <= 30; n++) await p.service.observeMessage(event(n)); await p.begun;
      await Promise.all([31,32,33,33].map(n => p.service.observeMessage(event(n))));
      release(); await p.queue.idle(); expect((await state()).pending_count).toBe('3'); expect(p.calls()).toBe(1);
    } finally { release(); await p.service.stop(); }
  });
  it.each(['mention','reply'] as const)('handles a threshold-reaching direct %s only and leaves automatic work for a later ordinary human',async directSource => {
    const p = await pipeline();
    try {
      await p.service.observeMessage(event(1)); await p.service.observeMessage(event(2));
      p.setMode(directSource); await p.service.observeMessage({ ...event(3),source: directSource }); await p.queue.idle(); p.setMode('human');
      expect(p.calls()).toBe(1); expect((await state()).pending_count).toBe('3'); expect((await state()).last_success_at).toBeNull();
      await p.service.observeMessage(event(4)); await p.queue.idle(); expect(p.calls()).toBe(2); expect((await state()).pending_count).toBe('0');
    } finally { await p.service.stop(); }
  });
  it.each(['failure','context'] as const)('preserves pending activity on %s and never retries from elapsed time alone',async outcome => {
    const p = await pipeline(outcome === 'failure' ? 'failure' : 'answer');
    try {
      if (outcome === 'context') await db.pool.query('UPDATE guild_settings SET human_context_limit=0,revision=revision+1 WHERE guild_id=$1',[guild]);
      for (let n = 1; n <= 3; n++) await p.service.observeMessage(event(n)); await p.queue.idle();
      expect((await state()).pending_count).toBe('3'); expect((await state()).last_success_at).toBeNull();
      const before = p.calls(); p.advance(3600000); await p.queue.idle(); expect(p.calls()).toBe(before);
      if (outcome === 'context') expect(p.calls()).toBe(0);
      else expect((await db.pool.query('SELECT uncertain_tokens FROM daily_usage WHERE guild_id=$1',[guild])).rows[0].uncertain_tokens).toBe('2168');
    } finally { await p.service.stop(); }
  });
  it('ignores other bots/webhooks and unsupported channels before observing activity',async () => {
    const p = await pipeline();
    try { for (const mode of ['bot','webhook','unsupported']) { p.setMode(mode); expect(await p.service.observeMessage(event(1))).toBe('ignored'); } expect(await state()).toBeUndefined(); expect(p.calls()).toBe(0); }
    finally { await p.service.stop(); }
  });
  it('restarts after an interrupted real provider pipeline without replaying its uncertain call or freeing its charge',async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const old = await pipeline('answer',hold);
    let replacement: Awaited<ReturnType<typeof pipeline>> | undefined;
    try {
      for (let n = 1; n <= 3; n++) await old.service.observeMessage(event(n)); await old.begun;
      await old.guard.stop(); await old.queue.idle(); await old.service.stop();
      expect((await state()).pending_count).toBe('3');
      expect((await db.pool.query('SELECT uncertain_tokens,reserved_tokens FROM daily_usage WHERE guild_id=$1',[guild])).rows[0]).toMatchObject({ uncertain_tokens: '2168',reserved_tokens: '0' });
      replacement = await pipeline(); await replacement.queue.idle();
      expect(replacement.calls()).toBe(0); expect((await state()).assessment_id).toBeNull();
      expect(await replacement.service.observeMessage(event(3))).toBe('ignored'); replacement.advance(1000); await replacement.queue.idle(); expect(replacement.calls()).toBe(0);
      await replacement.service.observeMessage(event(4)); await replacement.queue.idle(); expect(replacement.calls()).toBe(1);
      expect((await db.pool.query('SELECT uncertain_tokens,total_tokens FROM daily_usage WHERE guild_id=$1',[guild])).rows[0]).toMatchObject({ uncertain_tokens: '2168',total_tokens: '30' });
      expect((await db.pool.query('SELECT state FROM request_receipts WHERE event_id=$1',[`generation:${event(3).id}`])).rows[0].state).toBe('uncertain');
    } finally { release(); await old.service.stop(); await replacement?.service.stop(); }
  });
  it('fences obsolete worker generations inside begin, finish and recovery transactions',async () => {
    for (let n = 1; n <= 3; n++) await repository.observe(event(n),flags,1,instant);
    const stale = randomUUID();
    await expect(repository.begin(guild,channel,instant,stale)).rejects.toThrow('worker_unavailable');
    const active = (await repository.begin(guild,channel,instant))!;
    await expect(repository.finish(active,true,instant,stale)).rejects.toThrow('worker_unavailable');
    await expect(repository.recover(stale)).rejects.toThrow('worker_unavailable');
    expect((await state()).assessment_id).toBe(active.id); expect((await state()).pending_count).toBe('3');
  });
  it('rejects delayed old transactions after takeover without stealing new readiness',async () => {
    for (let n = 1; n <= 3; n++) await repository.observe(event(n),flags,1,instant);
    const locker = await db.pool.connect(),nextEpoch = randomUUID();
    try {
      await locker.query('BEGIN'); await locker.query("SELECT token FROM worker_ownership WHERE name='conversation' FOR UPDATE");
      const oldBegin = rawRepository.begin(guild,channel,instant,epoch).catch(e => e.message);
      const oldRecovery = rawRepository.recover(epoch).then(() => 'unexpected',e => e.message);
      await locker.query("UPDATE worker_ownership SET token=$1 WHERE name='conversation'",[nextEpoch]); await locker.query('COMMIT');
      expect(await oldBegin).toBe('worker_unavailable'); expect(await oldRecovery).toBe('worker_unavailable');
      expect((await rawRepository.begin(guild,channel,instant,nextEpoch))?.snapshot).toBe(3n);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
  });
  it('allows only one live worker, fences a stopped worker, and allows a replacement',async () => {
    const first = new PostgresWorkerGuard(db),second = new PostgresWorkerGuard(db);
    try {
      expect(await first.start()).toBe(true); expect(await second.start()).toBe(false); await Promise.all([first.assertActive(),first.assertActive(),first.assertActive()]);
      await first.stop(); await expect(first.assertActive()).rejects.toThrow('worker_unavailable'); expect(first.signal.aborted).toBe(true);
      expect(await second.start()).toBe(true); await second.assertActive();
    } finally { await first.stop(); await second.stop(); }
  });
});
