export interface MembershipSnapshot {
  guildId: string; userId: string; ownerId: string; botPresent: boolean;
  roleIds: readonly string[]; roles: readonly { id: string; permissions: string }[];
}
export interface MembershipRepository {
  lookup(userId: string, guildId: string): Promise<MembershipSnapshot | null>;
  isTextChannel(guildId: string, channelId: string, signal?: AbortSignal): Promise<boolean>;
}
/** Inject a bot-authenticated Discord REST GET transport. Never use OAuth guild lists
 * as proof of current membership. No intents or network client are started here.
 */
export type DiscordGet = (path: string, signal: AbortSignal) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('discord_lookup_failed');
  return value as Record<string, unknown>;
};
const snowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{17,20}$/.test(value);
export class DiscordMembership implements MembershipRepository {
  constructor(private readonly get: DiscordGet, private readonly botId: string) {}
  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort',() => reject(new Error('discord_lookup_failed')),{ once: true });
        signal?.addEventListener('abort',abort,{ once: true });
        if (signal?.aborted) controller.abort();
        timer = setTimeout(abort,5000);
      });
      if (controller.signal.aborted) return await timeout;
      return await Promise.race([this.get(path,controller.signal), timeout]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  async lookup(userId: string, guildId: string): Promise<MembershipSnapshot | null> {
    if (![userId, guildId, this.botId].every(snowflake)) return null;
    try {
      const [g, m, b, r] = await Promise.all([
        this.request(`/guilds/${guildId}`), this.request(`/guilds/${guildId}/members/${userId}`),
        this.request(`/guilds/${guildId}/members/${this.botId}`), this.request(`/guilds/${guildId}/roles`),
      ]);
      const guild = record(g), member = record(m), bot = record(b);
      if (guild.id !== guildId || !snowflake(guild.owner_id) || record(member.user).id !== userId || record(bot.user).id !== this.botId || !Array.isArray(member.roles) || !member.roles.every(snowflake) || !Array.isArray(r)) return null;
      const roles = r.map((value) => {
        const role = record(value);
        if (!snowflake(role.id) || typeof role.permissions !== 'string' || !/^\d+$/.test(role.permissions)) throw new Error('discord_lookup_failed');
        return { id: role.id, permissions: role.permissions };
      });
      return { guildId, userId, ownerId: guild.owner_id, botPresent: true, roleIds: member.roles as string[], roles };
    } catch { return null; }
  }
  async isTextChannel(guildId: string, channelId: string, signal?: AbortSignal): Promise<boolean> {
    if (![guildId, channelId].every(snowflake)) return false;
    try { const channel = record(await this.request(`/channels/${channelId}`,signal)); return channel.id === channelId && channel.guild_id === guildId && channel.type === 0; }
    catch { return false; }
  }
}
