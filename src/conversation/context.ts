import type { BotRequest,ContextMessage,GenerationInput } from '../domain/types.js';
import type { GuildSettings } from '../settings/service.js';
import { bounds } from '../settings/validation.js';
import { MODELS,supportsModel } from '../providers/catalog.js';
import { ConversationError,contextOperation,conversationLimits,humanTrigger,validRequest,type HistoryMessage,type HistorySource,type InputCounter } from './types.js';
const order = (a: ContextMessage,b: ContextMessage) => a.timestamp.getTime()-b.timestamp.getTime() || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
export class ContextBuilder {
  constructor(private readonly history: HistorySource,private readonly countInput: InputCounter) {}
  async buildContext(request: BotRequest,settings: GuildSettings): Promise<ContextMessage[]> {
    return contextOperation(async signal => {
      if (!validRequest(request) || settings.guildId !== request.guildId || !settings.enabled || !settings.directEnabled) throw new ConversationError('context_unavailable');
      for (const field of ['humanContextLimit','selfContextLimit','contextTokenLimit','maxGenerationTokens'] as const) { const [min,max] = bounds[field]; if (!Number.isSafeInteger(settings[field]) || settings[field] < min || settings[field] > max) throw new ConversationError('context_limit'); }
      if (settings.humanContextLimit < 1 || typeof settings.instructions !== 'string' || settings.instructions.length > 8000) throw new ConversationError('context_limit');
      const providers = settings.providers.filter(p => p.modelId !== null && /^[1-9]\d*$/.test(p.dailyAllowance));
      if (!providers.length || providers.some(p => !supportsModel({ provider: p.provider,modelId: p.modelId!,effort: p.effort,contextTokenLimit: settings.contextTokenLimit,maxGenerationTokens: settings.maxGenerationTokens }))) throw new ConversationError('context_limit');
      if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
      let required: ContextMessage;
      if (request.source === 'ask') required = { id: `ask:${request.id}`,authorId: request.userId,kind: 'human',text: request.prompt!,timestamp: new Date(request.receivedAt) };
      else {
        const m = await this.history.fetchTrigger(request,signal);
        if (!humanTrigger(m,request) || !this.usable(m,request)) throw new ConversationError('context_unavailable');
        required = this.convert(m);
      }
      const all = new Map<string,ContextMessage>();
      let before: string | undefined;
      for (let page = 0; page < conversationLimits.maxPages; page++) {
        const result = await this.history.fetchPage(request,before,conversationLimits.pageSize,signal);
        if (signal.aborted) throw new ConversationError('context_unavailable');
        const rows = result.messages;
        if (!Array.isArray(rows) || rows.length > conversationLimits.pageSize) throw new ConversationError('context_unavailable');
        for (const m of rows) if (this.usable(m,request) && (request.source === 'ask' || order(this.convert(m),required) < 0) && m.id !== required.id && !all.has(m.id)) all.set(m.id,this.convert(m));
        const cursor = result.before;
        const humans = [...all.values()].filter(m => m.kind === 'human').length;
        if (!cursor || cursor === before || (before !== undefined && BigInt(cursor) >= BigInt(before)) || (humans >= settings.humanContextLimit-1 && [...all.values()].filter(m => m.kind === 'self').length >= settings.selfContextLimit)) break;
        before = cursor;
      }
      let humans = 1,selves = 0;
      const optional = [...all.values()].sort(order).reverse().filter(m => m.kind === 'human' ? humans++ < settings.humanContextLimit : selves++ < settings.selfContextLimit).reverse();
      let context = [...optional,required];
      let trim: { chars: string[]; low: number; high: number; best: ContextMessage[] | null } | undefined;
      for (let round = 0; round < conversationLimits.maxCountRounds; round++) {
        if (signal.aborted) throw new ConversationError('context_unavailable');
        let counted = false;
        let fits = Buffer.byteLength(JSON.stringify(context),'utf8') <= 1000000;
        if (fits) for (const p of providers) {
          if (signal.aborted || !await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
          const input: GenerationInput = { instructions: settings.instructions,context,mode: 'direct',modelId: p.modelId!,maxGenerationTokens: settings.maxGenerationTokens,...(p.effort !== null ? { effort: p.effort } : {}) };
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
        if (fits && !trim) {
          if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
          return context;
        }
        if (context.length > 1) context = context.slice(Math.ceil((context.length-1)/2));
        else {
          trim ??= { chars: Array.from(required.text),low: 0,high: Array.from(required.text).length,best: null };
          const length = Array.from(context[0]!.text).length;
          if (fits) { trim.low = length; trim.best = context; } else trim.high = length;
          if (trim.high-trim.low <= 1) {
            if (!trim.best) throw new ConversationError('context_limit');
            if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
            return trim.best;
          }
          const next = Math.floor((trim.high+trim.low)/2);
          required = { ...required,text: trim.chars.slice(-next).join('') }; context = [required];
        }
      }
      throw new ConversationError('context_limit');
    });
  }
  private usable(m: HistoryMessage,r: BotRequest): boolean {
    return !!m && m.guildId === r.guildId && m.channelId === r.channelId && typeof m.id === 'string' && /^\d{1,20}$/.test(m.id) && typeof m.authorId === 'string' && /^\d{17,20}$/.test(m.authorId) && m.webhookId === null && typeof m.authorBot === 'boolean' && (!m.authorBot || m.authorId === this.history.botId) && typeof m.content === 'string' && m.content.length <= conversationLimits.maxPromptCharacters && m.timestamp instanceof Date && Number.isFinite(m.timestamp.getTime()) && m.timestamp.getTime() <= r.receivedAt.getTime();
  }
  private convert(m: HistoryMessage): ContextMessage { return { id: m.id,authorId: m.authorId,kind: m.authorId === this.history.botId ? 'self' : 'human',text: m.content,timestamp: new Date(m.timestamp) }; }
}
