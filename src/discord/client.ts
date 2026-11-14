import { Client,Events,GatewayIntentBits,Options,type ClientOptions } from 'discord.js';
import type { DiscordHandlers } from './events.js';
import { DiscordFailure,discordBounded } from './transport.js';
export type RawGateway = Pick<Client,'on' | 'removeListener' | 'login' | 'destroy'> & { isReady(): boolean; readonly user: { id: string } | null };
/** Gateway normalization only. No SDK send/reply helpers or reconnect registration. */
export function createDiscordClient(handlers: Pick<DiscordHandlers,'handleMessage' | 'handleInteraction'>,factory: (options: ClientOptions) => RawGateway = options => new Client(options),lifecycle: { guildsChanged?: () => void } = {}) {
  const client = factory({ intents: [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],makeCache: Options.cacheWithLimits({ MessageManager: 0 }),allowedMentions: { parse: [],roles: [],users: [],repliedUser: false },rest: { retries: 0,timeout: 10000,rejectOnRateLimit: () => true } });
  client.on(Events.MessageCreate,message => {
    void handlers.handleMessage({ id: message.id,guildId: message.guildId,channelId: message.channelId,channelType: message.channel.type,userId: message.author.id,bot: message.author.bot,webhookId: message.webhookId }).catch(() => undefined);
  });
  client.on(Events.InteractionCreate,interaction => {
    if (!interaction.isChatInputCommand()) return;
    void handlers.handleInteraction({ id: interaction.id,applicationId: interaction.applicationId,token: interaction.token,...(interaction.guildId ? { guildId: interaction.guildId } : {}),channelId: interaction.channelId,userId: interaction.user.id,channelType: interaction.channel?.type ?? -1,command: interaction.commandName,...(interaction.commandName === 'ask' ? { prompt: interaction.options.getString('prompt') ?? '' } : {}) }).catch(() => undefined);
  });
  client.on(Events.GuildCreate,g => { if (g.available !== false) lifecycle.guildsChanged?.(); });
  client.on(Events.GuildDelete,g => { if (g.available !== false) lifecycle.guildsChanged?.(); });
  client.on(Events.ShardResume,() => lifecycle.guildsChanged?.());
  client.on(Events.Error,() => undefined); // Raw SDK errors may carry request information.
  return { ready: () => client.isReady(),identity: () => client.user?.id ?? null,async start(token: string,parent?: AbortSignal) {
    const signal = parent ? AbortSignal.any([parent,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000); let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; }); const check = () => { if (client.isReady()) ready(); }; client.on(Events.ClientReady,check);
    try { await discordBounded(async () => { await client.login(token); check(); await waiting; },signal); } catch { throw new DiscordFailure('uncertain'); } finally { client.removeListener(Events.ClientReady,check); }
  },async stop() { await client.destroy(); } };
}
