import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ClientOptions } from 'discord.js';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createDatabase } from '../db/index.js';
import { createDiscordApplication } from '../discord/application.js';
import { createDiscordClient,type RawGateway } from '../discord/client.js';
import { DiscordRest,type DiscordTransport } from '../discord/transport.js';
import { isSnowflake } from '../access/policy.js';
import { createWebServer } from '../web/server.js';
import { DiscordOAuth } from '../web/oauth.js';
import { DashboardDirectory } from '../web/directory.js';
import { Maintenance } from '../ops/cleanup.js';
import { RuntimeHealth,registerHealth } from '../ops/health.js';
import { safeLogger } from '../ops/logging.js';
import type { ProviderId } from '../domain/types.js';
import type { ProviderAdapter } from '../providers/common.js';
import { verifySchema } from './schema.js';
interface Dependencies {
  signal?: AbortSignal; transport?: DiscordTransport; gatewayFactory?: (o: ClientOptions) => RawGateway;
  providers?: ReadonlyMap<ProviderId,ProviderAdapter>; sink?: (line: string) => void;
  port?: number; host?: string; assets?: string; migrations?: string; graceMs?: number;
  onServer?: (s: FastifyInstance) => void; onFatal?: () => void;
}
async function within(work: Promise<unknown>,ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work.then(() => true),new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false),ms); })]); } finally { clearTimeout(timer); }
}
/** Production composition. DI is an in-process interface, never an environment test bypass. */
export async function startApplication(config: AppConfig,d: Dependencies = {}) {
  if (config.mode !== 'runtime' || !config.databaseUrl || !config.discordBotToken || !config.encryptionKey || !config.discordClientId || !config.discordClientSecret || !config.creatorUserId) throw new Error('runtime_configuration');
  const log = safeLogger(d.sink),db = createDatabase(config.databaseUrl),transport = d.transport ?? new DiscordRest(config.discordBotToken),starting = new AbortController();
  let conversation: ReturnType<typeof createDiscordApplication> | undefined,gateway: ReturnType<typeof createDiscordClient> | undefined,server: FastifyInstance | undefined;
  let maintenance: Maintenance | undefined,maintenanceWork = Promise.resolve(),interval: ReturnType<typeof setInterval> | undefined;
  let accepting = false,closing = false,reconcileRequested = false,reconciling = false,shutdown: Promise<void> | undefined;
  const ingress = new Set<Promise<void>>(),health = new RuntimeHealth(() => !!gateway?.ready(),async () => { await db.pool.query('SELECT 1'); await conversation!.guard.assertActive(); });
  const check = () => { if (starting.signal.aborted || d.signal?.aborted || closing) throw new Error('startup_cancelled'); };
  function tracked(run: () => Promise<void>): Promise<void> {
    if (!accepting || closing || !gateway?.ready()) return Promise.resolve();
    const work = Promise.resolve().then(run); ingress.add(work); void work.finally(() => ingress.delete(work)).catch(() => undefined); return work;
  }
  function requestReconcile(): void {
    if (closing || health.phase !== 'running') return; reconcileRequested = true; if (reconciling) return; reconciling = true;
    maintenanceWork = maintenanceWork.then(async () => { while (reconcileRequested && !closing) { reconcileRequested = false; await maintenance!.reconcile(); } }).catch(() => log('guild_reconcile_failed')).finally(() => { reconciling = false; });
  }
  function cleanup(): Promise<void> {
    if (shutdown) return shutdown;
    closing = true; accepting = false; if (health.phase !== 'failed') health.phase = 'stopping'; clearInterval(interval); log('runtime_stopping');
    shutdown = (async () => {
      let failed = false;
      const attempt = async (run: () => Promise<unknown>) => { try { await run(); } catch { failed = true; log('runtime_error'); } };
      await attempt(async () => { await gateway?.stop(); });
      await attempt(async () => {
        const drain = (async () => { await Promise.allSettled([...ingress]); await maintenanceWork; await conversation?.stop(); })();
        if (!await within(drain,d.graceMs ?? 90000)) { log('shutdown_forced'); await conversation?.guard.stop(); if (!await within(drain,20000)) throw new Error('shutdown_incomplete'); }
      });
      await attempt(async () => { if (server) { const closed = server.close(); if (!await within(closed,10000)) { server.server.closeAllConnections(); if (!await within(closed,2000)) throw new Error('http_shutdown'); } } });
      conversation?.handlers.stop(); await attempt(async () => { await conversation?.guard.stop(); }); await attempt(() => db.close());
      if (failed) { health.phase = 'failed'; log('runtime_failed'); throw new Error('runtime_shutdown_failed'); }
      health.phase = 'stopped'; log('runtime_stopped');
    })(); return shutdown;
  }
  async function stop(): Promise<void> { closing = true; accepting = false; if (health.phase !== 'failed') health.phase = 'stopping'; starting.abort(); await startup?.catch(() => undefined); await cleanup(); }
  const abort = () => { void stop().catch(() => { d.onFatal?.(); }); }; d.signal?.addEventListener('abort',abort,{ once: true });
  const startup = (async () => {
    log('runtime_starting');
    try {
      check(); await verifySchema(db,d.migrations ?? fileURLToPath(new URL('../../drizzle/',import.meta.url))); check();
      const identity = await transport.call({ method: 'GET',path: '/users/@me',signal: AbortSignal.any([starting.signal,AbortSignal.timeout(10000)]) }) as { id?: unknown; bot?: unknown };
      if (!isSnowflake(identity?.id) || identity.bot !== true) throw new Error('bot_identity'); check();
      conversation = createDiscordApplication({ database: db,botId: identity.id,creatorId: config.creatorUserId!,publicOrigin: config.publicOrigin,encryptionKey: config.encryptionKey!,keyVersion: config.encryptionKeyVersion,transport,...(d.providers ? { providers: d.providers } : {}),onDelivery: (_r,report) => log('delivery',report.state) });
      if (!await conversation.start()) throw new Error('worker_busy'); check();
      conversation.guard.signal.addEventListener('abort',() => { if (!closing) { health.phase = 'failed'; log('worker_lost'); d.onFatal?.(); void stop().catch(() => undefined); } },{ once: true });
      maintenance = new Maintenance(db,conversation.guard,transport); await maintenance.recoverUsage(); check();
      gateway = createDiscordClient({ handleMessage: r => tracked(() => conversation!.handlers.handleMessage(r)),handleInteraction: r => tracked(() => conversation!.handlers.handleInteraction(r)) },d.gatewayFactory,{ guildsChanged: requestReconcile });
      const get = (path: string,signal: AbortSignal) => transport.call({ method: 'GET',path,signal });
      server = await createWebServer({ database: db,access: conversation.access,settings: conversation.settings,directory: new DashboardDirectory(db,conversation.access,get),oauth: new DiscordOAuth(config.discordClientId!,config.discordClientSecret!,config.publicOrigin),origin: config.publicOrigin,clientId: config.discordClientId!,sessionSecret: createHmac('sha256',config.encryptionKey!).update('galaxy-web-session-csrf-v1').digest(),assets: d.assets ?? fileURLToPath(new URL('../dashboard/',import.meta.url)),...(config.contactUrl ? { contactUrl: config.contactUrl } : {}) });
      registerHealth(server,health); d.onServer?.(server); check(); await server.listen({ port: d.port ?? config.port,host: d.host ?? '0.0.0.0' }); check();
      await gateway.start(config.discordBotToken!,starting.signal); check(); if (gateway.identity() !== identity.id) throw new Error('bot_identity');
      await maintenance.reconcile(); check(); await maintenance.cleanup(); check();
      health.phase = 'running'; accepting = true; log('runtime_ready');
      interval = setInterval(() => { if (closing) return; maintenanceWork = maintenanceWork.then(async () => { if (!closing) await maintenance!.cleanup(); }).catch(() => log('maintenance_failed')); requestReconcile(); },86400000); interval.unref();
    } catch { if (!d.signal?.aborted) { health.phase = 'failed'; log('runtime_failed'); } await cleanup(); throw new Error('runtime_start_failed'); }
  })();
  try { await startup; } catch (e) { d.signal?.removeEventListener('abort',abort); throw e; }
  return { health,server: server!,conversation: conversation!,async stop() { await stop(); d.signal?.removeEventListener('abort',abort); } };
}
