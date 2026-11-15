import type { FastifyInstance,FastifyRequest } from 'fastify';
import { SettingsError } from '../access/policy.js';
import { object,validateProvider,type SettingsPatch } from '../settings/validation.js';
import { MODELS } from '../providers/catalog.js';
import type { WebDependencies } from './server.js';
const fields = (value: unknown,allowed: readonly string[]) => { const b = object(value); if (Object.keys(b).some(k => !allowed.includes(k))) throw new SettingsError('invalid_settings'); return b; };
export async function routes(app: FastifyInstance,d: WebDependencies,actor: (r: FastifyRequest) => Promise<string>) {
  const guild = (r: FastifyRequest) => (r.params as { guildId: string }).guildId;
  app.get('/api/servers',async r => d.directory.servers(await actor(r),(r.query as { after?: string }).after));
  app.get('/api/guilds/:guildId/settings',async r => ({ ...await d.settings.getSettingsWithAccess(await actor(r),guild(r)),models: MODELS }));
  app.patch('/api/guilds/:guildId/settings',async r => { const b = fields(r.body,['revision','patch']); return { settings: await d.settings.updateSettings(await actor(r),guild(r),b.patch as SettingsPatch,b.revision as number) }; });
  app.get('/api/guilds/:guildId/channels',async r => ({ channels: await d.directory.channels(await actor(r),guild(r)) }));
  app.get('/api/guilds/:guildId/status',async r => d.settings.getUsageStatus(await actor(r),guild(r),(d.now ?? (() => new Date()))()));
  app.get('/api/guilds/:guildId/errors',async r => d.settings.listErrors(await actor(r),guild(r)));
  app.put('/api/guilds/:guildId/providers/:provider/key',{ config: { rateLimit: { max: 10,timeWindow: '1 minute' } } },async (r,reply) => { const p = (r.params as { provider: string }).provider; validateProvider(p); const b = fields(r.body,['key']); if (typeof b.key !== 'string') throw new SettingsError('credential_invalid'); await d.settings.setCredential(await actor(r),guild(r),p,b.key); return reply.status(204).send(); });
  app.delete('/api/guilds/:guildId/providers/:provider/key',{ config: { rateLimit: { max: 10,timeWindow: '1 minute' } } },async (r,reply) => { const p = (r.params as { provider: string }).provider; validateProvider(p); await d.settings.removeCredential(await actor(r),guild(r),p); return reply.status(204).send(); });
  app.get('/api/guilds/:guildId/grants',async r => d.settings.listAccess(await actor(r),guild(r)));
  app.post('/api/guilds/:guildId/grants',async (r,reply) => { const b = fields(r.body,['subjectType','subjectId','revision','acknowledgeSpendingRisk']); await d.settings.grantAccess(await actor(r),guild(r),{ subjectType: b.subjectType,subjectId: b.subjectId } as never,b.revision as number,b.acknowledgeSpendingRisk as boolean); return reply.status(204).send(); });
  app.delete('/api/guilds/:guildId/grants',async (r,reply) => { const b = fields(r.body,['subjectType','subjectId','revision']); await d.settings.revokeAccess(await actor(r),guild(r),{ subjectType: b.subjectType,subjectId: b.subjectId } as never,b.revision as number); return reply.status(204).send(); });
  app.get('/api/creator/approvals',async r => ({ guildIds: await d.settings.listApprovals(await actor(r)) }));
  app.put('/api/creator/approvals/:guildId',async (r,reply) => { const b = fields(r.body,['approved']); await d.settings.setApproval(await actor(r),guild(r),b.approved as boolean); return reply.status(204).send(); });
}
