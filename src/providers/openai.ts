import type { GenerationInput,GenerationResult,NormalizedUsage } from '../domain/types.js';
import { payload,RESPONSE_SCHEMA,REFUSAL,UNKNOWN_USAGE,normalized,output,safety,type ProviderAdapter } from './common.js';
import { ProviderFailure,assertHttp,fetchTransport,record,send,tokens,type HttpTransport } from './http.js';
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;
  constructor(private readonly transport: HttpTransport = fetchTransport) {}
  private body(input: GenerationInput): Record<string,unknown> {
    const p = payload(this.provider,input);
    return { model: input.modelId,instructions: p.instruction,input: [{ role: 'user',content: p.context }],reasoning: { effort: p.effort },tools: [],truncation: 'disabled',text: { format: { type: 'json_schema',name: 'bot_response',strict: true,schema: RESPONSE_SCHEMA } } };
  }
  async estimateUsage(input: GenerationInput,credential: string,signal: AbortSignal): Promise<number> {
    const r = await send(this.transport,{ url: 'https://api.openai.com/v1/responses/input_tokens',headers: { authorization: `Bearer ${credential}` },body: this.body(input),signal });
    assertHttp(r); const count = tokens(record(r.body).input_tokens);
    if (count+input.maxGenerationTokens > 400000) throw new ProviderFailure('configuration','input_too_large',{ notSent: true });
    return count+input.maxGenerationTokens;
  }
  async generate(input: GenerationInput,credential: string,signal: AbortSignal): Promise<GenerationResult> {
    const r = await send(this.transport,{ url: 'https://api.openai.com/v1/responses',headers: { authorization: `Bearer ${credential}` },body: { ...this.body(input),store: false,stream: false,max_output_tokens: input.maxGenerationTokens },signal });
    const b = record(r.body),items = Array.isArray(b.output) ? b.output.map(record) : [];
    const contents = items.flatMap(i => Array.isArray(i.content) ? i.content.map(record) : []);
    const refused = safety(b) || contents.some(c => c.type === 'refusal');
    const nativeRejected = b.status === 'failed' || (b.status === 'incomplete' && record(b.incomplete_details).reason !== 'max_output_tokens');
    const failed = (usage?: NormalizedUsage): ProviderFailure => {
      const temporary = ['server_error','internal_error'].includes(String(record(b.error).code ?? ''));
      return new ProviderFailure(temporary ? 'transient' : 'configuration',temporary ? 'provider_transient' : 'provider_rejected',usage ? { usage } : {});
    };
    let usage: NormalizedUsage;
    try { const u = record(b.usage); usage = normalized(u.input_tokens,u.output_tokens,record(u.output_tokens_details).reasoning_tokens ?? 0,u.total_tokens,record(u.input_tokens_details).cached_tokens ?? 0,true); }
    catch (error) { if (refused) return { kind: 'refusal',text: REFUSAL,usage: { ...UNKNOWN_USAGE } }; assertHttp(r); if (nativeRejected) throw failed(); throw error; }
    if (refused) return { kind: 'refusal',text: REFUSAL,usage };
    assertHttp(r,usage);
    if (nativeRejected) throw failed(usage);
    if (b.status !== 'completed' || items.some(i => !['message','reasoning'].includes(String(i.type)))) throw new ProviderFailure('transient','incomplete_response',{ usage });
    return output(contents.filter(c => c.type === 'output_text').map(c => typeof c.text === 'string' ? c.text : '').join(''),usage);
  }
}
