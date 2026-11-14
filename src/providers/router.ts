import { randomUUID } from 'node:crypto';
import type { BotRequest,GenerationInput,GenerationResult,ProviderId } from '../domain/types.js';
import { CredentialCipher } from '../settings/credentials.js';
import { UsageService } from '../usage/service.js';
import { UsageError } from '../usage/database.js';
import { isSnowflake } from '../access/policy.js';
import { ProviderFailure } from './http.js';
import type { ProviderAdapter } from './common.js';
import type { ProviderRepository } from './store.js';
async function bounded<T>(run: () => Promise<T>,signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ProviderFailure('transient','cancelled_before_send',{ notSent: true });
  let abort!: () => void;
  try {
    const cancelled = new Promise<never>((_resolve,reject) => { abort = () => reject(new ProviderFailure('uncertain','transport_uncertain')); signal.addEventListener('abort',abort,{ once: true }); });
    return await Promise.race([Promise.resolve().then(run),cancelled]);
  } finally { signal.removeEventListener('abort',abort); }
}
export class ProviderRouter {
  constructor(private readonly repository: ProviderRepository,private readonly usage: Pick<UsageService,'reserveUsage' | 'settleUsage'>,private readonly cipher: Pick<CredentialCipher,'open'>,private readonly adapters: ReadonlyMap<ProviderId,ProviderAdapter>,private readonly now: () => Date = () => new Date()) {}
  async generateWithFallback(request: BotRequest,input: GenerationInput,expectedRevision?: number): Promise<GenerationResult> {
    if (!isSnowflake(request.guildId) || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) throw new ProviderFailure('configuration','invalid_request',{ notSent: true });
    if (!await this.repository.claim(request.guildId,request.id)) throw new ProviderFailure('configuration','request_not_claimed',{ notSent: true });
    // Freeze caller-owned conversation data for count/generation consistency; never persist it.
    let uncertain = false;
    try {
      let immutable: GenerationInput;
      try { immutable = structuredClone(input); } catch { throw new ProviderFailure('configuration','invalid_input',{ notSent: true }); }
      const config = await this.repository.load(request.guildId,this.now());
      if (expectedRevision !== undefined && config?.revision !== expectedRevision) throw new ProviderFailure('configuration','configuration_changed',{ notSent: true });
      if (!config) throw new ProviderFailure('configuration','guild_disabled',{ notSent: true });
      // At most one pass over each provider, regardless of malformed injected config.
      const tried = new Set<ProviderId>();
      for (const candidate of config.candidates) {
        if (tried.has(candidate.provider)) continue; tried.add(candidate.provider);
        if (candidate.blocked || candidate.retryAt > this.now().getTime()) continue;
        const adapter = this.adapters.get(candidate.provider); if (!adapter) continue;
        const attemptId = randomUUID(),controller = new AbortController();
        const timer = setTimeout(() => controller.abort(),60000);
        let reservation: Awaited<ReturnType<UsageService['reserveUsage']>> = null;
        let generationStarted = false,receivedResult = false;
        let phase: 'prepare' | 'reserve' | 'generate' | 'bookkeeping' = 'prepare';
        try {
          if (!await this.repository.current(request.guildId,config,candidate)) throw new ProviderFailure('configuration','configuration_changed',{ notSent: true });
          let credential: string;
          try { credential = this.cipher.open(request.guildId,candidate.provider,candidate); } catch { throw new ProviderFailure('configuration','credential_invalid',{ notSent: true }); }
          const generation: GenerationInput = { ...immutable,instructions: config.instructions,mode: request.source === 'automatic' ? (config.autoPolicy === 'always' ? 'auto_always' : 'auto_conditional') : 'direct',modelId: candidate.modelId,maxGenerationTokens: config.maxGenerationTokens };
          if (candidate.effort !== null) generation.effort = candidate.effort; else delete generation.effort;
          const estimate = await bounded(() => adapter.estimateUsage(generation,credential,controller.signal),controller.signal);
          // Recheck the current full-input ceiling even if this provider was skipped
          // during context sizing and became eligible after backoff/funding recovery.
          if (!Number.isSafeInteger(estimate) || estimate < generation.maxGenerationTokens) throw new ProviderFailure('uncertain','invalid_usage',{ notSent: true });
          if (estimate-generation.maxGenerationTokens > config.contextTokenLimit) throw new ProviderFailure('configuration','input_too_large',{ notSent: true });
          phase = 'reserve';
          reservation = await this.usage.reserveUsage(request.guildId,candidate.provider,attemptId,estimate,this.now());
          if (!reservation) continue;
          phase = 'prepare';
          if (controller.signal.aborted || !await this.repository.current(request.guildId,config,candidate)) throw new ProviderFailure('configuration','configuration_changed',{ notSent: true });
          generationStarted = true; phase = 'generate';
          const result = await bounded(() => adapter.generate(generation,credential,controller.signal),controller.signal);
          receivedResult = true; phase = 'bookkeeping';
          if (result.usage.certainty === 'reported') await this.usage.settleUsage(reservation.id,result.usage,'known');
          else { uncertain = true; await this.usage.settleUsage(reservation.id,null,'uncertain'); }
          await this.repository.success(request.guildId,candidate);
          await this.repository.finish(request.guildId,request.id,uncertain ? 'uncertain' : 'completed');
          return result; // Refusal is terminal and never triggers fallback.
        } catch (raw) {
          if (receivedResult || phase === 'reserve' || raw instanceof UsageError) { uncertain = true; throw new ProviderFailure('uncertain','accounting_unavailable'); }
          const error = raw instanceof ProviderFailure ? raw : new ProviderFailure('uncertain','provider_error');
          if (reservation) {
            const outcome = error.usage?.certainty === 'reported' ? 'known' : !generationStarted || error.notSent ? 'not_sent' : 'uncertain';
            if (outcome === 'uncertain') uncertain = true;
            await this.usage.settleUsage(reservation.id,error.usage ?? null,outcome);
          }
          if (error.safeCode === 'configuration_changed') throw error;
          await this.repository.failure(request.guildId,candidate,error,this.now(),attemptId);
          if (error.safeCode === 'provider_rejected') throw error;
        } finally { clearTimeout(timer); controller.abort(); }
      }
      throw new ProviderFailure('quota','providers_unavailable');
    } catch (error) {
      await this.repository.finish(request.guildId,request.id,uncertain ? 'uncertain' : 'failed');
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure('uncertain','provider_error');
    }
  }
}
