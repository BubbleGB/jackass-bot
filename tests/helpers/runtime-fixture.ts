import { EventEmitter } from 'node:events';
import type { Database } from '../../src/db/index.js';
import { loadConfig } from '../../src/config.js';
import { startApplication } from '../../src/runtime/application.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import type { RawGateway } from '../../src/discord/client.js';
import type { DiscordCall } from '../../src/discord/transport.js';
import { guild,channel,user,bot,request } from './conversation.js';
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise,resolve }; }
export async function runtimeFixture(db: Database,url: string) {
  const key = Buffer.alloc(32,7),e = new CredentialCipher(1,new Map([[1,key]])).seal(guild,'openai','fake-provider-secret');
  await db.pool.query('INSERT INTO guild_settings(guild_id,enabled,direct_enabled) VALUES($1,true,true)',[guild]);
  await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$2)',[guild,user]);
  await db.pool.query('INSERT INTO auto_channels(guild_id,channel_id) VALUES($1,$2)',[guild,channel]);
  await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'openai',$2,$3,1,'gpt-5.4-mini-2026-03-17',1,50000)",[guild,e.ciphertext,e.nonce]);
  const config = loadConfig({ NODE_ENV: 'test',APP_MODE: 'runtime',DATABASE_URL: url,ENCRYPTION_KEY: key.toString('base64'),DISCORD_BOT_TOKEN: 'fake-discord-secret',DISCORD_CLIENT_ID: bot,DISCORD_CLIENT_SECRET: 'fake-oauth-secret',CREATOR_USER_ID: user,PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const clients: { emitter: EventEmitter; ready: boolean; active: boolean }[] = [],servers: import('fastify').FastifyInstance[] = [],logs: string[] = [],calls: DiscordCall[] = [];
  let destroyFailure = false;
  let logins = 0,generations = 0,losePermission = false,permission = true,outage = false;
  let loginGate: ReturnType<typeof deferred> | null = null,generationGate: ReturnType<typeof deferred> | null = null;
  const loginStarted = deferred(),generationStarted = deferred();
  const transport = { async call(r: DiscordCall): Promise<unknown> {
    calls.push(r);
    if (r.path === '/users/@me') return { id: bot,bot: true };
    if (r.path.startsWith('/users/@me/guilds')) { if (outage) throw new Error('private-discord-outage'); return [{ id: guild }]; }
    if (r.method !== 'GET') return { id: '999999999999999999' };
    if (r.path === `/channels/${channel}`) return { id: channel,guild_id: guild,type: 0,permission_overwrites: permission ? [] : [{ id: bot,type: 1,allow: '0',deny: '1024' }] };
    if (r.path === `/guilds/${guild}`) return { id: guild,owner_id: user,name: 'Runtime test' };
    if (r.path === `/guilds/${guild}/roles`) return [{ id: guild,permissions: '68608' }];
    if (r.path === `/guilds/${guild}/members/${user}` || r.path === `/guilds/${guild}/members/${bot}`) return { user: { id: r.path.endsWith(bot) ? bot : user,bot: r.path.endsWith(bot) },roles: [] };
    if (r.path.includes('/messages?')) return [];
    return { id: r.path.split('/').at(-1),channel_id: channel,guild_id: guild,author: { id: user,bot: false },content: 'Hi Neegy private conversation',timestamp: new Date(Date.now()-1000).toISOString(),type: 0,mentions: [{ id: bot }] };
  } };
  const provider = new OpenAIAdapter(async r => {
    if (r.url.endsWith('/input_tokens')) return { status: 200,headers: {},body: { input_tokens: 120 } };
    generations++; generationStarted.resolve(); if (generationGate) await generationGate.promise; if (losePermission) permission = false;
    return { status: 200,headers: {},body: { status: 'completed',usage: { input_tokens: 20,output_tokens: 10,total_tokens: 30 },output: [{ type: 'message',content: [{ type: 'output_text',text: JSON.stringify({ kind: 'answer',text: 'Private generated answer' }) }] }] } };
  });
  return { config,servers,logs,calls,loginStarted,generationStarted,logins: () => logins,generations: () => generations,
    failDestroy() { destroyFailure = true; },holdLogin() { loginGate = deferred(); return loginGate.resolve; },holdGeneration() { generationGate = deferred(); return generationGate.resolve; },losePermission() { losePermission = true; },outage() { outage = true; },
    message(id = request.id,guildId = guild) { clients.find(c => c.active)?.emitter.emit('messageCreate',{ id,guildId,channelId: channel,channel: { type: 0 },author: { id: user,bot: false },webhookId: null }); },
    disconnect() { for (const c of clients) c.ready = false; },
    start(signal?: AbortSignal,graceMs?: number) { return startApplication(config,{ port: 0,host: '127.0.0.1',...(graceMs !== undefined ? { graceMs } : {}),transport,providers: new Map([['openai',provider]]),sink: line => { logs.push(line); },onServer: s => { servers.push(s); },...(signal ? { signal } : {}),gatewayFactory: () => {
      const c = { emitter: new EventEmitter(),ready: false,active: false }; clients.push(c);
      return { on: c.emitter.on.bind(c.emitter),removeListener: c.emitter.removeListener.bind(c.emitter),user: { id: bot },isReady: () => c.ready,async login() { logins++; loginStarted.resolve(); if (loginGate) await loginGate.promise; c.ready = true; c.active = true; c.emitter.emit('clientReady'); return 'fake'; },async destroy() { c.active = false; c.ready = false; c.emitter.removeAllListeners(); if (destroyFailure) { destroyFailure = false; throw new Error('private-sdk-token'); } } } as unknown as RawGateway;
    } }); },
  };
}
