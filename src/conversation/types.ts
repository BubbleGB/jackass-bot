import type { BotRequest,ContextMessage,GenerationInput,ProviderId } from '../domain/types.js';
import type { GuildSettings } from '../settings/service.js';
export class ConversationError extends Error {
  constructor(code: 'context_unavailable' | 'context_limit' | 'configuration_changed' | 'direct_failed' | 'input_too_large' | 'no_usable_context' | 'context_check_limit' | 'queue_full' | 'request_stale' | 'worker_stopped' | 'worker_unavailable') { super(code); this.name = 'ConversationError'; }
}
export interface HistoryMessage {
  id: string; guildId: string; channelId: string; authorId: string; authorBot: boolean;
  webhookId: string | null; content: string; timestamp: Date; mentionsBot: boolean; repliesToBot: boolean;
}
export interface HistoryPage { messages: HistoryMessage[]; before: string | null }
/** All operations use fresh channel/member permissions, without OAuth/gateway caches. */
export interface HistorySource {
  readonly botId: string;
  canRead(request: BotRequest,signal: AbortSignal): Promise<boolean>;
  fetchPage(request: BotRequest,before: string | undefined,limit: number,signal: AbortSignal): Promise<HistoryPage>;
  fetchTrigger(request: BotRequest,signal: AbortSignal): Promise<HistoryMessage | null>;
}
export interface ConversationConfigRepository { load(guildId: string): Promise<GuildSettings | null> }
/** Complete input estimate, including trusted instructions, history and schema, not output.
 * Bind to this guild/revision; never expose credentials to conversation callers.
 */
export type InputCounter = (provider: ProviderId,input: GenerationInput,signal: AbortSignal,scope: { guildId: string; revision: number }) => Promise<number | null>;
export const conversationLimits = { directCooldownMs: 5000,contextDeadlineMs: 20000,maxPages: 3,pageSize: 100,maxCountRounds: 24,maxPromptCharacters: 6000,maxGateEntries: 10000 } as const;
export interface InputTooLargeResult { status: 'input_too_large'; message: string }
export const INPUT_TOO_LARGE: Readonly<InputTooLargeResult> = { status: 'input_too_large',message: 'The server instructions and current request do not fit the configured input and generation limits.' };
export type AutomaticContextResult = { status: 'ready'; context: ContextMessage[] } | { status: 'skipped'; reason: 'input_too_large' | 'no_usable_context' | 'context_unavailable' | 'context_check_limit' };
export function validContextRequest(r: BotRequest): boolean {
  return [r.id,r.guildId,r.channelId,r.userId].every(v => typeof v === 'string' && /^\d{17,20}$/.test(v)) && r.receivedAt instanceof Date && Number.isFinite(r.receivedAt.getTime()) && ['mention','reply','ask','automatic'].includes(r.source) && (r.source !== 'ask' || (typeof r.prompt === 'string' && r.prompt.trim().length > 0));
}
export function validRequest(r: BotRequest): boolean { return validContextRequest(r) && r.source !== 'automatic'; }
/** Whole-operation deadline even when an injected dependency ignores cancellation. */
export async function contextOperation<T>(run: (signal: AbortSignal) => Promise<T>,parent?: AbortSignal): Promise<T> {
  const controller = new AbortController(),signal = parent ? AbortSignal.any([parent,controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined,abort!: () => void;
  try {
    if (signal.aborted) throw new ConversationError('worker_unavailable');
    const cancelled = new Promise<never>((_resolve,reject) => { abort = () => reject(new ConversationError(parent?.aborted ? 'worker_unavailable' : 'context_unavailable')); signal.addEventListener('abort',abort,{ once: true }); });
    timer = setTimeout(() => controller.abort(),conversationLimits.contextDeadlineMs);
    return await Promise.race([run(signal),cancelled]);
  } catch (e) { if (e instanceof ConversationError) throw e; throw new ConversationError('context_unavailable'); }
  finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort',abort); controller.abort(); }
}
export function humanTrigger(m: HistoryMessage | null,r: BotRequest): m is HistoryMessage {
  return !!m && m.id === r.id && m.guildId === r.guildId && m.channelId === r.channelId && m.authorId === r.userId && !m.authorBot && m.webhookId === null && (r.source === 'automatic' || (r.source === 'mention' ? m.mentionsBot : r.source === 'reply' && m.repliesToBot));
}
