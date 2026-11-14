import type { Database } from '../db/index.js';
import type { ProviderId,BotRequest } from '../domain/types.js';
import type { ProviderAdapter } from '../providers/common.js';
import { OpenAIAdapter } from '../providers/openai.js';
import { GoogleAdapter } from '../providers/google.js';
import { ProviderRouter } from '../providers/router.js';
import { ProviderInputCounter } from '../providers/context-counter.js';
import { PostgresProviderRepository } from '../providers/store.js';
import { UsageService } from '../usage/service.js';
import { AccessPolicy } from '../access/policy.js';
import { DiscordMembership } from '../access/discord-membership.js';
import { SettingsService,accessRepository } from '../settings/service.js';
import { CredentialCipher } from '../settings/credentials.js';
import { ContextBuilder } from '../conversation/context.js';
import { DirectEligibility } from '../conversation/eligibility.js';
import { DirectService } from '../conversation/direct.js';
import { DiscordContextSource } from '../conversation/discord.js';
import { PostgresConversationConfigRepository } from '../conversation/config.js';
import { AutomaticRepository } from '../conversation/receipts.js';
import { PostgresWorkerGuard } from '../conversation/worker.js';
import { AutomaticService } from '../conversation/automatic.js';
import { ConversationQueue } from '../conversation/queue.js';
import type { DiscordTransport } from './transport.js';
import { DiscordDelivery,type DeliveryReport } from './delivery.js';
import { DiscordHandlers } from './events.js';
interface Options {
  database: Database; botId: string; creatorId: string; publicOrigin: string; encryptionKey: Buffer; keyVersion: number; transport: DiscordTransport;
  onDelivery?: (request: BotRequest,report: DeliveryReport) => void;
  providers?: ReadonlyMap<ProviderId,ProviderAdapter>; now?: () => Date; delay?: (ms: number,signal: AbortSignal) => Promise<void>;
}
/** Constructs lazy services only. Call start explicitly; the foundation program does not. */
export function createDiscordApplication(o: Options) {
  const now = o.now ?? (() => new Date()),get = (path: string,signal: AbortSignal) => o.transport.call({ method: 'GET',path,signal });
  const membership = new DiscordMembership(get,o.botId),access = new AccessPolicy(o.creatorId,membership,accessRepository(o.database.pool));
  const cipher = new CredentialCipher(o.keyVersion,new Map([[o.keyVersion,o.encryptionKey]])),settings = new SettingsService(o.database,access,cipher);
  const config = new PostgresConversationConfigRepository(o.database),history = new DiscordContextSource(get,o.botId,now),providerRepository = new PostgresProviderRepository(o.database);
  const providers = o.providers ?? new Map<ProviderId,ProviderAdapter>([['openai',new OpenAIAdapter()],['google',new GoogleAdapter()]]);
  const router = new ProviderRouter(providerRepository,new UsageService(o.database),cipher,providers,now),counter = new ProviderInputCounter(providerRepository,cipher,providers,now),context = new ContextBuilder(history,counter.countInput);
  const direct = new DirectService(new DirectEligibility(config,history,now),config,history,context,router),guard = new PostgresWorkerGuard(o.database),queue = new ConversationQueue(now);
  const canDeliver = async (r: Parameters<DiscordDelivery['deliverAnswer']>[0],signal: AbortSignal) => {
    try {
      const joined = AbortSignal.any([signal,guard.signal]);
      await guard.assertActive(); const s = await config.load(r.guildId);
      if (!s || !s.enabled || !(r.source === 'automatic' ? s.autoChannels.includes(r.channelId) : s.directEnabled) || joined.aborted || !await history.canRead(r,joined)) return false;
      await guard.assertActive(); return !joined.aborted;
    } catch { return false; }
  };
  const worker: AutomaticService = new AutomaticService({ repository: new AutomaticRepository(o.database),config,history,context,direct,provider: router,queue,worker: guard,now,onOutcome: (r,result) => handlers.handleOutcome(r,result),onBegin: r => handlers.beginTyping(r),onEnd: r => handlers.endTyping(r) });
  const handlers: DiscordHandlers = new DiscordHandlers({ transport: o.transport,worker,access,status: settings,publicOrigin: o.publicOrigin,canDeliver,now,...(o.onDelivery ? { onDelivery: o.onDelivery } : {}),delivery: new DiscordDelivery(o.transport,canDeliver,{ signal: guard.signal,...(o.delay ? { delay: o.delay } : {}) }) });
  return { handlers,worker,queue,guard,access,settings,start: () => worker.start(),async stop() { await worker.stop(); handlers.stop(); } };
}
