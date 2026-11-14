import type { BotRequest } from '../domain/types.js';
import { isSnowflake } from '../access/policy.js';
import { DiscordFailure,discordBounded,type DiscordTransport } from './transport.js';
export const deliveryLimits = { chunkUnits: 2000,maxChunks: 32,attempts: 3,maxRetryMs: 2000,deadlineMs: 20000,participants: 3 } as const;
export interface InteractionTarget { applicationId: string; token: string }
export interface DeliveryReport { state: 'delivered' | 'failed' | 'uncertain' | 'blocked'; deliveredMessageIds: string[]; nextChunk: number }
/** Escape Markdown per atomic unit: split answers remain readable plain text, with no
 * dangling fences/emphasis/escapes. Preserve Unicode scalar and mention boundaries.
 */
const markdown = new Set(['\\','`','*','_','~','|','>','[',']','(',')']);
export function splitAnswer(text: string): string[] {
  const chunks: string[] = []; let chunk = '';
  for (const match of text.toWellFormed().matchAll(/<@!?\d{17,20}>|[\s\S]/gu)) {
    const raw = match[0],unit = raw.length > 2 ? raw : markdown.has(raw) ? `\\${raw}` : raw;
    if (chunk.length+unit.length > deliveryLimits.chunkUnits) { chunks.push(chunk); chunk = ''; }
    chunk += unit;
  }
  if (chunk) chunks.push(chunk); if (!chunks.length || chunks.length > deliveryLimits.maxChunks) throw new DiscordFailure('too_long'); return chunks;
}
export class DiscordDelivery {
  private readonly workerSignal: AbortSignal | undefined;
  private readonly delay: (ms: number,signal: AbortSignal) => Promise<void>;
  constructor(private readonly transport: DiscordTransport,private readonly canDeliver: (request: BotRequest,signal: AbortSignal) => Promise<boolean>,options: { delay?: (ms: number,signal: AbortSignal) => Promise<void>; signal?: AbortSignal } = {}) {
    this.workerSignal = options.signal;
    this.delay = options.delay ?? ((ms,signal) => new Promise<void>((resolve,reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },ms); const abort = () => { clearTimeout(timer); reject(new DiscordFailure('uncertain')); }; signal.addEventListener('abort',abort,{ once: true }); if (signal.aborted) abort(); }));
  }
  async deliverAnswer(r: BotRequest,text: string,participantIds: readonly string[],interaction?: InteractionTarget): Promise<DeliveryReport> {
    const users = [...new Set(participantIds.filter(isSnowflake))].slice(0,deliveryLimits.participants),allowed = new Set(users);
    const safe = text.replace(/@(everyone|here)/g,'@\u200b$1').replace(/<@&\d+>/g,m => m.replace('@','@\u200b')).replace(/<@!?(\d+)>/g,(m,id: string) => allowed.has(id) ? `<@${id}>` : m.replace('@','@\u200b'));
    const deliveredMessageIds: string[] = []; let chunks: string[];
    try { chunks = splitAnswer(safe); } catch { return { state: 'failed',deliveredMessageIds,nextChunk: 0 }; }
    const controller = new AbortController(),timer = setTimeout(() => controller.abort(),deliveryLimits.deadlineMs),signal = this.workerSignal ? AbortSignal.any([controller.signal,this.workerSignal]) : controller.signal;
    try {
      for (let index = 0; index < chunks.length; index++) {
        const body: Record<string,unknown> = { content: chunks[index],allowed_mentions: { parse: [],roles: [],users,replied_user: false } };
        if (!interaction && index === 0 && ['mention','reply'].includes(r.source)) body.message_reference = { message_id: r.id,channel_id: r.channelId,guild_id: r.guildId,fail_if_not_exists: false };
        const method = interaction && index === 0 ? 'PATCH' as const : 'POST' as const;
        const path = interaction ? `/webhooks/${interaction.applicationId}/${encodeURIComponent(interaction.token)}${index === 0 ? '/messages/@original' : '?wait=true'}` : `/channels/${r.channelId}/messages`;
        if (interaction && index > 0) body.flags = 0;
        for (let attempt = 0; ; attempt++) {
          let permission = false;
          try { permission = await discordBounded(() => this.canDeliver(r,signal),signal); } catch { /* Unverifiable permission fails closed before send. */ }
          if (!permission || signal.aborted) return { state: 'blocked',deliveredMessageIds,nextChunk: index };
          try {
            const response = await discordBounded(() => this.transport.call({ method,path,body,signal }),signal) as { id?: unknown } | null;
            if (!response || typeof response.id !== 'string' || !response.id) throw new DiscordFailure('uncertain');
            deliveredMessageIds.push(response.id); break;
          } catch (e) {
            const retry = e instanceof DiscordFailure && ['retryable','rate_limited'].includes(e.kind) && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0 && e.retryAfterMs <= deliveryLimits.maxRetryMs;
            if (retry && attempt+1 < deliveryLimits.attempts && !signal.aborted) { try { await discordBounded(() => this.delay(e.retryAfterMs,signal),signal); continue; } catch { /* Deadline expired; never retry ambiguous work. */ } }
            return { state: !(e instanceof DiscordFailure) || e.kind === 'uncertain' ? 'uncertain' : 'failed',deliveredMessageIds,nextChunk: index };
          }
        }
      }
      return { state: 'delivered',deliveredMessageIds,nextChunk: chunks.length };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
