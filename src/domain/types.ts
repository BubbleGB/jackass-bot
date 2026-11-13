export type ProviderId = 'openai' | 'google';
export type AccessLevel = 'none' | 'delegate' | 'admin' | 'creator';
export type RequestSource = 'mention' | 'reply' | 'ask' | 'automatic';
export interface BotRequest {
  id: string; guildId: string; channelId: string; userId: string;
  source: RequestSource; prompt?: string; receivedAt: Date;
}
export interface ContextMessage {
  id: string; authorId: string; kind: 'human' | 'self'; text: string; timestamp: Date;
}
/** Reasoning is a breakdown; totalTokens must not count it twice. */
export interface NormalizedUsage {
  inputTokens: number; outputTokens: number; reasoningTokens: number;
  totalTokens: number; certainty: 'reported' | 'estimated';
}
export type GenerationResult =
  | { kind: 'answer'; text: string; usage: NormalizedUsage }
  | { kind: 'silence'; usage: NormalizedUsage }
  | { kind: 'refusal'; text: string; usage: NormalizedUsage };
export interface ProviderError {
  category: 'rate_limit' | 'quota' | 'auth' | 'configuration' | 'transient' | 'uncertain';
  retryAfterMs?: number; usage?: NormalizedUsage; safeCode: string;
}
export interface GenerationInput {
  instructions: string; context: ContextMessage[];
  mode: 'direct' | 'auto_always' | 'auto_conditional'; modelId: string;
  effort?: string; maxGenerationTokens: number;
}
