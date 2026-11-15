import type { ProviderId,GenerationInput } from '../domain/types.js';
import type { ModelSupport } from '../settings/validation.js';
export const MODELS = [
  { provider: 'openai',id: 'gpt-5.4-mini-2026-03-17',efforts: ['none','low','medium','high','xhigh'],defaultEffort: 'low',inputLimit: 400000,outputLimit: 128000 },
  { provider: 'openai',id: 'gpt-6-luna',efforts: ['none','low','medium','high','xhigh','max'],defaultEffort: 'low',inputLimit: 1050000,maxInputTokens: 922000,outputLimit: 128000,minOutputTokens: 16 },
  { provider: 'google',id: 'gemini-3.5-flash-lite',efforts: ['minimal','low','medium','high'],defaultEffort: 'minimal',inputLimit: 1048576,outputLimit: 65536 },
] as const;
// inputLimit is the existing combined context ceiling. Some models additionally
// publish an independent maximum input and a minimum generation allowance.
export function fitsModelTokens(m: { inputLimit: number; outputLimit: number; maxInputTokens?: number; minOutputTokens?: number },input: number,generation: number): boolean {
  return Number.isSafeInteger(input) && input >= 0 && input <= (m.maxInputTokens ?? m.inputLimit) && Number.isSafeInteger(generation) && generation >= (m.minOutputTokens ?? 1) && generation <= m.outputLimit && input+generation <= m.inputLimit;
}
export const supportsModel: ModelSupport = s => {
  const m = MODELS.find(m => m.provider === s.provider && m.id === s.modelId);
  return !!m && (s.effort === null || (m.efforts as readonly string[]).includes(s.effort)) && s.contextTokenLimit > 0 && fitsModelTokens(m,s.contextTokenLimit,s.maxGenerationTokens);
};
export function model(provider: ProviderId,input: GenerationInput) {
  const m = MODELS.find(m => m.provider === provider && m.id === input.modelId);
  if (!m || !supportsModel({ provider,modelId: input.modelId,effort: input.effort ?? null,contextTokenLimit: 1,maxGenerationTokens: input.maxGenerationTokens })) throw new Error('unsupported_model');
  return m;
}
