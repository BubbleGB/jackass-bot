import type { GenerationInput,GenerationResult,NormalizedUsage } from '../domain/types.js';
import { payload,RESPONSE_SCHEMA,REFUSAL,UNKNOWN_USAGE,normalized,output,safety,type ProviderAdapter } from './common.js';
import { ProviderFailure,assertHttp,fetchTransport,record,send,tokens,type HttpTransport } from './http.js';
export class GoogleAdapter implements ProviderAdapter {
  readonly provider = 'google' as const;
  constructor(private readonly transport: HttpTransport = fetchTransport) {}
  async estimateUsage(input: GenerationInput,_credential: string,_signal: AbortSignal): Promise<number> {
    void _credential;
    if (_signal.aborted) throw new ProviderFailure('transient','cancelled_before_send',{ notSent: true });
    payload(this.provider,input);
    // No verified Interactions-aware schema counter. Reserve the entire documented
    // input ceiling instead of pretending a generateContent count is exact here.
    return 1048576+input.maxGenerationTokens;
  }
  async generate(input: GenerationInput,credential: string,signal: AbortSignal): Promise<GenerationResult> {
    const p = payload(this.provider,input);
    const r = await send(this.transport,{ url: 'https://generativelanguage.googleapis.com/v1beta/interactions',headers: { 'x-goog-api-key': credential },body: { model: input.modelId,input: p.context,system_instruction: p.instruction,store: false,stream: false,background: false,tools: [],generation_config: { thinking_level: p.effort,thinking_summaries: 'none',max_output_tokens: input.maxGenerationTokens },response_format: { type: 'text',mime_type: 'application/json',schema: RESPONSE_SCHEMA } },signal });
    const b = record(r.body),steps = Array.isArray(b.steps) ? b.steps.map(record) : [];
    // Explicit refusals are terminal. Unknown native rejections also stop fallback;
    // documented HTTP/availability failures retain ordinary bounded fallback.
    const refused = safety(b) || steps.some(s => s.type === 'refusal' || (Array.isArray(s.content) && s.content.some(c => record(c).type === 'refusal')));
    const failed = (usage?: NormalizedUsage): ProviderFailure => {
      const temporary = ['internal_error','server_error','internal','unavailable','deadline_exceeded'].includes(String(record(b.error).code ?? '').toLowerCase());
      return new ProviderFailure(temporary ? 'transient' : 'configuration',temporary ? 'provider_transient' : 'provider_rejected',usage ? { usage } : {});
    };
    let usage: NormalizedUsage;
    try { const u = record(b.usage); if (tokens(u.total_tool_use_tokens ?? 0) !== 0) throw new ProviderFailure('uncertain','unexpected_tools'); usage = normalized(u.total_input_tokens,u.total_output_tokens,u.total_thought_tokens ?? 0,u.total_tokens,u.total_cached_tokens ?? 0,false); }
    catch (error) { if (refused) return { kind: 'refusal',text: REFUSAL,usage: { ...UNKNOWN_USAGE } }; assertHttp(r); if (b.status === 'failed') throw failed(); throw error; }
    if (refused) return { kind: 'refusal',text: REFUSAL,usage };
    assertHttp(r,usage);
    if (b.status === 'failed') throw failed(usage);
    if (b.status !== 'completed' || steps.some(s => !['model_output','thought'].includes(String(s.type)))) throw new ProviderFailure('transient','incomplete_response',{ usage });
    const text = steps.filter(s => s.type === 'model_output').flatMap(s => Array.isArray(s.content) ? s.content.map(record) : []).filter(c => c.type === 'text').map(c => typeof c.text === 'string' ? c.text : '').join('');
    return output(text,usage);
  }
}
