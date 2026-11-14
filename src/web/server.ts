import Fastify,{ type FastifyInstance,type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { validContactUrl } from '../config.js';
import { resolve } from 'node:path';
import type { Database } from '../db/index.js';
import { AccessPolicy,SettingsError,isSnowflake } from '../access/policy.js';
import type { SettingsService } from '../settings/service.js';
import type { DashboardDirectory } from './directory.js';
import type { OAuth } from './oauth.js';
import { WebAuth,returnPath } from './auth.js';
import { routes } from './routes.js';
export interface WebDependencies {
  database: Database; access: AccessPolicy; settings: SettingsService; directory: DashboardDirectory; oauth: OAuth;
  origin: string; clientId: string; sessionSecret: Buffer; contactUrl?: string; now?: () => Date; assets?: string;
}
export interface WebIdentity { actor: string; token: string }
export async function createWebServer(d: WebDependencies): Promise<FastifyInstance> {
  const origin = new URL(d.origin),secure = origin.protocol === 'https:';
  if (origin.origin !== d.origin || origin.username || origin.password || (!secure && !['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) || !isSnowflake(d.clientId)) throw new Error('web_configuration');
  if (d.contactUrl !== undefined && !validContactUrl(d.contactUrl)) throw new Error('web_configuration');
  const app = Fastify({ logger: false,bodyLimit: 32768,trustProxy: false,requestTimeout: 15000 });
  const auth = new WebAuth(d.database,d.sessionSecret,d.now ?? (() => new Date())),sessionName = secure ? '__Host-gn_session' : 'gn_session',stateName = secure ? '__Host-gn_state' : 'gn_state';
  const options = { path: '/',httpOnly: true,sameSite: 'lax' as const,secure };
  await app.register(cookie); await app.register(rateLimit,{ global: true,max: 300,timeWindow: '1 minute',allowList: r => !r.url.startsWith('/api/') && !r.url.startsWith('/auth/') });
  app.addHook('onRequest',async (_r,reply) => { reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-content-type-options','nosniff').header('x-frame-options','DENY').header('content-security-policy',"default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); });
  app.setErrorHandler((e,_r,reply) => {
    const code = e instanceof SettingsError ? e.code : (e as { statusCode?: number }).statusCode === 429 ? 'rate_limited' : 'request_failed';
    reply.status(code === 'forbidden' ? 403 : code === 'revision_conflict' ? 409 : code === 'rate_limited' ? 429 : code === 'storage_failed' ? 503 : 400).send({ error: code });
  });
  const identity = async (r: FastifyRequest): Promise<WebIdentity | null> => { const token = r.cookies[sessionName]; const actor = await auth.identify(token); return actor && token ? { actor,token } : null; };
  app.get('/auth/discord',{ config: { rateLimit: { max: 20,timeWindow: '10 minutes' } } },async (r,reply) => {
    const state = await auth.begin(returnPath((r.query as { returnTo?: unknown }).returnTo)); reply.setCookie(stateName,state.browser,{ ...options,maxAge: 600 }); return reply.redirect(d.oauth.authorize(state.state));
  });
  app.get('/auth/discord/callback',{ config: { rateLimit: { max: 30,timeWindow: '10 minutes' } } },async (r,reply) => {
    const q = r.query as { state?: unknown; code?: unknown; iss?: unknown };
    if (q.iss !== 'https://discord.com') throw new Error('oauth_issuer');
    const path = await auth.consume(q.state,r.cookies[stateName]); reply.clearCookie(stateName,options);
    if (typeof q.code !== 'string' || !q.code || q.code.length > 2048) throw new Error('oauth_failed');
    const actor = await d.oauth.identify(q.code),token = await auth.create(actor,r.cookies[sessionName]);
    reply.setCookie(sessionName,token,{ ...options,maxAge: 43200 }); return reply.redirect(path);
  });
  app.get('/api/site',async () => ({ contactUrl: d.contactUrl ?? null,inviteUrl: `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: d.clientId,scope: 'bot applications.commands',permissions: '84992',integration_type: '0' })}` }));
  app.addHook('preHandler',async (r,reply) => {
    if (!r.url.startsWith('/api/') || r.url.split('?')[0] === '/api/site') return;
    const i = await identity(r); if (!i) return reply.status(401).send({ error: 'sign_in_required' });
    if (!['GET','HEAD'].includes(r.method) && (r.headers.origin !== d.origin || !auth.verifyCsrf(i.token,r.headers['x-csrf-token']))) return reply.status(403).send({ error: 'csrf_failed' });
  });
  app.get('/api/session',async r => { const i = (await identity(r))!; return { userId: i.actor,creator: i.actor === d.access.creatorId,csrf: auth.csrf(i.token) }; });
  app.post('/auth/logout',async (r,reply) => { const i = await identity(r); if (!i || r.headers.origin !== d.origin || !auth.verifyCsrf(i.token,r.headers['x-csrf-token'])) return reply.status(403).send({ error: 'csrf_failed' }); await auth.remove(i.token); reply.clearCookie(sessionName,options); return reply.status(204).send(); });
  await routes(app,d,async r => (await identity(r))!.actor);
  if (d.assets) {
    await app.register(staticFiles,{ root: resolve(d.assets),prefix: '/',index: false });
    for (const path of ['/','/privacy','/servers','/servers/:guildId','/creator']) app.get(path,(_r,reply) => reply.sendFile('index.html'));
  }
  return app;
}
