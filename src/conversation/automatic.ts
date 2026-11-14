import type { BotRequest,GenerationInput,GenerationResult } from '../domain/types.js';
import { ProviderFailure } from '../providers/http.js';
import type { ProviderRouter,ProviderControls } from '../providers/router.js';
import type { ContextBuilder } from './context.js';
import type { DirectService,DirectOutcome } from './direct.js';
import { ConversationQueue } from './queue.js';
import { AutomaticRepository } from './receipts.js';
import type { PostgresWorkerGuard } from './worker.js';
import { ConversationError,contextOperation,humanTrigger,validContextRequest,type ConversationConfigRepository,type HistorySource } from './types.js';
export type ScheduledOutcome = { kind: 'result'; result: GenerationResult } | { kind: 'direct'; outcome: DirectOutcome } | { kind: 'skipped'; reason: string };
interface Dependencies {
  repository: Pick<AutomaticRepository,'observe' | 'begin' | 'finish' | 'recover'>; config: ConversationConfigRepository; history: HistorySource;
  context: Pick<ContextBuilder,'buildAutomaticContext'>; direct: Pick<DirectService,'handleDirect'>;
  provider: Pick<ProviderRouter,'generateWithFallback'>; queue: ConversationQueue;
  worker: Pick<PostgresWorkerGuard,'start' | 'stop' | 'assertActive' | 'signal' | 'token'>;
  now?: () => Date; onOutcome?: (request: BotRequest,outcome: ScheduledOutcome) => void | Promise<void>;
}
export class AutomaticService {
  private started = false; private accepting = false; private stopping = false;
  private startWork: Promise<boolean> | null = null; private stopWork: Promise<void> | null = null;
  private readonly queued = new Set<string>();
  private readonly now: () => Date;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? (() => new Date());
    deps.worker.signal.addEventListener('abort',() => deps.queue.close(),{ once: true });
  }
  async start(): Promise<boolean> {
    if (this.started || this.startWork || this.stopping) return false;
    const task = this.initialize(); this.startWork = task;
    try { return await task; } finally { this.startWork = null; }
  }
  private async initialize(): Promise<boolean> {
    try {
      if (!await this.deps.worker.start()) return false;
      if (this.stopping) return false;
      await this.deps.worker.assertActive(); await this.deps.repository.recover(this.deps.worker.token); await this.deps.worker.assertActive();
      this.started = true; this.accepting = !this.stopping; return this.accepting;
    } catch { await this.deps.worker.stop(); throw new ConversationError('worker_unavailable'); }
  }
  async stop(): Promise<void> {
    if (this.stopWork) return this.stopWork;
    this.stopping = true; this.accepting = false;
    const task = (async () => {
      try { await this.startWork; } catch { /* Failed startup still owns its cleanup. */ }
      this.deps.queue.close(); await this.deps.queue.idle();
      this.started = false; await this.deps.worker.stop();
    })();
    this.stopWork = task; return task;
  }
  private async active(): Promise<void> { if (!this.started) throw new ConversationError('worker_unavailable'); await this.deps.worker.assertActive(); }
  private async emit(r: BotRequest,outcome: ScheduledOutcome): Promise<void> { await this.deps.onOutcome?.(r,outcome); }
  private controls(r: BotRequest): ProviderControls {
    return { signal: this.deps.worker.signal,beforeSend: async () => {
      await this.active();
      const current = await this.deps.config.load(r.guildId);
      if (!current || !current.enabled || (r.source === 'automatic' ? !current.autoChannels.includes(r.channelId) : !current.directEnabled) || !await this.deps.history.canRead(r,this.deps.worker.signal)) throw new ProviderFailure('configuration','configuration_changed',{ notSent: true });
    } };
  }
  /** Caller receives a result to deliver later; this module never sends Discord messages. */
  async submitDirect(request: BotRequest,admitted: () => void = () => undefined): Promise<DirectOutcome> {
    const r = structuredClone(request);
    try {
      if (!this.accepting) throw new ConversationError('worker_stopped');
      await this.active();
      return await this.deps.direct.handleDirect(r,run => {
        const result = this.deps.queue.submit(r,async () => { await this.active(); return run(); }); admitted(); return result;
      },this.controls(r));
    } finally { admitted(); }
  }
  async observeMessage(request: BotRequest,now = this.now()): Promise<'counted' | 'eligible' | 'ignored'> {
    if (!this.accepting || !validContextRequest(request) || request.source === 'ask') return 'ignored';
    const r = structuredClone(request);
    try {
      await this.active();
      const validated = await contextOperation(async signal => {
        const settings = await this.deps.config.load(r.guildId);
        if (!settings || settings.guildId !== r.guildId || !settings.enabled || !await this.deps.history.canRead(r,signal)) return null;
        const human = await this.deps.history.fetchTrigger({ ...r,source: 'automatic' },signal);
        return humanTrigger(human,{ ...r,source: 'automatic' }) ? { settings,human } : null;
      },this.deps.worker.signal);
      if (!validated) return 'ignored';
      await this.active();
      const observed = await this.deps.repository.observe(r,validated.human,validated.settings.revision,now,this.deps.worker.token);
      if (observed.direct) {
        const direct = { ...r,source: validated.human.repliesToBot ? 'reply' as const : 'mention' as const };
        let admitted!: () => void; const admission = new Promise<void>(resolve => { admitted = resolve; });
        void this.submitDirect(direct,admitted).then(outcome => this.emit(direct,{ kind: 'direct',outcome })).catch(() => this.emit(direct,{ kind: 'skipped',reason: 'direct_failed' })).catch(() => undefined);
        await admission;
      } else if (observed.status === 'eligible') {
        const key = `${r.guildId}:${r.channelId}`;
        if (!this.queued.has(key)) {
          this.queued.add(key);
          const drop = (reason: string) => { this.queued.delete(key); void this.emit(r,{ kind: 'skipped',reason }).catch(() => undefined); };
          if (this.deps.queue.enqueue({ ...r,source: 'automatic' },async () => { try { await this.assess(r.guildId,r.channelId); } finally { this.queued.delete(key); } },drop) === 'full') drop('queue_full');
        }
      }
      return observed.status;
    } catch { return 'ignored'; }
  }
  private async assess(guildId: string,channelId: string): Promise<void> {
    await this.active(); const a = await this.deps.repository.begin(guildId,channelId,this.now(),this.deps.worker.token); if (!a) return;
    let succeeded = false;
    try {
      const settings = await this.deps.config.load(guildId);
      if (!settings || settings.revision !== a.revision || !settings.autoChannels.includes(channelId)) throw new ConversationError('configuration_changed');
      const context = await this.deps.context.buildAutomaticContext(a.request,settings,this.deps.worker.signal);
      if (context.status === 'skipped') { await this.emit(a.request,{ kind: 'skipped',reason: context.reason }); return; }
      const p = settings.providers.find(p => p.modelId !== null && /^[1-9]\d*$/.test(p.dailyAllowance));
      if (!p) throw new ConversationError('context_unavailable');
      const input: GenerationInput = { instructions: settings.instructions,context: context.context,mode: settings.autoPolicy === 'always' ? 'auto_always' : 'auto_conditional',modelId: p.modelId!,maxGenerationTokens: settings.maxGenerationTokens,...(p.effort !== null ? { effort: p.effort } : {}) };
      const result = await this.deps.provider.generateWithFallback(a.request,input,a.revision,this.controls(a.request));
      await this.active(); succeeded = await this.deps.repository.finish(a,true,this.now(),this.deps.worker.token);
      if (succeeded) await this.emit(a.request,{ kind: 'result',result });
    } catch (e) {
      await this.emit(a.request,{ kind: 'skipped',reason: e instanceof ProviderFailure ? e.safeCode : e instanceof ConversationError ? e.message : 'assessment_failed' });
    } finally {
      if (!succeeded && !this.deps.worker.signal.aborted) { await this.active(); await this.deps.repository.finish(a,false,this.now(),this.deps.worker.token); }
    }
  }
}
