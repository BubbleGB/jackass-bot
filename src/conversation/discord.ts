import type { DiscordGet } from '../access/discord-membership.js';
import { isSnowflake } from '../access/policy.js';
import type { BotRequest } from '../domain/types.js';
import { ConversationError,contextOperation,validRequest,type HistoryMessage,type HistoryPage,type HistorySource } from './types.js';
const record = (v: unknown): Record<string,unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ConversationError('context_unavailable'); return v as Record<string,unknown>; };
const bits = (v: unknown): bigint => { if (typeof v !== 'string' || !/^\d{1,30}$/.test(v)) throw new ConversationError('context_unavailable'); return BigInt(v); };
const REQUIRED = (1n << 10n) | (1n << 11n) | (1n << 16n), ADMIN = 8n;
/** Explicit injected REST only. No gateway, SDK client, referenced-message, media or URL fetch. */
export class DiscordContextSource implements HistorySource {
  constructor(private readonly get: DiscordGet,readonly botId: string,private readonly now: () => Date = () => new Date()) {}
  async canRead(r: BotRequest,signal: AbortSignal): Promise<boolean> {
    if (!validRequest(r) || !isSnowflake(this.botId) || signal.aborted) return false;
    try {
      return await contextOperation(async timeout => {
        const joined = AbortSignal.any([signal,timeout]);
        const [c,g,u,b,rs] = await Promise.all([this.get(`/channels/${r.channelId}`,joined),this.get(`/guilds/${r.guildId}`,joined),this.get(`/guilds/${r.guildId}/members/${r.userId}`,joined),this.get(`/guilds/${r.guildId}/members/${this.botId}`,joined),this.get(`/guilds/${r.guildId}/roles`,joined)]);
        const channel = record(c),guild = record(g),user = record(u),bot = record(b);
        if (channel.id !== r.channelId || channel.guild_id !== r.guildId || channel.type !== 0 || guild.id !== r.guildId || !isSnowflake(guild.owner_id) || record(user.user).id !== r.userId || record(user.user).bot === true || record(user.user).system === true || record(bot.user).id !== this.botId || !Array.isArray(rs) || rs.length > 1000 || !Array.isArray(channel.permission_overwrites) || channel.permission_overwrites.length > 1000) return false;
        const roles = rs.map(v => { const role = record(v); if (!isSnowflake(role.id)) throw new ConversationError('context_unavailable'); return { id: role.id,permissions: bits(role.permissions) }; });
        const overwrites = channel.permission_overwrites.map(v => { const o = record(v); if (!isSnowflake(o.id) || (o.type !== 0 && o.type !== 1)) throw new ConversationError('context_unavailable'); return { id: o.id,type: o.type,allow: bits(o.allow),deny: bits(o.deny) }; });
        const allowed = (member: Record<string,unknown>,id: string) => {
          if (!Array.isArray(member.roles) || member.roles.length > 1000 || !member.roles.every(isSnowflake) || !member.roles.every(id => roles.some(role => role.id === id))) return false;
          const roleIds = member.roles as string[];
          const everyone = roles.find(role => role.id === r.guildId); if (!everyone) return false;
          let permissions = roles.filter(role => role.id === r.guildId || roleIds.includes(role.id)).reduce((p,role) => p | role.permissions,everyone.permissions);
          if (id === guild.owner_id || (permissions & ADMIN) !== 0n) return true;
          if (member.communication_disabled_until !== undefined && member.communication_disabled_until !== null) { const end = Date.parse(String(member.communication_disabled_until)); if (!Number.isFinite(end) || end > this.now().getTime()) return false; }
          const apply = (deny: bigint,allow: bigint) => { permissions = (permissions & ~deny) | allow; };
          const base = overwrites.find(o => o.type === 0 && o.id === r.guildId); if (base) apply(base.deny,base.allow);
          const matches = overwrites.filter(o => o.type === 0 && roleIds.includes(o.id) && o.id !== r.guildId);
          apply(matches.reduce((v,o) => v | o.deny,0n),matches.reduce((v,o) => v | o.allow,0n));
          const own = overwrites.find(o => o.type === 1 && o.id === id); if (own) apply(own.deny,own.allow);
          return (permissions & REQUIRED) === REQUIRED;
        };
        return !joined.aborted && allowed(user,r.userId) && allowed(bot,this.botId);
      });
    } catch { return false; }
  }
  private message(value: unknown,r: BotRequest): HistoryMessage | null {
    try {
      const m = record(value),author = record(m.author);
      if (!isSnowflake(m.id) || m.channel_id !== r.channelId || (m.guild_id !== undefined && m.guild_id !== r.guildId) || !isSnowflake(author.id) || ![0,19,20].includes(Number(m.type)) || m.webhook_id !== undefined || author.system === true || typeof m.content !== 'string' || typeof m.timestamp !== 'string') return null;
      const timestamp = new Date(m.timestamp); if (!Number.isFinite(timestamp.getTime())) return null;
      const ref = m.message_reference ? record(m.message_reference) : {},referenced = m.referenced_message ? record(m.referenced_message) : {};
      return { id: m.id,guildId: r.guildId,channelId: r.channelId,authorId: author.id,authorBot: author.bot === true,webhookId: null,content: m.content,timestamp,mentionsBot: Array.isArray(m.mentions) && m.mentions.some(v => record(v).id === this.botId),repliesToBot: m.type === 19 && ref.channel_id === r.channelId && (ref.guild_id === undefined || ref.guild_id === r.guildId) && !!referenced.author && record(referenced.author).id === this.botId };
    } catch { return null; }
  }
  async fetchPage(r: BotRequest,before: string | undefined,limit: number,signal: AbortSignal): Promise<HistoryPage> {
    if (!validRequest(r) || limit !== 100 || (before !== undefined && !isSnowflake(before)) || signal.aborted) throw new ConversationError('context_unavailable');
    try {
      const raw = await this.get(`/channels/${r.channelId}/messages?limit=100${before ? `&before=${before}` : ''}`,signal);
      if (!Array.isArray(raw) || raw.length > 100) throw new ConversationError('context_unavailable');
      // Preserve raw page fullness/cursor semantics, including ignored bot/system rows.
      const ids = raw.map(v => record(v).id);
      if (!ids.every(isSnowflake)) throw new ConversationError('context_unavailable');
      ids.sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1);
      return { messages: raw.map(v => this.message(v,r)).filter((m): m is HistoryMessage => m !== null),before: raw.length === 100 ? ids[0]! : null };
    } catch { throw new ConversationError('context_unavailable'); }
  }
  async fetchTrigger(r: BotRequest,signal: AbortSignal): Promise<HistoryMessage | null> {
    if (!validRequest(r) || r.source === 'ask' || signal.aborted) return null;
    try { const m = this.message(await this.get(`/channels/${r.channelId}/messages/${r.id}`,signal),r); return m?.id === r.id && !m.authorBot ? m : null; }
    catch { throw new ConversationError('context_unavailable'); }
  }
}
