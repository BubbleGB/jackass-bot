import type { BotRequest,ContextMessage,GenerationInput } from '../domain/types.js';
import type { GuildSettings } from '../settings/service.js';
import { bounds } from '../settings/validation.js';
import { MODELS,supportsModel,fitsModelTokens } from '../providers/catalog.js';
import type { KnowledgePassage,KnowledgeSource } from '../knowledge/types.js';
import { knowledgeLimits } from '../knowledge/limits.js';
import { characters,prefix } from '../knowledge/text.js';
import { nameContext,safeName } from './names.js';
import { ConversationError,contextOperation,conversationLimits,humanTrigger,validContextRequest,type AutomaticContextResult,type HistoryMessage,type HistorySource,type InputCounter } from './types.js';
const order = (a: ContextMessage,b: ContextMessage) => a.timestamp.getTime()-b.timestamp.getTime() || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
export class ContextBuilder {
  constructor(private readonly history: HistorySource,private readonly countInput: InputCounter,private readonly knowledge?: KnowledgeSource) {}
  /** Context construction only: no scheduling, activity counters or generation. */
  async buildAutomaticContext(request: BotRequest,settings: GuildSettings,parent?: AbortSignal): Promise<AutomaticContextResult> {
    if (request.source !== 'automatic') return { status: 'skipped',reason: 'context_unavailable' };
    try { const bundle = await this.buildBundle(request,settings,parent); return { status: 'ready',context: bundle.context,...(bundle.knowledge.length ? { knowledge: bundle.knowledge } : {}) }; }
    catch (e) {
      const reason = e instanceof ConversationError && ['input_too_large','no_usable_context','context_check_limit'].includes(e.message) ? e.message as 'input_too_large' | 'no_usable_context' | 'context_check_limit' : 'context_unavailable';
      return { status: 'skipped',reason };
    }
  }
  async buildContext(request: BotRequest,settings: GuildSettings,parent?: AbortSignal): Promise<ContextMessage[]> {
    return (await this.buildBundle(request,settings,parent)).context;
  }
  async buildBundle(request: BotRequest,settings: GuildSettings,parent?: AbortSignal): Promise<{ context: ContextMessage[]; knowledge: KnowledgePassage[] }> {
    return contextOperation(async signal => {
      const automatic = request.source === 'automatic';
      if (!validContextRequest(request) || settings.guildId !== request.guildId || !settings.enabled || (!automatic && !settings.directEnabled)) throw new ConversationError('context_unavailable');
      for (const field of ['humanContextLimit','selfContextLimit','contextTokenLimit','maxGenerationTokens','knowledgeTokenLimit'] as const) { const [min,max] = bounds[field]; if (!Number.isSafeInteger(settings[field]) || settings[field] < min || settings[field] > max) throw new ConversationError('context_limit'); }
      if (typeof settings.instructions !== 'string') throw new ConversationError('context_limit');
      if (settings.instructions.length > 8000 || (request.source === 'ask' && request.prompt!.length > conversationLimits.maxPromptCharacters)) throw new ConversationError('input_too_large');
      const providers = settings.providers.filter(p => p.modelId !== null && /^[1-9]\d*$/.test(p.dailyAllowance));
      if (!providers.length || providers.some(p => !supportsModel({ provider: p.provider,modelId: p.modelId!,effort: p.effort,contextTokenLimit: settings.contextTokenLimit,maxGenerationTokens: settings.maxGenerationTokens }))) throw new ConversationError('context_limit');
      if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
      let required: ContextMessage; const knownNames = new Set<string>(),requestName = safeName(request.displayName);
      if (request.source === 'ask') { required = { id: `ask:${request.id}`,authorId: request.userId,kind: 'human',text: request.prompt!,timestamp: new Date(request.receivedAt),...(requestName ? { displayName: requestName } : {}) }; if (requestName) knownNames.add(request.userId); }
      else {
        const m = await this.history.fetchTrigger(request,signal);
        if (!automatic && humanTrigger(m,request) && m.content.length > conversationLimits.maxPromptCharacters) throw new ConversationError('input_too_large');
        if (!humanTrigger(m,request) || !this.usable(m,request,automatic)) throw new ConversationError('context_unavailable');
        required = this.convert(m);
        if (m.authorNameKnown && required.displayName) knownNames.add(m.authorId);
      }
      const all = new Map<string,ContextMessage>();
      if (automatic && required.text.length <= conversationLimits.maxPromptCharacters && required.text.trim().length > 0) all.set(required.id,required);
      let before: string | undefined;
      for (let page = 0; page < conversationLimits.maxPages && (settings.humanContextLimit > 0 || settings.selfContextLimit > 0); page++) {
        const result = await this.history.fetchPage(request,before,conversationLimits.pageSize,signal);
        if (signal.aborted) throw new ConversationError('context_unavailable');
        const rows = result.messages;
        if (!Array.isArray(rows) || rows.length > conversationLimits.pageSize) throw new ConversationError('context_unavailable');
        for (const m of rows) if (this.usable(m,request) && (!automatic || m.content.trim().length > 0) && (request.source === 'ask' || order(this.convert(m),required) < 0) && m.id !== required.id && !all.has(m.id)) { all.set(m.id,this.convert(m)); if (m.authorNameKnown && m.displayName) knownNames.add(m.authorId); }
        const cursor = result.before;
        const humans = [...all.values()].filter(m => m.kind === 'human').length;
        if (!cursor || cursor === before || (before !== undefined && BigInt(cursor) >= BigInt(before)) || (humans >= settings.humanContextLimit && [...all.values()].filter(m => m.kind === 'self').length >= settings.selfContextLimit)) break;
        before = cursor;
      }
      let humans = 0,selves = 0;
      const optional = [...all.values()].sort(order).reverse().filter(m => m.kind === 'human' ? humans++ < settings.humanContextLimit : selves++ < settings.selfContextLimit).reverse();
      let context = await nameContext(this.history,request,automatic ? optional : [...optional,required],knownNames,signal);
      const budget = Math.min(settings.knowledgeTokenLimit,settings.contextTokenLimit);
      const recent = context.filter(c => c.kind === 'human' && (automatic || c.id !== required.id)).slice(-knowledgeLimits.recentHumans).reverse().map(c => prefix(c.text,256));
      const query = prefix([...(automatic ? [] : [prefix(required.text,1024)]),...recent].join('\n'),knowledgeLimits.queryCharacters);
      let knowledge = budget > 0 && this.knowledge ? structuredClone(await this.knowledge.retrieve(request.guildId,query,signal)) : [];
      if (!Array.isArray(knowledge) || knowledge.length > knowledgeLimits.retrievedChunks) throw new ConversationError('context_unavailable');
      // Automatic assessments need actual human conversation, never instructions or
      // our own output alone. Protect the newest nonblank human while dropping history.
      const anchors = automatic ? [...context].reverse().filter(c => c.kind === 'human' && c.text.trim().length > 0) : [required];
      const first = anchors.shift();
      if (!first) throw new ConversationError('no_usable_context');
      let anchor: ContextMessage = first;
      for (let round = 0; round < conversationLimits.maxCountRounds; round++) {
        if (signal.aborted) throw new ConversationError('context_unavailable');
        // Keep work bounded, but always test required input (or the automatic human
        // anchor) alone before optional material can exhaust the fitting budget.
        if (round === conversationLimits.maxCountRounds-1) { context = [anchor]; knowledge = []; }
        let counted = false,knowledgeTooLarge = false;
        let fits = Buffer.byteLength(JSON.stringify({ context,knowledge }),'utf8') <= 1000000;
        if (fits) for (const p of providers) {
          if (signal.aborted || !await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
          if (knowledge.length && (!this.knowledge || !await this.knowledge.current(request.guildId,knowledge,signal))) throw new ConversationError('configuration_changed');
          const input: GenerationInput = { instructions: settings.instructions,context,...(knowledge.length ? { knowledge } : {}),mode: automatic ? (settings.autoPolicy === 'always' ? 'auto_always' : 'auto_conditional') : 'direct',modelId: p.modelId!,maxGenerationTokens: settings.maxGenerationTokens,...(p.effort !== null ? { effort: p.effort } : {}) };
          let count: number | null;
          try { count = await this.countInput(p.provider,structuredClone(input),signal,{ guildId: request.guildId,revision: settings.revision }); }
          catch (e) { if (e instanceof Error && e.message === 'input_too_large') { fits = false; break; } throw e; }
          if (signal.aborted) throw new ConversationError('context_unavailable');
          if (count === null) continue;
          if (knowledge.length) {
            const baseline = await this.countInput(p.provider,structuredClone({ ...input,knowledge: [] }),signal,{ guildId: request.guildId,revision: settings.revision });
            if (baseline === null) continue;
            if (!Number.isSafeInteger(baseline) || baseline < 0 || baseline > count) throw new ConversationError('context_unavailable');
            if (count-baseline > budget) { knowledgeTooLarge = true; fits = false; break; }
          }
          counted = true;
          if (!Number.isSafeInteger(count) || count < 0) throw new ConversationError('context_unavailable');
          const m = MODELS.find(m => m.provider === p.provider && m.id === p.modelId)!;
          if (count > settings.contextTokenLimit || !fitsModelTokens(m,count,settings.maxGenerationTokens)) { fits = false; break; }
        }
        if (fits && !counted) throw new ConversationError('context_unavailable');
        if (fits) {
          if (!await this.history.canRead(request,signal)) throw new ConversationError('context_unavailable');
          if (knowledge.length && (!this.knowledge || !await this.knowledge.current(request.guildId,knowledge,signal))) throw new ConversationError('configuration_changed');
          return { context,knowledge };
        }
        if (knowledgeTooLarge) { knowledge = this.reduceKnowledge(knowledge); continue; }
        // Never edit instructions, direct text, or the last usable automatic message.
        // Remove only the oldest whole optional history, retaining chronological order.
        const removable = context.filter(c => c.id !== anchor.id);
        if (!removable.length) {
          if (knowledge.length) { knowledge = this.reduceKnowledge(knowledge); continue; }
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
  private reduceKnowledge(knowledge: KnowledgePassage[]): KnowledgePassage[] {
    if (knowledge.length > 1) return knowledge.slice(0,-1);
    const first = knowledge[0]; if (!first) return [];
    const text = prefix(first.text,Math.floor(characters(first.text)/2)); return text.trim() ? [{ ...first,text }] : [];
  }
  private usable(m: HistoryMessage,r: BotRequest,allowOversized = false): boolean {
    return !!m && m.guildId === r.guildId && m.channelId === r.channelId && typeof m.id === 'string' && /^\d{1,20}$/.test(m.id) && typeof m.authorId === 'string' && /^\d{17,20}$/.test(m.authorId) && m.webhookId === null && typeof m.authorBot === 'boolean' && (!m.authorBot || m.authorId === this.history.botId) && typeof m.content === 'string' && (allowOversized || m.content.length <= conversationLimits.maxPromptCharacters) && m.timestamp instanceof Date && Number.isFinite(m.timestamp.getTime()) && m.timestamp.getTime() <= r.receivedAt.getTime();
  }
  private convert(m: HistoryMessage): ContextMessage { const name = safeName(m.displayName); return { id: m.id,authorId: m.authorId,kind: m.authorId === this.history.botId ? 'self' : 'human',text: m.content,timestamp: new Date(m.timestamp),...(name ? { displayName: name } : {}) }; }
}
