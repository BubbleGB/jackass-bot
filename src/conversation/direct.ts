import type { BotRequest,GenerationInput,GenerationResult } from '../domain/types.js';
import { ProviderFailure } from '../providers/http.js';
import type { ProviderRouter } from '../providers/router.js';
import { DirectEligibility,type DirectAcceptance } from './eligibility.js';
import { ContextBuilder } from './context.js';
import { ConversationError,contextOperation,type ConversationConfigRepository,type HistorySource } from './types.js';
export type DirectOutcome = { status: 'accepted'; result: GenerationResult } | { status: Exclude<DirectAcceptance,'accepted'> };
export class DirectService {
  constructor(private readonly eligibility: DirectEligibility,private readonly config: ConversationConfigRepository,private readonly history: HistorySource,private readonly context: ContextBuilder,private readonly provider: Pick<ProviderRouter,'generateWithFallback'>) {}
  async handleDirect(request: BotRequest): Promise<DirectOutcome> {
    const r = structuredClone(request),status = await this.eligibility.acceptDirect(r);
    if (status !== 'accepted') return { status };
    try {
      const settings = await contextOperation(() => this.config.load(r.guildId));
      if (!settings || !settings.enabled || !settings.directEnabled) throw new ConversationError('configuration_changed');
      const context = await this.context.buildContext(r,settings);
      const current = await contextOperation(async signal => {
        const [config,canRead] = await Promise.all([this.config.load(r.guildId),this.history.canRead(r,signal)]);
        return config?.guildId === r.guildId && config.enabled && config.directEnabled && config.revision === settings.revision && canRead;
      });
      if (!current) throw new ConversationError('configuration_changed');
      const p = settings.providers.find(p => p.modelId !== null && /^[1-9]\d*$/.test(p.dailyAllowance));
      if (!p) throw new ConversationError('context_limit');
      const input: GenerationInput = { instructions: settings.instructions,context,mode: 'direct',modelId: p.modelId!,maxGenerationTokens: settings.maxGenerationTokens,...(p.effort !== null ? { effort: p.effort } : {}) };
      return { status: 'accepted',result: await this.provider.generateWithFallback(r,input,settings.revision) };
    } catch (e) { if (e instanceof ConversationError || e instanceof ProviderFailure) throw e; throw new ConversationError('direct_failed'); }
    finally { this.eligibility.completeDirect(r); }
  }
}
