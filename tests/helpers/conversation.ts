import type { BotRequest } from '../../src/domain/types.js';
import type { GuildSettings } from '../../src/settings/service.js';
import type { HistoryMessage,HistorySource } from '../../src/conversation/types.js';
export const guild = '111111111111111111', channel = '222222222222222222', user = '333333333333333333', bot = '444444444444444444';
export const instant = new Date('2026-11-14T12:00:00Z');
export const request: BotRequest = { id: '555555555555555555',guildId: guild,channelId: channel,userId: user,source: 'mention',receivedAt: instant };
export const settings: GuildSettings = { guildId: guild,revision: 1,instructions: 'Be kind.',enabled: true,directEnabled: true,humanContextLimit: 3,selfContextLimit: 1,contextTokenLimit: 8000,autoPolicy: 'conditional',autoGapSeconds: 60,autoThreshold: 30,answerTargetTokens: 400,maxGenerationTokens: 2048,autoChannels: [],providers: [{ provider: 'openai',modelId: 'gpt-5.4-mini-2026-03-17',effort: 'low',priority: 1,dailyAllowance: '5000',credentialConfigured: true }] };
export function message(id: string,content = id,extra: Partial<HistoryMessage> = {}): HistoryMessage {
  return { id,guildId: guild,channelId: channel,authorId: user,authorBot: false,webhookId: null,content,timestamp: instant,mentionsBot: true,repliesToBot: false,...extra };
}
export function source(messages: HistoryMessage[] = []): HistorySource {
  return { botId: bot,async canRead() { return true; },async fetchPage() { return { messages,before: null }; },async fetchTrigger() { return message(request.id,'hello'); } };
}
