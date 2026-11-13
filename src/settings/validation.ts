import type { MembershipRepository } from '../access/discord-membership.js';
import { SettingsError, isSnowflake } from '../access/policy.js';
import type { ProviderId } from '../domain/types.js';
export interface ProviderPatch { provider: ProviderId; modelId?: string | null; effort?: string | null; priority?: number; dailyAllowance?: string }
export interface SettingsPatch {
  instructions?: string; enabled?: boolean; directEnabled?: boolean; humanContextLimit?: number; selfContextLimit?: number;
  contextTokenLimit?: number; autoPolicy?: 'conditional' | 'always'; autoGapSeconds?: number; autoThreshold?: number;
  answerTargetTokens?: number; maxGenerationTokens?: number; autoChannels?: string[]; providers?: ProviderPatch[];
}
export interface ProviderSettings {
  provider: ProviderId; modelId: string | null; effort: string | null; priority: number;
  dailyAllowance: string; credentialConfigured: true;
}
export interface GuildSettings {
  guildId: string; revision: number; instructions: string; enabled: boolean; directEnabled: boolean;
  humanContextLimit: number; selfContextLimit: number; contextTokenLimit: number; autoPolicy: 'conditional' | 'always';
  autoGapSeconds: number; autoThreshold: number; answerTargetTokens: number; maxGenerationTokens: number;
  autoChannels: string[]; providers: ProviderSettings[];
}
export interface ModelSelection { provider: ProviderId; modelId: string; effort: string | null; contextTokenLimit: number; maxGenerationTokens: number }
/** Task 3 supplies an authoritative curated catalog. Absence of it fails closed. */
export type ModelSupport = (selection: ModelSelection) => boolean;
export const bounds = {
  humanContextLimit: [0, 100], selfContextLimit: [0, 20], contextTokenLimit: [1, 32000],
  autoGapSeconds: [5, 3600], autoThreshold: [1, 10000], answerTargetTokens: [1, 32000], maxGenerationTokens: [1, 32000],
} as const;
const bad = (): never => { throw new SettingsError('invalid_settings'); };
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  return value as Record<string, unknown>;
}
export function validateProvider(provider: unknown): asserts provider is ProviderId { if (provider !== 'openai' && provider !== 'google') bad(); }
export function validatePatch(value: unknown): SettingsPatch {
  const patch = object(value);
  const allowed = new Set(['instructions', 'enabled', 'directEnabled', 'autoPolicy', 'autoChannels', 'providers', ...Object.keys(bounds)]);
  for (const [key, item] of Object.entries(patch)) {
    if (!allowed.has(key)) bad();
    if (key in bounds) {
      const [min, max] = bounds[key as keyof typeof bounds];
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < min || item > max) bad();
    }
    if (key === 'instructions' && (typeof item !== 'string' || item.length > 8000)) bad();
    if (['enabled', 'directEnabled'].includes(key) && typeof item !== 'boolean') bad();
    if (key === 'autoPolicy' && item !== 'always' && item !== 'conditional') bad();
    if (key === 'autoChannels' && (!Array.isArray(item) || item.length > 500 || !item.every(isSnowflake) || new Set(item).size !== item.length)) bad();
    if (key === 'providers') {
      if (!Array.isArray(item) || item.length < 1 || item.length > 2) bad();
      const seen = new Set<string>();
      for (const input of item as unknown[]) {
        const p = object(input); validateProvider(p.provider);
        if (seen.has(p.provider)) bad(); seen.add(p.provider);
        for (const [field, v] of Object.entries(p)) {
          if (!['provider', 'modelId', 'effort', 'priority', 'dailyAllowance'].includes(field)) bad();
          if (field === 'modelId' && v !== null && (typeof v !== 'string' || !v.trim() || v.length > 200)) bad();
          if (field === 'effort' && v !== null && (typeof v !== 'string' || !v.trim() || v.length > 64)) bad();
          if (field === 'priority' && v !== 1 && v !== 2) bad();
          if (field === 'dailyAllowance' && (typeof v !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(v) || BigInt(v) > 9223372036854775807n)) bad();
        }
      }
    }
  }
  return patch as SettingsPatch;
}

/** Validate only newly added IDs before taking a guild transaction lock.
 * Bound the whole operation, including transports that ignore cancellation.
 */
export async function validateNewChannels(guildId: string, ids: readonly string[], membership: MembershipRepository): Promise<void> {
  if (!ids.length) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  try {
    const timeout = new Promise<never>((_resolve,reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SettingsError('invalid_settings')); },5000);
    });
    const worker = async () => {
      while (!controller.signal.aborted) {
        const id = ids[index++];
        if (id === undefined) return;
        if (!await membership.isTextChannel(guildId,id,controller.signal)) throw new SettingsError('invalid_settings');
      }
    };
    await Promise.race([Promise.all(Array.from({ length: Math.min(4,ids.length) },worker)),timeout]);
  } catch { throw new SettingsError('invalid_settings'); }
  finally { clearTimeout(timer); controller.abort(); }
}
