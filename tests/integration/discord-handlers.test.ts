import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { createDiscordApplication } from '../../src/discord/application.js';
import { DiscordFailure,type DiscordCall } from '../../src/discord/transport.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { guild,channel,user,bot,request,instant } from '../helpers/conversation.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_discord_test_${randomUUID().replaceAll('-','')}`;
const admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database;
const key = Buffer.alloc(32,7),cipher = new CredentialCipher(1,new Map([[1,key]]));
const id = (n: number) => String(BigInt(request.id)+BigInt(n));
describe('Discord handlers through existing context, queue, access and ledger services',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE daily_usage,usage_reservations,request_receipts,guild_settings,approved_guilds CASCADE');
    await db.pool.query('INSERT INTO guild_settings(guild_id,enabled,direct_enabled,auto_threshold) VALUES($1,true,true,3)',[guild]);
    await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]);
    await db.pool.query('INSERT INTO auto_channels(guild_id,channel_id) VALUES($1,$2)',[guild,channel]);
    const e = cipher.seal(guild,'openai','fake-provider-key');
    await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'openai',$2,$3,$4,'gpt-5.4-mini-2026-03-17',1,50000)",[guild,e.ciphertext,e.nonce,e.keyVersion]);
  });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  async function fixture() {
    let time = instant.getTime(),generations = 0,permission = true,member = true;
    let inputCount = 120;
    let text = 'Hello',failProvider = false,sends = 0,loseOnAnswer = false,loseWorker = false;
    const reports: import('../../src/discord/delivery.js').DeliveryReport[] = [];
    const calls: DiscordCall[] = [],failSends = new Map<number,Error>(),messages = new Map<string,'mention' | 'reply' | 'ordinary'>();
    const transport = { async call(r: DiscordCall): Promise<unknown> {
      calls.push(r);
      if (r.method === 'GET') {
        if (loseWorker && generations > 0 && r.path === `/channels/${channel}`) {
          loseWorker = false;
          await db.pool.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (r.path === `/channels/${channel}`) return { id: channel,guild_id: guild,type: 0,permission_overwrites: permission ? [] : [{ id: bot,type: 1,allow: '0',deny: '1024' }] };
        if (r.path === `/guilds/${guild}`) return { id: guild,owner_id: user };
        if (r.path === `/guilds/${guild}/roles`) return [{ id: guild,permissions: '68608' }];
        if (r.path === `/guilds/${guild}/members/${user}`) { if (!member) throw new Error('member left'); return { user: { id: user,bot: false },roles: [] }; }
        if (r.path === `/guilds/${guild}/members/${bot}`) return { user: { id: bot,bot: true },roles: [] };
        if (r.path.includes('/messages?')) return [];
        const messageId = r.path.split('/').at(-1)!,kind = messages.get(messageId) ?? 'ordinary';
        return { id: messageId,channel_id: channel,guild_id: guild,author: { id: user,bot: false },content: 'Hi',timestamp: instant.toISOString(),type: kind === 'reply' ? 19 : 0,mentions: kind === 'mention' ? [{ id: bot }] : [],...(kind === 'reply' ? { message_reference: { channel_id: channel,guild_id: guild,message_id: id(0) },referenced_message: { author: { id: bot,bot: true } } } : {}) };
      }
      if (r.method === 'POST' && r.path.endsWith('/messages')) { sends++; const failure = failSends.get(sends); if (failure) throw failure; }
      return { id: id(100+sends) };
    } };
    const provider = new OpenAIAdapter(async r => {
      if (r.url.endsWith('/input_tokens')) return { status: 200,headers: {},body: { input_tokens: inputCount } };
      generations++; if (loseOnAnswer) permission = false;
      if (failProvider) return { status: 429,headers: {},body: { error: { code: 'insufficient_quota' } } };
      return { status: 200,headers: {},body: { status: 'completed',usage: { input_tokens: 20,output_tokens: 10,total_tokens: 30 },output: [{ type: 'message',content: [{ type: 'output_text',text: JSON.stringify({ kind: 'answer',text }) }] }] } };
    });
    const app = createDiscordApplication({ database: db,onDelivery: (_r,report) => { reports.push(report); },botId: bot,creatorId: user,publicOrigin: 'https://example.test',encryptionKey: key,keyVersion: 1,transport,providers: new Map([['openai',provider]]),now: () => new Date(time),delay: async () => undefined });
    expect(await app.start()).toBe(true);
    return { app,calls,reports,failSends,generations: () => generations,sends: () => sends,setText(t: string) { text = t; },oversizeInput() { inputCount = 500000; },failProvider() { failProvider = true; },losePermissions() { loseOnAnswer = true; },loseWorkerDuringDelivery() { loseWorker = true; },revokeMember() { member = false; },advance(n: number) { time += n; },
      async message(n: number,kind: 'mention' | 'reply' | 'ordinary') { messages.set(id(n),kind); await app.handlers.handleMessage({ id: id(n),guildId: guild,channelId: channel,channelType: 0,userId: user,bot: false,webhookId: null }); },
      interaction(n: number,command = 'ask') { return { id: id(n),applicationId: '999999999999999999',token: `fake-token-${n}`,guildId: guild,channelId: channel,userId: user,channelType: 0,command,prompt: 'Hi' }; },
    };
  }
  it.each(['mention','reply'] as const)('delivers one %s answer at automatic threshold, counts once and leaves activity ready',async kind => {
    const f = await fixture();
    try {
      await f.message(1,'ordinary'); await f.message(2,'ordinary'); await f.message(3,kind); await f.app.queue.idle(); await f.message(3,kind); await f.app.queue.idle();
      expect(f.generations()).toBe(1); expect(f.sends()).toBe(1);
      expect((await db.pool.query('SELECT pending_count,last_success_at FROM channel_state')).rows[0]).toMatchObject({ pending_count: '3',last_success_at: null });
      expect(f.calls.some(c => c.path.endsWith('/typing'))).toBe(true);
      const sent = f.calls.find(c => c.method === 'POST' && c.path.endsWith('/messages'))?.body;
      expect(sent).toMatchObject({ allowed_mentions: { users: [user],roles: [],parse: [],replied_user: false } });
    } finally { await f.app.stop(); }
  });
  it('acks /ask publicly, checks staff commands privately, and uses current membership',async () => {
    const f = await fixture();
    try {
      await f.app.handlers.handleInteraction(f.interaction(1)); expect(f.generations()).toBe(1);
      expect(f.calls.find(c => c.path.endsWith('/callback'))?.body).toEqual({ type: 5,data: { flags: 0 } });
      await f.app.handlers.handleInteraction(f.interaction(2,'status')); expect(JSON.stringify(f.calls)).toContain('UTC reset');
      f.revokeMember(); await f.app.handlers.handleInteraction(f.interaction(3,'settings'));
      expect(f.calls.at(-1)?.body).toMatchObject({ content: expect.stringContaining('access') });
      expect(f.calls.filter(c => c.path.endsWith('/callback')).slice(1).every(c => (c.body as { data: { flags: number } }).data.flags === 64)).toBe(true);
    } finally { await f.app.stop(); }
  });
  it.each(['ask','mention'] as const)('preserves the typed oversized-input result through the real %s queue handler',async kind => {
    const f = await fixture();
    try {
      f.oversizeInput();
      if (kind === 'ask') await f.app.handlers.handleInteraction(f.interaction(1));
      else { await f.message(1,'mention'); await f.app.queue.idle(); }
      expect(f.generations()).toBe(0);
      const responses = f.calls.filter(c => c.method !== 'GET' && (c.method === 'PATCH' || c.path.endsWith('/messages') || c.path.includes('?wait=true')));
      expect(JSON.stringify(responses)).toContain('server instructions and current request do not fit');
      expect(JSON.stringify(responses)).not.toContain('AI is currently unavailable');
    } finally { await f.app.stop(); }
  });
  it('rechecks channel permission before delivery and cleans typing even when delivery is blocked',async () => {
    const f = await fixture();
    try { f.losePermissions(); await f.message(1,'mention'); await f.app.queue.idle(); expect(f.generations()).toBe(1); expect(f.sends()).toBe(0); }
    finally { await f.app.stop(); }
  });
  it('fails closed when singleton ownership is lost during the final permission read',async () => {
    const f = await fixture();
    try { f.loseWorkerDuringDelivery(); await f.message(1,'mention'); await f.app.queue.idle(); expect(f.generations()).toBe(1); expect(f.sends()).toBe(0); expect(f.reports[0]?.state).toBe('blocked'); }
    finally { await f.app.stop(); }
  });
  it('retains earlier chunks and retries delivery without calling the provider again',async () => {
    const f = await fixture();
    try {
      f.setText('x'.repeat(2500)); f.failSends.set(2,new DiscordFailure('rate_limited',0)); await f.message(1,'mention'); await f.app.queue.idle();
      expect(f.generations()).toBe(1); expect(f.sends()).toBe(3);
      const sent = f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/messages'));
      expect(sent[0]?.body).not.toEqual(sent[1]?.body); expect(sent[1]?.body).toEqual(sent[2]?.body);
    } finally { await f.app.stop(); }
  });
  it('keeps later-chunk acceptance uncertainty without retries, regeneration or loss of prior delivery',async () => {
    const f = await fixture();
    try { f.setText('x'.repeat(2500)); f.failSends.set(2,new Error('lost send acknowledgement')); await f.message(1,'reply'); await f.app.queue.idle(); expect(f.generations()).toBe(1); expect(f.sends()).toBe(2); expect(f.reports[0]).toMatchObject({ state: 'uncertain',nextChunk: 1 }); expect(f.reports[0]?.deliveredMessageIds).toHaveLength(1); }
    finally { await f.app.stop(); }
  });
  it('blocks model mass/role/fabricated mentions on every outgoing chunk through the handler',async () => {
    const f = await fixture();
    try {
      f.setText(`@everyone @here <@&${user}> <@888888888888888888> <@${user}> `+'x'.repeat(3000));
      await f.message(1,'mention'); await f.app.queue.idle();
      const sent = f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/messages')); expect(sent).toHaveLength(2);
      for (const call of sent) {
        const body = call.body as { content: string; allowed_mentions: unknown };
        expect(body.allowed_mentions).toEqual({ parse: [],roles: [],users: [user],replied_user: false }); expect(body.content).not.toMatch(/@everyone|@here|<@&|<@888888888888888888>/);
      }
    } finally { await f.app.stop(); }
  });
  it('privately acknowledges cooldown and suppressed unavailability while still resolving each slash request',async () => {
    const f = await fixture();
    try {
      f.failProvider(); await f.app.handlers.handleInteraction(f.interaction(1));
      await f.app.handlers.handleInteraction(f.interaction(2)); expect(f.calls.at(-1)?.body).toMatchObject({ flags: 64,content: expect.stringContaining('cooldown') });
      f.advance(5000); await f.app.handlers.handleInteraction(f.interaction(3)); expect(f.calls.at(-1)?.body).toMatchObject({ flags: 64 });
      expect(f.calls.filter(c => c.path.endsWith('/callback'))).toHaveLength(3);
    } finally { await f.app.stop(); }
  });
});
