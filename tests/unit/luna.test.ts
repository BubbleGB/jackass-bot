import { describe,it,expect } from 'vitest';
import { MODELS,supportsModel } from '../../src/providers/catalog.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { RESPONSE_SCHEMA } from '../../src/providers/common.js';
import type { GenerationInput } from '../../src/domain/types.js';
import type { HttpTransport } from '../../src/providers/http.js';
const modelId = 'gpt-6-luna',efforts = ['none','low','medium','high','xhigh','max'];
const input: GenerationInput = { modelId,instructions: 'Be kind.',context: [{ id: '1',authorId: '2',kind: 'human',text: 'Hello',timestamp: new Date('2026-11-15T00:00:00Z') }],mode: 'direct',maxGenerationTokens: 2048 };
const response = { status: 'completed',output: [{ type: 'message',content: [{ type: 'output_text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { input_tokens: 100,input_tokens_details: { cached_tokens: 40,cache_write_tokens: 20 },output_tokens: 30,output_tokens_details: { reasoning_tokens: 20 },total_tokens: 130 } };
const signal = () => new AbortController().signal;
describe('GPT-6 Luna through the existing OpenAI integration',() => {
  it('exposes exactly the supported efforts and Galaxy low default without replacing Mini',() => {
    expect(MODELS.find(m => m.id === modelId)).toMatchObject({ provider: 'openai',efforts,defaultEffort: 'low',inputLimit: 1050000,outputLimit: 128000,maxInputTokens: 922000 });
    for (const effort of [...efforts,null]) expect(supportsModel({ provider: 'openai',modelId,effort,contextTokenLimit: 8000,maxGenerationTokens: 2048 })).toBe(true);
    for (const effort of ['minimal','ultra','']) expect(supportsModel({ provider: 'openai',modelId,effort,contextTokenLimit: 8000,maxGenerationTokens: 2048 })).toBe(false);
    expect(supportsModel({ provider: 'openai',modelId: 'gpt-5.4-mini-2026-03-17',effort: 'high',contextTokenLimit: 8000,maxGenerationTokens: 2048 })).toBe(true);
  });
  it.each([[922000,128000,true],[922001,2048,false],[8000,128001,false],[8000,15,false],[8000,16,true]])('checks input %s and generation %s independently', (contextTokenLimit,maxGenerationTokens,expected) => {
    expect(supportsModel({ provider: 'openai',modelId,effort: null,contextTokenLimit: Number(contextTokenLimit),maxGenerationTokens: Number(maxGenerationTokens) })).toBe(expected);
  });
  it.each([undefined,...efforts])('uses identical counted/generation inputs with effort %s, strict schema and bounded output',async effort => {
    const calls: Parameters<HttpTransport>[0][] = [];
    const adapter = new OpenAIAdapter(async r => { calls.push(r); return { status: 200,headers: {},body: r.url.endsWith('/input_tokens') ? { input_tokens: 100 } : response }; });
    const request = { ...input,...(effort !== undefined ? { effort } : {}) };
    expect(await adapter.estimateUsage(request,'synthetic-key',signal())).toBe(2148);
    expect(await adapter.generate(request,'synthetic-key',signal())).toMatchObject({ kind: 'answer',usage: { inputTokens: 100,outputTokens: 30,reasoningTokens: 20,totalTokens: 130 } });
    const { store,stream,max_output_tokens,...counted } = calls[1]!.body;
    expect({ store,stream,max_output_tokens }).toEqual({ store: false,stream: false,max_output_tokens: 2048 }); expect(calls[0]!.body).toEqual(counted);
    expect(counted).toEqual({ model: modelId,instructions: expect.stringContaining('Be kind.'),input: [{ role: 'user',content: JSON.stringify(input.context) }],reasoning: { effort: effort ?? 'low' },tools: [],truncation: 'disabled',text: { format: { type: 'json_schema',name: 'bot_response',strict: true,schema: RESPONSE_SCHEMA } } });
    expect(JSON.stringify(calls.map(c => c.body))).not.toContain('synthetic-key');
  });
  it.each([[400001,true],[922000,true],[922001,false]])('uses Luna input limits for count %s rather than the Mini ceiling',async (count,accepted) => {
    const adapter = new OpenAIAdapter(async () => ({ status: 200,headers: {},body: { input_tokens: count } }));
    const result = adapter.estimateUsage(input,'synthetic-key',signal());
    if (accepted) expect(await result).toBe(Number(count)+2048); else await expect(result).rejects.toMatchObject({ safeCode: 'input_too_large',notSent: true });
  });
  it('still enforces the Mini context limit using the same counter',async () => {
    const adapter = new OpenAIAdapter(async () => ({ status: 200,headers: {},body: { input_tokens: 399000 } }));
    await expect(adapter.estimateUsage({ ...input,modelId: 'gpt-5.4-mini-2026-03-17' },'synthetic-key',signal())).rejects.toMatchObject({ safeCode: 'input_too_large' });
  });
});
