import type { ProviderId,GenerationInput } from '../domain/types.js';
import type { ModelSupport } from '../settings/validation.js';
export const MODELS = [
  { provider: 'openai',id: 'gpt-5.4-mini-2026-03-17',efforts: ['none','low','medium','high','xhigh'],defaultEffort: 'low',inputLimit: 400000,outputLimit: 128000 },
  { provider: 'google',id: 'gemini-3.5-flash-lite',efforts: ['minimal','low','medium','high'],defaultEffort: 'minimal',inputLimit: 1048576,outputLimit: 65536 },
] as const;
export const supportsModel: ModelSupport = s => {
  const m = MODELS.find(m => m.provider === s.provider && m.id === s.modelId);
  return !!m && (s.effort === null || (m.efforts as readonly string[]).includes(s.effort)) && Number.isSafeInteger(s.contextTokenLimit) && s.contextTokenLimit > 0 && Number.isSafeInteger(s.maxGenerationTokens) && s.maxGenerationTokens > 0 && s.maxGenerationTokens <= m.outputLimit && s.contextTokenLimit+s.maxGenerationTokens <= m.inputLimit;
};
export function model(provider: ProviderId,input: GenerationInput) {
  const m = MODELS.find(m => m.provider === provider && m.id === input.modelId);
  if (!m || !supportsModel({ provider,modelId: input.modelId,effort: input.effort ?? null,contextTokenLimit: 1,maxGenerationTokens: input.maxGenerationTokens })) throw new Error('unsupported_model');
  return m;
}
