import type { BotRequest,ContextMessage,GenerationInput } from '../domain/types.js';
import type { GuildSettings } from '../settings/service.js';
import { bounds } from '../settings/validation.js';
import { MODELS,supportsModel } from '../providers/catalog.js';
import { ConversationError,contextOperation,conversationLimits,humanTrigger,validContextRequest,type AutomaticContextResult,type HistoryMessage,type HistorySource,type InputCounter } from './types.js';
const order = (a: ContextMessage,b: ContextMessage) => a.timestamp.getTime()-b.timestamp.getTime() || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
export class ContextBuilder {
  constructor(private readonly history: HistorySource,private readonly countInput: InputCounter) {}
  /** Context construction only: no scheduling, activity counters or generation. */
  async buildAutomaticContext(request: BotRequest,settings: GuildSettings,parent?: AbortSignal): Promise<AutomaticContextResult> {
    if (request.source !== 'automatic') return { status: 'skipped',reason: 'context_unavailable' };
    try { return { status: 'ready',context: await this.buildContext(request,settings,parent) }; }
    catch (e) {
      const reason = e instanceof ConversationError && ['input_too_large','no_usable_context','context_check_limit'].includes(e.message) ? e.message as 'input_too_large' | 'no_usable_context' | 'context_check_limit' : 'context_unavailable';
      return { status: 'skipped',reason };
    }
  }
  async buildContext(request: BotRequest,settings: GuildSettings,parent?: AbortSignal): Promise<ContextMessage[]> {
    return contextOperation(async signal => {
      const automatic = request.source === 'automatic';
      if (!validContextRequest(request) || settings.guildId !== request.guildId || !settings.enabled || (!automatic && !settings.directEnabled)) throw new ConversationError('context_unavailable');
      for (const field of ['humanContextLimit','selfContextLimit','contextTokenLimit','maxGenerationTokens'] as const) { const [min,max] = bounds[field]; if (!Number.isSafeInteger(settings[field]) || settings[field] < min || settings[field] > max) throw new ConversationError('context_limit'); }
      if (typeof settings.instructions !== 'string') throw new ConversationError('context_limit');
      if (settings.instructions.length > 8000 || (request.source === 'ask' && request.prompt!.length > conversationLimits.maxPromptCharacters)) throw new ConversationError('input_too_large');
      const providers = settings.providers.filter(p => p.modelId !== null && /^[1-9]\d*$/.test(p.dailyAllowance));
      if (!providers.length || providers.some(p => !supportsModel({ provider: p.provider,modelId: p.modelId!,effort: p.effort,contextTokenLimit: settings.contextTokenLimit,maxGenerationTokens: settings.maxGenerationTokens }))) throw new ConversationError('context_limit');
      if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
      let required: ContextMessage;
      if (request.source === 'ask') required = { id: `ask:${request.id}`,authorId: request.userId,kind: 'human',text: request.prompt!,timestamp: new Date(request.receivedAt) };
      else {
        const m = await this.history.fetchTrigger(request,signal);
        if (!automatic && humanTrigger(m,request) && m.content.length > conversationLimits.maxPromptCharacters) throw new ConversationError('input_too_large');
        if (!humanTrigger(m,request) || !this.usable(m,request,automatic)) throw new ConversationError('context_unavailable');
        required = this.convert(m);
      }
      const all = new Map<string,ContextMessage>();
      if (automatic && required.text.length <= conversationLimits.maxPromptCharacters && required.text.trim().length > 0) all.set(required.id,required);
      let before: string | undefined;
      for (let page = 0; page < conversationLimits.maxPages && (settings.humanContextLimit > 0 || settings.selfContextLimit > 0); page++) {
        const result = await this.history.fetchPage(request,before,conversationLimits.pageSize,signal);
        if (signal.aborted) throw new ConversationError('context_unavailable');
        const rows = result.messages;
        if (!Array.isArray(rows) || rows.length > conversationLimits.pageSize) throw new ConversationError('context_unavailable');
        for (const m of rows) if (this.usable(m,request) && (!automatic || m.content.trim().length > 0) && (request.source === 'ask' || order(this.convert(m),required) < 0) && m.id !== required.id && !all.has(m.id)) all.set(m.id,this.convert(m));
        const cursor = result.before;
        const humans = [...all.values()].filter(m => m.kind === 'human').length;
        if (!cursor || cursor === before || (before !== undefined && BigInt(cursor) >= BigInt(before)) || (humans >= settings.humanContextLimit && [...all.values()].filter(m => m.kind === 'self').length >= settings.selfContextLimit)) break;
        before = cursor;
      }
      let humans = 0,selves = 0;
      const optional = [...all.values()].sort(order).reverse().filter(m => m.kind === 'human' ? humans++ < settings.humanContextLimit : selves++ < settings.selfContextLimit).reverse();
      let context = automatic ? optional : [...optional,required];
      // Automatic assessments need actual human conversation, never instructions or
      // our own output alone. Protect the newest nonblank human while dropping history.
      const anchors = automatic ? [...context].reverse().filter(c => c.kind === 'human' && c.text.trim().length > 0) : [required];
      const first = anchors.shift();
      if (!first) throw new ConversationError('no_usable_context');
      let anchor: ContextMessage = first;
      for (let round = 0; round < conversationLimits.maxCountRounds; round++) {
        if (signal.aborted) throw new ConversationError('context_unavailable');
        let counted = false;
        let fits = Buffer.byteLength(JSON.stringify(context),'utf8') <= 1000000;
        if (fits) for (const p of providers) {
          if (signal.aborted || !await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
          const input: GenerationInput = { instructions: settings.instructions,context,mode: automatic ? (settings.autoPolicy === 'always' ? 'auto_always' : 'auto_conditional') : 'direct',modelId: p.modelId!,maxGenerationTokens: settings.maxGenerationTokens,...(p.effort !== null ? { effort: p.effort } : {}) };
          let count: number | null;
          try { count = await this.countInput(p.provider,structuredClone(input),signal,{ guildId: request.guildId,revision: settings.revision }); }
          catch (e) { if (e instanceof Error && e.message === 'input_too_large') { fits = false; break; } throw e; }
          if (signal.aborted) throw new ConversationError('context_unavailable');
          if (count === null) continue;
          counted = true;
          if (!Number.isSafeInteger(count) || count < 0) throw new ConversationError('context_unavailable');
          const m = MODELS.find(m => m.provider === p.provider && m.id === p.modelId)!;
          if (count > settings.contextTokenLimit || count+settings.maxGenerationTokens > m.inputLimit) { fits = false; break; }
        }
        if (fits && !counted) throw new ConversationError('context_unavailable');
        if (fits) {
          if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
          return context;
        }
        // Never edit instructions, direct text, or the last usable automatic message.
        // Remove only the oldest whole optional history, retaining chronological order.
        const removable = context.filter(c => c.id !== anchor.id);
        if (!removable.length) {
          const older = automatic ? anchors.shift() : undefined;
          if (!older) throw new ConversationError('input_too_large');
          anchor = older; context = [older]; continue;
        }
        const remove = new Set(removable.slice(0,Math.ceil(removable.length/2)).map(c => c.id));
        context = context.filter(c => !remove.has(c.id));
      }
      throw new ConversationError(automatic ? 'context_check_limit' : 'input_too_large');
    },parent);
  }
  private usable(m: HistoryMessage,r: BotRequest,allowOversized = false): boolean {
    return !!m && m.guildId === r.guildId && m.channelId === r.channelId && typeof m.id === 'string' && /^\d{1,20}$/.test(m.id) && typeof m.authorId === 'string' && /^\d{17,20}$/.test(m.authorId) && m.webhookId === null && typeof m.authorBot === 'boolean' && (!m.authorBot || m.authorId === this.history.botId) && typeof m.content === 'string' && (allowOversized || m.content.length <= conversationLimits.maxPromptCharacters) && m.timestamp instanceof Date && Number.isFinite(m.timestamp.getTime()) && m.timestamp.getTime() <= r.receivedAt.getTime();
  }
  private convert(m: HistoryMessage): ContextMessage { return { id: m.id,authorId: m.authorId,kind: m.authorId === this.history.botId ? 'self' : 'human',text: m.content,timestamp: new Date(m.timestamp) }; }
}
