import { OpenAIAdapter } from '../../src/providers/openai.js';
import { describe,expect,it,vi } from 'vitest';
import { ProviderRouter } from '../../src/providers/router.js';
import { ProviderFailure } from '../../src/providers/http.js';
import type { ProviderRepository,Candidate,RoutingConfig } from '../../src/providers/store.js';
import type { ProviderAdapter } from '../../src/providers/common.js';
import type { BotRequest,GenerationInput,GenerationResult,ProviderId } from '../../src/domain/types.js';
import type { Reservation } from '../../src/usage/service.js';
const request: BotRequest = { id: 'request_1',guildId: '111111111111111111',channelId: '222222222222222222',userId: '333333333333333333',source: 'ask',receivedAt: new Date() };
const input: GenerationInput = { instructions: 'untrusted caller instruction',context: [],mode: 'direct',modelId: 'ignored',maxGenerationTokens: 9999 };
const result: GenerationResult = { kind: 'answer',text: 'Hello',usage: { inputTokens: 10,outputTokens: 10,reasoningTokens: 5,totalTokens: 20,certainty: 'reported' } };
const candidate = (provider: ProviderId): Candidate => ({ provider,modelId: provider === 'openai' ? 'gpt-5.4-mini-2026-03-17' : 'gemini-3.5-flash-lite',effort: 'low',revision: 1,configurationKey: 'a'.repeat(64),ciphertext: Buffer.alloc(32),nonce: Buffer.alloc(12),keyVersion: 1,blocked: false,retryAt: 0,failures: 0 });
function fixture() {
  const config: RoutingConfig = { revision: 1,instructions: 'saved personality',contextTokenLimit: 8000,maxGenerationTokens: 2048,autoPolicy: 'conditional',candidates: [candidate('openai'),candidate('google')] };
  const claims = new Set<string>(),failures: string[] = [],settlements: string[] = [],calls: ProviderId[] = [];
  let current = true;
  const repository: ProviderRepository = {
    async claim(_g,id) { if (claims.has(id)) return false; claims.add(id); return true; },async finish() {},async load() { return config; },async current() { return current; },
    async failure(_g,c,e) { failures.push(`${c.provider}:${e.safeCode}`); },async success() {},
  };
  const usage = {
    async reserveUsage(guildId: string,provider: ProviderId,attemptId: string,estimate: number,now: Date): Promise<Reservation | null> { return { id: provider,guildId,provider,attemptId,amount: estimate,utcDate: now.toISOString().slice(0,10),state: 'reserved' }; },
    async settleUsage(id: string,_usage: unknown,state: string) { settlements.push(`${id}:${state}`); },
  };
  const adapters = new Map<ProviderId,ProviderAdapter>(['openai','google'].map(provider => [provider as ProviderId,{ provider: provider as ProviderId,async estimateUsage() { return 2058; },async generate(i: GenerationInput) { calls.push(provider as ProviderId); expect(i.instructions).toBe('saved personality'); expect(i.maxGenerationTokens).toBe(2048); return result; } }]));
  const router = () => new ProviderRouter(repository,usage,{ open() { return 'fake-key'; } },adapters);
  return { config,repository,usage,adapters,router,failures,settlements,calls,setCurrent(value: boolean) { current = value; } };
}
describe('bounded provider orchestration', () => {
  it('tries each eligible provider once, settling failed primary separately from fallback', async () => {
    const f = fixture(); f.config.candidates.push(candidate('openai'));
    f.adapters.get('openai')!.generate = async () => { f.calls.push('openai'); throw new ProviderFailure('rate_limit','provider_rate_limit',{ retryAfterMs: 120000,notSent: true }); };
    expect(await f.router().generateWithFallback(request,input)).toEqual(result);
    expect(f.calls).toEqual(['openai','google']); expect(f.settlements).toEqual(['openai:not_sent','google:known']);
  });
  it.each(['reported','estimated'] as const)('never falls back after safety refusal with %s usage', async certainty => {
    const f = fixture(); f.adapters.get('openai')!.generate = async () => ({ kind: 'refusal',text: 'Refused',usage: { ...result.usage,certainty } });
    expect((await f.router().generateWithFallback(request,input)).kind).toBe('refusal');
    expect(f.calls).toEqual([]); expect(f.settlements).toEqual([`openai:${certainty === 'reported' ? 'known' : 'uncertain'}`]);
  });
  it.each([true,false])('does not bypass a native content filter through fallback (usage=%s)', async withUsage => {
    const f = fixture();
    f.adapters.set('openai',new OpenAIAdapter(async r => ({ status: 200,headers: {},body: r.url.endsWith('/input_tokens') ? { input_tokens: 100 } : { status: 'incomplete',incomplete_details: { reason: 'content_filter' },output: [],...(withUsage ? { usage: { input_tokens: 100,output_tokens: 0,total_tokens: 100 } } : {}) } })));
    expect((await f.router().generateWithFallback(request,input)).kind).toBe('refusal');
    expect(f.calls).toEqual([]); expect(f.settlements).toEqual([`openai:${withUsage ? 'known' : 'uncertain'}`]);
  });
  it('keeps uncertain primary charges, bounds fallback and prevents duplicate replay', async () => {
    const f = fixture(); f.adapters.get('openai')!.generate = async () => { throw new Error('fake-key private conversation'); };
    await f.router().generateWithFallback(request,input);
    expect(f.settlements).toEqual(['openai:uncertain','google:known']); expect(f.failures).toEqual(['openai:provider_error']);
    await expect(f.router().generateWithFallback(request,input)).rejects.toMatchObject({ safeCode: 'request_not_claimed' });
  });
  it('skips backoff/permanent faults and local allowance exhaustion without generation', async () => {
    const f = fixture(); f.config.candidates[0]!.retryAt = Date.now()+60000;
    f.usage.reserveUsage = async () => null;
    await expect(f.router().generateWithFallback(request,input)).rejects.toMatchObject({ safeCode: 'providers_unavailable' });
    expect(f.calls).toEqual([]);
    f.config.candidates.forEach(c => { c.blocked = true; });
    await expect(f.router().generateWithFallback({ ...request,id: 'request_2' },input)).rejects.toThrow('providers_unavailable');
    expect(f.calls).toEqual([]);
  });
  it('rechecks configuration after reservation and frees a provably unsent attempt', async () => {
    const f = fixture(), reserve = f.usage.reserveUsage;
    f.usage.reserveUsage = async (...args) => { const r = await reserve(...args); f.setCurrent(false); return r; };
    await expect(f.router().generateWithFallback(request,input)).rejects.toThrow('configuration_changed');
    expect(f.calls).toEqual([]); expect(f.settlements).toEqual(['openai:not_sent']);
  });
  it('does not regenerate after accounting storage fails for an already received answer', async () => {
    const f = fixture(); let fails = true;
    f.usage.settleUsage = async () => { if (fails) { fails = false; throw new Error('database private detail'); } };
    await expect(f.router().generateWithFallback(request,input)).rejects.toThrow();
    expect(f.calls).toEqual(['openai']);
  });
  it('rejects a stale context/settings revision before any provider count or generation',async () => {
    const f = fixture(); let counted = 0;
    for (const a of f.adapters.values()) a.estimateUsage = async () => { counted++; return 50; };
    await expect(f.router().generateWithFallback(request,input,2)).rejects.toThrow('configuration_changed');
    expect(counted).toBe(0); expect(f.calls).toEqual([]);
  });
  it('does not label a request as pre-generation input rejection after a primary was already sent',async () => {
    const f = fixture();
    f.adapters.get('openai')!.generate = async () => { throw new ProviderFailure('uncertain','transport_uncertain'); };
    f.adapters.get('google')!.estimateUsage = async () => 10049;
    await expect(f.router().generateWithFallback(request,input)).rejects.toThrow('providers_unavailable');
    expect(f.settlements).toEqual(['openai:uncertain']);
  });
  it('bounds an uncooperative generation to 60 seconds and keeps its reservation', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.adapters.get('openai')!.generate = async () => new Promise(() => undefined);
      const answer = f.router().generateWithFallback(request,input);
      await vi.advanceTimersByTimeAsync(60000);
      expect(await answer).toEqual(result); expect(f.settlements).toEqual(['openai:uncertain','google:known']);
    } finally { vi.useRealTimers(); }
  });
});
