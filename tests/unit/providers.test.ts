import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GoogleAdapter } from '../../src/providers/google.js';
import { supportsModel } from '../../src/providers/catalog.js';
import type { HttpTransport } from '../../src/providers/http.js';
import type { GenerationInput } from '../../src/domain/types.js';
const input: GenerationInput = { instructions: 'Be kind.', context: [{ id: '1',authorId: '2',kind: 'human',text: 'Hi',timestamp: new Date('2026-11-13T00:00:00Z') }], mode: 'direct',modelId: 'gpt-5.4-mini-2026-03-17',effort: 'low',maxGenerationTokens: 2048 };
const signal = () => new AbortController().signal;
const openUsage = { input_tokens: 100,input_tokens_details: { cached_tokens: 40 },output_tokens: 30,output_tokens_details: { reasoning_tokens: 20 },total_tokens: 130 };
const googleUsage = { total_input_tokens: 100,total_cached_tokens: 40,total_output_tokens: 10,total_thought_tokens: 20,total_tool_use_tokens: 0,total_tokens: 130 };
const openResponse = (text = '{"kind":"answer","text":"Hello"}') => ({ status: 'completed',usage: openUsage,output: [{ type: 'message',content: [{ type: 'output_text',text }] }] });
const googleResponse = (text = '{"kind":"answer","text":"Hello"}') => ({ status: 'completed',usage: googleUsage,steps: [{ type: 'model_output',content: [{ type: 'text',text }] }] });
function transport(body: unknown, status = 200, headers: Record<string,string> = {}): HttpTransport { return async () => ({ body,status,headers }); }
describe('curated model contracts and provider fixtures', () => {
  it('accepts model-specific effort and rejects invented, deprecated or incompatible selections', () => {
    expect(supportsModel({ provider: 'openai',modelId: input.modelId,effort: 'xhigh',contextTokenLimit: 8000,maxGenerationTokens: 2048 })).toBe(true);
    expect(supportsModel({ provider: 'google',modelId: 'gemini-3.5-flash-lite',effort: 'minimal',contextTokenLimit: 8000,maxGenerationTokens: 2048 })).toBe(true);
    for (const [provider,modelId,effort] of [['openai','gpt-5-mini-2025-08-07','low'],['openai',input.modelId,'minimal'],['google','gemini-3.5-flash-lite','xhigh']] as const) expect(supportsModel({ provider,modelId,effort,contextTokenLimit: 8000,maxGenerationTokens: 2048 })).toBe(false);
  });
  it('normalizes cached input and reasoning without adding either twice', async () => {
    const a = await new OpenAIAdapter(transport(openResponse())).generate(input,'fake-key',signal());
    const b = await new GoogleAdapter(transport(googleResponse())).generate({ ...input,modelId: 'gemini-3.5-flash-lite' },'fake-key',signal());
    for (const result of [a,b]) expect(result).toEqual({ kind: 'answer',text: 'Hello',usage: { inputTokens: 100,outputTokens: 30,reasoningTokens: 20,totalTokens: 130,certainty: 'reported' } });
  });
  it('counts the exact OpenAI request including schema before reserving output', async () => {
    const calls: Parameters<HttpTransport>[0][] = [];
    const adapter = new OpenAIAdapter(async request => { calls.push(request); return { status: 200,headers: {},body: request.url.endsWith('/input_tokens') ? { input_tokens: 100 } : openResponse() }; });
    expect(await adapter.estimateUsage(input,'fake-key',signal())).toBe(2148);
    await adapter.generate(input,'fake-key',signal());
    expect(calls[0]?.body.text).toEqual(calls[1]?.body.text);
    expect(calls[0]?.body.input).toEqual(calls[1]?.body.input);
    expect(calls[1]?.body).toMatchObject({ store: false,tools: [],max_output_tokens: 2048,truncation: 'disabled' });
    expect(JSON.stringify(calls[1]?.body)).not.toContain('fake-key');
  });
  it('uses the documented conservative Google input ceiling without a mismatched count request', async () => {
    let calls = 0;
    const a = new GoogleAdapter(async () => { calls++; return { status: 200,headers: {},body: googleResponse() }; });
    expect(await a.estimateUsage({ ...input,modelId: 'gemini-3.5-flash-lite' },'fake-key',signal())).toBe(1048576+2048);
    expect(calls).toBe(0);
  });
  it('requires explicit structured silence, distinguishing empty transport output', async () => {
    expect((await new OpenAIAdapter(transport(openResponse('{"kind":"silence","text":""}'))).generate(input,'fake-key',signal())).kind).toBe('silence');
    await expect(new OpenAIAdapter(transport(openResponse(''))).generate(input,'fake-key',signal())).rejects.toMatchObject({ safeCode: 'invalid_output',usage: { totalTokens: 130 } });
    await expect(new GoogleAdapter(transport(googleResponse(''))).generate({ ...input,modelId: 'gemini-3.5-flash-lite' },'fake-key',signal())).rejects.toMatchObject({ safeCode: 'invalid_output',usage: { totalTokens: 130 } });
  });
  it('returns safety refusals even without usage and never treats unknown usage as free', async () => {
    const a = await new OpenAIAdapter(transport({ status: 'completed',output: [{ type: 'message',content: [{ type: 'refusal',refusal: 'private text' }] }] })).generate(input,'fake-key',signal());
    expect(a.kind).toBe('refusal'); expect(a.usage.certainty).toBe('estimated'); expect(JSON.stringify(a)).not.toContain('private text');
    const b = await new GoogleAdapter(transport({ status: 'failed',error: { code: 'content_filter',message: 'private text' } })).generate({ ...input,modelId: 'gemini-3.5-flash-lite' },'fake-key',signal());
    expect(b.kind).toBe('refusal');
  });
  it.each([true,false])('treats native OpenAI content filtering as terminal (reported usage=%s)', async withUsage => {
    const body = { status: 'incomplete',incomplete_details: { reason: 'content_filter' },output: [],...(withUsage ? { usage: openUsage } : {}) };
    const result = await new OpenAIAdapter(transport(body)).generate(input,'fake-key',signal());
    expect(result.kind).toBe('refusal'); expect(result.usage.certainty).toBe(withUsage ? 'reported' : 'estimated');
  });
  it('preserves verified usage on HTTP errors and retains malformed reported usage conservatively', async () => {
    await expect(new OpenAIAdapter(transport({ error: {},usage: openUsage },500)).generate(input,'fake-key',signal())).rejects.toMatchObject({ usage: { totalTokens: 130 } });
    await expect(new OpenAIAdapter(transport({ error: {},usage: { input_tokens: -1 } },429)).generate(input,'fake-key',signal())).rejects.toMatchObject({ notSent: false });
  });
  it('rejects missing, negative, doubled or inconsistent token reports conservatively', async () => {
    for (const usage of [undefined,{ ...openUsage,total_tokens: 150 },{ ...openUsage,input_tokens: -1 },{ ...openUsage,output_tokens_details: { reasoning_tokens: 31 } }]) {
      await expect(new OpenAIAdapter(transport({ ...openResponse(),usage })).generate(input,'fake-key',signal())).rejects.toMatchObject({ category: 'uncertain',safeCode: 'invalid_usage' });
    }
  });
  it('distinguishes Google temporary failures from unknown terminal rejections', async () => {
    const googleInput = { ...input,modelId: 'gemini-3.5-flash-lite' };
    await expect(new GoogleAdapter(transport({ status: 'failed',error: { code: 'internal_error' } },500)).generate(googleInput,'fake-key',signal())).rejects.toMatchObject({ category: 'transient' });
    await expect(new GoogleAdapter(transport({ status: 'failed',error: { code: 'unknown_rejection' } })).generate(googleInput,'fake-key',signal())).rejects.toMatchObject({ safeCode: 'provider_rejected' });
  });
  it('stops on unknown native OpenAI rejection states rather than assuming they are safe to retry', async () => {
    for (const body of [{ status: 'failed',error: { code: 'unknown_rejection' } },{ ...openResponse(),status: 'incomplete',incomplete_details: { reason: 'unknown_filter' } }]) {
      await expect(new OpenAIAdapter(transport(body)).generate(input,'fake-key',signal())).rejects.toMatchObject({ safeCode: 'provider_rejected' });
    }
  });
  it('respects Google RetryInfo and rejects inconsistent Google usage', async () => {
    const googleInput = { ...input,modelId: 'gemini-3.5-flash-lite' };
    await expect(new GoogleAdapter(transport({ error: { code: 429,details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo',retryDelay: '1200s' }] } },429)).generate(googleInput,'fake-key',signal())).rejects.toMatchObject({ retryAfterMs: 1200000,category: 'rate_limit' });
    await expect(new GoogleAdapter(transport({ ...googleResponse(),usage: { ...googleUsage,total_tokens: 170 } })).generate(googleInput,'fake-key',signal())).rejects.toMatchObject({ safeCode: 'invalid_usage' });
    await expect(new OpenAIAdapter(transport({ error: { code: 'unknown_policy_error',message: 'private conversation' } },400)).generate(input,'fake-key',signal())).rejects.toMatchObject({ safeCode: 'provider_rejected' });
  });
  it('classifies quota/rate limits and redacts response bodies and keys from errors', async () => {
    for (const [status,body,category] of [[429,{ error: { code: 'insufficient_quota',message: 'secret-key private chat' } },'quota'],[429,{ error: { message: 'secret-key private chat' } },'rate_limit'],[401,{ error: { message: 'secret-key' } },'auth']] as const) {
      try { await new OpenAIAdapter(transport(body,status,{ 'retry-after': '120' })).generate(input,'secret-key',signal()); throw new Error('expected failure'); }
      catch (error) { expect(error).toMatchObject({ category,retryAfterMs: 120000 }); expect(String(error)+JSON.stringify(error)).not.toMatch(/secret-key|private chat/); }
    }
  });
});
