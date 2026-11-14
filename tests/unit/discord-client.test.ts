import { describe,it,expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayIntentBits,type ClientOptions } from 'discord.js';
import { createDiscordClient } from '../../src/discord/client.js';
import { registerCommands,readRegistrationConfig } from '../../src/discord/register.js';
import type { DiscordCall } from '../../src/discord/transport.js';
import { guild,channel,user,request } from '../helpers/conversation.js';
describe('Discord gateway binding and explicit registration',() => {
  it('binds authenticated message/command identity with minimal intents and never registers on ready/reconnect',async () => {
    const emitter = new EventEmitter(),messages: unknown[] = [],commands: unknown[] = []; let options!: ClientOptions,logins = 0;
    const gateway = createDiscordClient({ async handleMessage(m) { messages.push(m); },async handleInteraction(i) { commands.push(i); } },o => { options = o; return { on: emitter.on.bind(emitter) as never,removeListener: emitter.removeListener.bind(emitter) as never,user: null,isReady: () => true,async login() { logins++; emitter.emit('clientReady'); return 'fake'; },async destroy() {} }; });
    expect(options.intents).toEqual([GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]); expect(logins).toBe(0);
    await gateway.start('fake-token'); emitter.emit('clientReady'); emitter.emit('shardResume',0); expect(logins).toBe(1);
    emitter.emit('messageCreate',{ id: request.id,guildId: guild,channelId: channel,channel: { type: 0 },author: { id: user,bot: false },webhookId: null });
    emitter.emit('interactionCreate',{ isChatInputCommand: () => true,id: request.id,applicationId: guild,token: 'fake-interaction',guildId: guild,channelId: channel,user: { id: user },channel: { type: 0 },commandName: 'ask',options: { getString: () => 'Hi' } });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(messages).toHaveLength(1); expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ userId: user,prompt: 'Hi' }); await gateway.stop();
  });
  it('registers a test guild separately from explicit production/global registration with safe guild-only command definitions',async () => {
    const calls: DiscordCall[] = []; const rest = { async call(r: DiscordCall) { calls.push(r); return []; } };
    await registerCommands({ applicationId: user,scope: { kind: 'guild',guildId: guild } },rest);
    await registerCommands({ applicationId: user,scope: { kind: 'global',production: true } },rest);
    expect(calls.map(c => c.path)).toEqual([`/applications/${user}/guilds/${guild}/commands`,`/applications/${user}/commands`]);
    expect((calls[0]!.body as { name: string }[]).map(c => c.name)).toEqual(['help','ask','settings','status']);
    expect((calls[1]!.body as { contexts: number[]; integration_types: number[] }[]).every(c => c.contexts.length === 1 && c.contexts[0] === 0 && c.integration_types[0] === 0)).toBe(true);
  });
  it('requires explicit registration scope and identifiers without exposing supplied tokens in errors',() => {
    const env = { DISCORD_BOT_TOKEN: 'fake-secret',DISCORD_CLIENT_ID: user,DISCORD_TEST_GUILD_ID: guild };
    expect(readRegistrationConfig(env,['--guild']).scope).toEqual({ kind: 'guild',guildId: guild });
    expect(() => readRegistrationConfig(env,['--global'])).toThrow('registration_configuration');
    try { readRegistrationConfig({ ...env,DISCORD_CLIENT_ID: 'fake-secret' },['--global','--production']); } catch (e) { expect(String(e)).not.toContain('fake-secret'); }
  });
});
