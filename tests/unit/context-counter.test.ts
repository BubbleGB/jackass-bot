import { describe,it,expect } from 'vitest';
import { ProviderInputCounter } from '../../src/providers/context-counter.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GoogleAdapter } from '../../src/providers/google.js';
import type { ProviderRepository,Candidate,RoutingConfig } from '../../src/providers/store.js';
import type { GenerationInput,ProviderId } from '../../src/domain/types.js';
import type { ProviderAdapter } from '../../src/providers/common.js';
import { ProviderFailure } from '../../src/providers/http.js';
import { settings,guild } from '../helpers/conversation.js';
function fixture() {
  const candidates: Candidate[] = ['openai','google'].map(p => ({ provider: p as ProviderId,modelId: p === 'openai' ? 'gpt-5.4-mini-2026-03-17' : 'gemini-3.5-flash-lite',effort: 'low',revision: 1,configurationKey: 'a'.repeat(64),blocked: false,retryAt: 0,failures: 0,ciphertext: Buffer.alloc(32),nonce: Buffer.alloc(12),keyVersion: 1 }));
  const config: RoutingConfig = { revision: 1,instructions: 'Be kind.',contextTokenLimit: 8000,maxGenerationTokens: 2048,autoPolicy: 'conditional',candidates };
  const failures: string[] = [],calls: string[] = [];
  const repository: ProviderRepository = { async claim() { return true; },async finish() {},async load() { return config; },async current() { return true; },async failure(_g,_c,e) { failures.push(e.safeCode); },async success() {} };
  const adapters = new Map<ProviderId,ProviderAdapter>([
    ['openai',new OpenAIAdapter(async r => { calls.push(r.url); expect(r.body.instructions).toContain('Be kind.'); expect(r.body.text).toBeDefined(); return { status: 200,headers: {},body: { input_tokens: 120 } }; })],
    ['google',new GoogleAdapter(async r => { calls.push(r.url); expect(r.body.generateContentRequest).toBeDefined(); return { status: 200,headers: {},body: { totalTokens: 120 } }; })],
  ]);
  const counter = new ProviderInputCounter(repository,{ open() { return 'fake-key'; } },adapters);
  const input: GenerationInput = { instructions: settings.instructions,context: [],mode: 'direct',modelId: 'gpt-5.4-mini-2026-03-17',effort: 'low',maxGenerationTokens: 2048 };
  return { counter,input,repository,config,adapters,failures,calls };
}
describe('complete provider count bridge without generation',() => {
  it('uses native request counters and subtracts generation exactly once, retaining Google margin',async () => {
    const f = fixture(),scope = { guildId: guild,revision: 1 },signal = new AbortController().signal;
    expect(await f.counter.countInput('openai',f.input,signal,scope)).toBe(120);
    expect(await f.counter.countInput('google',{ ...f.input,modelId: 'gemini-3.5-flash-lite' },signal,scope)).toBe(152);
    expect(f.calls).toHaveLength(2); expect(f.calls.every(c => c.endsWith('/input_tokens') || c.endsWith(':countTokens'))).toBe(true);
  });
  it('rejects stale instructions/revisions rather than sizing a different request',async () => {
    const f = fixture(),signal = new AbortController().signal;
    await expect(f.counter.countInput('openai',f.input,signal,{ guildId: guild,revision: 2 })).rejects.toThrow('configuration_changed');
    await expect(f.counter.countInput('openai',{ ...f.input,instructions: 'stale' },signal,{ guildId: guild,revision: 1 })).rejects.toThrow('configuration_changed');
    expect(f.calls).toEqual([]);
  });
  it('skips exhausted/backed-off providers and records a failed count so healthy fallback remains countable',async () => {
    const f = fixture(),signal = new AbortController().signal,scope = { guildId: guild,revision: 1 };
    f.config.candidates[0]!.blocked = true;
    expect(await f.counter.countInput('openai',f.input,signal,scope)).toBeNull();
    f.config.candidates[0]!.blocked = false;
    f.adapters.get('openai')!.estimateUsage = async () => { throw new ProviderFailure('auth','provider_auth'); };
    expect(await f.counter.countInput('openai',f.input,signal,scope)).toBeNull(); expect(f.failures).toEqual(['provider_auth']);
    expect(await f.counter.countInput('google',{ ...f.input,modelId: 'gemini-3.5-flash-lite' },signal,scope)).toBe(152);
  });
});
