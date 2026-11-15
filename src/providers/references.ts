import type { GenerationInput } from '../domain/types.js';
import type { KnowledgeSource } from '../knowledge/types.js';
import { ProviderFailure } from './http.js';
/** A stale/unverifiable reference is local to this request, never a provider fault. */
export async function requireCurrentReferences(source: Pick<KnowledgeSource,'current'> | undefined,guildId: string,input: GenerationInput,signal: AbortSignal): Promise<void> {
  if (!input.knowledge?.length) return;
  try { if (!source || signal.aborted || !await source.current(guildId,input.knowledge,signal) || signal.aborted) throw new Error(); }
  catch { throw new ProviderFailure('configuration','configuration_changed',{ notSent: true }); }
}
