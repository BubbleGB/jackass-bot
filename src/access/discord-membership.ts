import { DiscordFailure } from '../discord/transport.js';
export type VerificationReason = 'timeout' | 'rate_limited' | 'unavailable' | 'invalid_response';
export class MembershipVerificationError extends Error {
  constructor(readonly reason: VerificationReason) { super('verification_unavailable'); this.name = 'MembershipVerificationError'; }
}
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
  private readonly inFlight = new Map<string,Promise<MembershipSnapshot | null>>();
  constructor(private readonly get: DiscordGet, private readonly botId: string) {}
  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort',() => reject(new MembershipVerificationError('timeout')),{ once: true });
        signal?.addEventListener('abort',abort,{ once: true });
        if (signal?.aborted) controller.abort();
        timer = setTimeout(abort,5000);
      });
      if (controller.signal.aborted) return await timeout;
      return await Promise.race([this.get(path,controller.signal), timeout]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  lookup(userId: string,guildId: string): Promise<MembershipSnapshot | null> {
    if (![userId,guildId,this.botId].every(snowflake)) return Promise.resolve(null);
    const key = `${guildId}:${userId}`,pending = this.inFlight.get(key); if (pending) return pending;
    const work = this.freshLookup(userId,guildId).finally(() => { this.inFlight.delete(key); }); this.inFlight.set(key,work); return work;
  }
  private async freshLookup(userId: string, guildId: string): Promise<MembershipSnapshot | null> {
    if (![userId, guildId, this.botId].every(snowflake)) return null;
    let values: unknown[]; const controller = new AbortController();
    try {
      values = await Promise.all([
        this.request(`/guilds/${guildId}`,controller.signal), this.request(`/guilds/${guildId}/members/${userId}`,controller.signal),
        this.request(`/guilds/${guildId}/members/${this.botId}`,controller.signal), this.request(`/guilds/${guildId}/roles`,controller.signal),
      ]);
    } catch (e) {
      if (e instanceof DiscordFailure && e.kind === 'forbidden') return null;
      if (e instanceof MembershipVerificationError) throw e;
      throw new MembershipVerificationError(e instanceof DiscordFailure && e.kind === 'rate_limited' ? 'rate_limited' : 'unavailable');
    } finally { controller.abort(); }
    try {
      const [g,m,b,r] = values;
      const guild = record(g), member = record(m), bot = record(b);
      const actorUser = record(member.user),botUser = record(bot.user);
      if (![guild.id,actorUser.id,botUser.id].every(snowflake)) throw new Error('discord_lookup_failed');
      if (guild.id !== guildId || actorUser.id !== userId || botUser.id !== this.botId) return null;
      if (!snowflake(guild.owner_id) || !Array.isArray(member.roles) || !member.roles.every(snowflake) || !Array.isArray(r)) throw new Error('discord_lookup_failed');
      const roles = r.map((value) => {
        const role = record(value);
        if (!snowflake(role.id) || typeof role.permissions !== 'string' || !/^\d+$/.test(role.permissions)) throw new Error('discord_lookup_failed');
        return { id: role.id, permissions: role.permissions };
      });
      return { guildId, userId, ownerId: guild.owner_id, botPresent: true, roleIds: member.roles as string[], roles };
    } catch { throw new MembershipVerificationError('invalid_response'); }
  }
  async isTextChannel(guildId: string, channelId: string, signal?: AbortSignal): Promise<boolean> {
    if (![guildId, channelId].every(snowflake)) return false;
    try { const channel = record(await this.request(`/channels/${channelId}`,signal)); return channel.id === channelId && channel.guild_id === guildId && channel.type === 0; }
    catch { return false; }
  }
}
