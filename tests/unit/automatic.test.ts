import { describe,it,expect } from 'vitest';
import { AutomaticService } from '../../src/conversation/automatic.js';
import { ConversationQueue } from '../../src/conversation/queue.js';
import { ConversationError } from '../../src/conversation/types.js';
import { source,message,request,settings,instant } from '../helpers/conversation.js';
describe('worker admission races',() => {
  it('settles observation without direct generation if ownership disappears after the activity commit',async () => {
    const controller = new AbortController(); let directCalls = 0;
    const history = source(); history.fetchTrigger = async r => message(r.id,'Hi',{ mentionsBot: true });
    const service = new AutomaticService({
      repository: { async recover() {},async observe() { controller.abort(); return { status: 'counted' as const,direct: true }; },async begin() { return null; },async finish() { return false; } },
      worker: { token: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',signal: controller.signal,async start() { return true; },async stop() { controller.abort(); },async assertActive() { if (controller.signal.aborted) throw new ConversationError('worker_unavailable'); } },
      config: { async load() { return settings; } },history,queue: new ConversationQueue(() => instant),now: () => instant,
      context: { async buildAutomaticContext() { throw new Error('must not assess'); } },
      direct: { async handleDirect() { directCalls++; return { status: 'disabled' }; } },provider: { async generateWithFallback() { throw new Error('must not generate'); } },
    });
    expect(await service.start()).toBe(true);
    expect(await service.observeMessage(request)).toBe('counted'); expect(directCalls).toBe(0); await service.stop();
  });
});

describe('worker lifecycle transitions',() => {
  function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise,resolve }; }
  function fixture(recover: () => Promise<void>,generate: () => Promise<import('../../src/domain/types.js').GenerationResult>) {
    const controller = new AbortController(),queue = new ConversationQueue(() => instant),finishes: boolean[] = [];
    const service = new AutomaticService({
      repository: { recover,async observe() { return { status: 'eligible' as const,direct: false }; },async begin() { return { id: 'assessment',snapshot: 3n,revision: 1,request: { ...request,source: 'automatic' as const } }; },async finish(_a,success) { finishes.push(success); return true; } },
      worker: { token: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',signal: controller.signal,async start() { return true; },async stop() { controller.abort(); },async assertActive() { if (controller.signal.aborted) throw new ConversationError('worker_unavailable'); } },
      config: { async load() { return { ...settings,autoChannels: [request.channelId] }; } },history: source(),queue,now: () => instant,
      context: { async buildAutomaticContext() { return { status: 'ready' as const,context: [] }; } },direct: { async handleDirect() { return { status: 'disabled' as const }; } },provider: { generateWithFallback: generate },
    });
    return { service,queue,finishes,controller };
  }
  it('keeps ownership until active successful work records its snapshot during graceful shutdown',async () => {
    const begun = deferred(),release = deferred();
    const f = fixture(async () => undefined,async () => { begun.resolve(); await release.promise; return { kind: 'silence',usage: { inputTokens: 1,outputTokens: 0,reasoningTokens: 0,totalTokens: 1,certainty: 'reported' } }; });
    await f.service.start(); await f.service.observeMessage({ ...request,source: 'automatic' }); await begun.promise;
    const stopped = f.service.stop(); release.resolve(); await stopped;
    expect(f.finishes).toEqual([true]); expect(f.controller.signal.aborted).toBe(true);
  });
  it('waits for startup recovery before releasing ownership during overlapping stop',async () => {
    const entered = deferred(),release = deferred(); let stopped = false;
    const f = fixture(async () => { entered.resolve(); await release.promise; },async () => { throw new Error('must not generate'); });
    const started = f.service.start().catch(() => false); await entered.promise;
    const stopping = f.service.stop().then(() => { stopped = true; });
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(stopped).toBe(false); expect(f.controller.signal.aborted).toBe(false); }
    finally { release.resolve(); await started; await stopping; }
  });
});
