import type { GuildSettings,SettingsPatch } from '../../src/settings/validation.js';
export type { GuildSettings };
export function settingsPatch(base: GuildSettings,draft: GuildSettings): SettingsPatch {
  const patch: Record<string,unknown> = {};
  for (const key of ['instructions','enabled','directEnabled','humanContextLimit','selfContextLimit','contextTokenLimit','knowledgeTokenLimit','autoPolicy','autoGapSeconds','autoThreshold','answerTargetTokens','maxGenerationTokens','autoChannels'] as const) if (JSON.stringify(base[key]) !== JSON.stringify(draft[key])) patch[key] = draft[key];
  const providers = draft.providers.map(p => { const old = base.providers.find(b => b.provider === p.provider); const changes: Record<string,unknown> = { provider: p.provider }; for (const key of ['modelId','effort','priority','dailyAllowance'] as const) if (p[key] !== old?.[key]) changes[key] = p[key]; return changes; }).filter(p => Object.keys(p).length > 1);
  if (providers.length) patch.providers = providers; return patch as SettingsPatch;
}
export function rebase(latest: GuildSettings,patch: SettingsPatch): GuildSettings {
  if (patch.providers?.some(change => !latest.providers.some(p => p.provider === change.provider))) throw new Error('provider_removed');
  return { ...latest,...patch,providers: latest.providers.map(p => ({ ...p,...patch.providers?.find(c => c.provider === p.provider) })) };
}
