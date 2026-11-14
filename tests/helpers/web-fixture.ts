import { AccessPolicy } from '../../src/access/policy.js';
import { SettingsService,accessRepository } from '../../src/settings/service.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import type { Database } from '../../src/db/index.js';
import { createWebServer,type WebDiagnostic } from '../../src/web/server.js';
import { DashboardDirectory } from '../../src/web/directory.js';
import { DiscordMembership } from '../../src/access/discord-membership.js';
import { dashboardDiscord } from './dashboard-discord.js';
export const owner = '111111111111111111',guildId = '222222222222222222',delegate = '333333333333333333',role = '444444444444444444',channelId = '555555555555555555',otherGuild = '666666666666666666';
export async function webFixture(db: Database,origin = 'http://127.0.0.1:4173') {
  const discord = dashboardDiscord({ guild: guildId,owner,delegate,role,channel: channelId,other: otherGuild });
  const membership = new DiscordMembership(discord.get,discord.bot);
  const access = new AccessPolicy(owner,membership,accessRepository(db.pool)),settings = new SettingsService(db,access,new CredentialCipher(1,new Map([[1,Buffer.alloc(32,7)]])));
  await db.pool.query('INSERT INTO guild_settings(guild_id) VALUES($1) ON CONFLICT DO NOTHING',[guildId]);
  await settings.setApproval(owner,guildId,true);
  await settings.grantAccess(owner,guildId,{ subjectType: 'role',subjectId: role },1,true);
  const directory = new DashboardDirectory(db,access,discord.get);
  const diagnostics: WebDiagnostic[] = [];
  const app = await createWebServer({ database: db,access,settings,directory,origin,clientId: owner,sessionSecret: Buffer.alloc(32,8),diagnostics: entry => { diagnostics.push(entry); },oauth: {
    authorize(state: string) { return `${origin}/mock/discord?state=${state}`; },async identify(code: string) { if (!['owner','delegate'].includes(code)) throw new Error('private-oauth-secret'); return code === 'owner' ? owner : delegate; },
  } });
  discord.fault('none');
  return { app,access,settings,discord,diagnostics,restoreMembership: () => discord.reset(),leave: () => discord.leave(),removeRole: () => discord.removeRole() };
}
