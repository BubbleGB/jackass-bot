import { randomUUID } from 'node:crypto';
import type { CredentialCipher } from '../settings/credentials.js';
import type { InputCounter } from '../conversation/types.js';
import type { ProviderId } from '../domain/types.js';
import type { ProviderAdapter } from './common.js';
import type { ProviderRepository } from './store.js';
import { ProviderFailure } from './http.js';
/** Internal composition bridge: keys remain within providers. Counting is preflight
 * only; reservations and generation still belong exclusively to ProviderRouter.
 */
export class ProviderInputCounter {
  constructor(private readonly repository: ProviderRepository,private readonly cipher: Pick<CredentialCipher,'open'>,private readonly adapters: ReadonlyMap<ProviderId,ProviderAdapter>,private readonly now: () => Date = () => new Date()) {}
  readonly countInput: InputCounter = async (provider,input,signal,scope) => {
    if (signal.aborted) throw new ProviderFailure('transient','cancelled_before_send',{ notSent: true });
    const config = await this.repository.load(scope.guildId,this.now());
    if (config?.revision !== scope.revision || config.instructions !== input.instructions || config.maxGenerationTokens !== input.maxGenerationTokens) throw new ProviderFailure('configuration','configuration_changed',{ notSent: true });
    const c = config.candidates.find(c => c.provider === provider),adapter = this.adapters.get(provider);
    if (!c || c.blocked || c.retryAt > this.now().getTime() || !adapter) return null;
    if (c.modelId !== input.modelId || (c.effort ?? undefined) !== input.effort || !await this.repository.current(scope.guildId,config,c) || signal.aborted) throw new ProviderFailure('configuration','configuration_changed',{ notSent: true });
    try {
      let credential: string;
      try { credential = this.cipher.open(scope.guildId,provider,c); } catch { throw new ProviderFailure('configuration','credential_invalid',{ notSent: true }); }
      const estimate = await adapter.estimateUsage(input,credential,signal),count = estimate-input.maxGenerationTokens;
      if (!Number.isSafeInteger(count) || count < 0) throw new ProviderFailure('uncertain','invalid_usage');
      return count;
    } catch (raw) {
      const e = raw instanceof ProviderFailure ? raw : new ProviderFailure('uncertain','provider_error');
      if (['input_too_large','invalid_input','provider_rejected','configuration_changed'].includes(e.safeCode) || signal.aborted) throw e;
      await this.repository.failure(scope.guildId,c,e,this.now(),randomUUID());
      return null; // A different eligible model may still be sized/routed normally.
    }
  };
}
