import { Client,Events,GatewayIntentBits,Options,type ClientOptions } from 'discord.js';
import type { DiscordHandlers } from './events.js';
import { DiscordFailure } from './transport.js';
type Gateway = Pick<Client,'on' | 'login' | 'destroy'>;
/** Gateway normalization only. No SDK send/reply helpers or reconnect registration. */
export function createDiscordClient(handlers: Pick<DiscordHandlers,'handleMessage' | 'handleInteraction'>,factory: (options: ClientOptions) => Gateway = options => new Client(options)) {
  const client = factory({ intents: [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],makeCache: Options.cacheWithLimits({ MessageManager: 0 }),allowedMentions: { parse: [],roles: [],users: [],repliedUser: false },rest: { retries: 0,timeout: 10000,rejectOnRateLimit: () => true } });
  client.on(Events.MessageCreate,message => {
    void handlers.handleMessage({ id: message.id,guildId: message.guildId,channelId: message.channelId,channelType: message.channel.type,userId: message.author.id,bot: message.author.bot,webhookId: message.webhookId }).catch(() => undefined);
  });
  client.on(Events.InteractionCreate,interaction => {
    if (!interaction.isChatInputCommand()) return;
    void handlers.handleInteraction({ id: interaction.id,applicationId: interaction.applicationId,token: interaction.token,...(interaction.guildId ? { guildId: interaction.guildId } : {}),channelId: interaction.channelId,userId: interaction.user.id,channelType: interaction.channel?.type ?? -1,command: interaction.commandName,...(interaction.commandName === 'ask' ? { prompt: interaction.options.getString('prompt') ?? '' } : {}) }).catch(() => undefined);
  });
  client.on(Events.Error,() => undefined); // Raw SDK errors may carry request information.
  return { async start(token: string) { try { await client.login(token); } catch { throw new DiscordFailure('uncertain'); } },async stop() { await client.destroy(); } };
}
