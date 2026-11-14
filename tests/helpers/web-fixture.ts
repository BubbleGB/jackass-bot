import { AccessPolicy } from '../../src/access/policy.js';
import { SettingsService,accessRepository } from '../../src/settings/service.js';
import { CredentialCipher } from '../../src/settings/credentials.js';
import type { Database } from '../../src/db/index.js';
import { createWebServer } from '../../src/web/server.js';
import { DashboardDirectory } from '../../src/web/directory.js';
export const owner = '111111111111111111',guildId = '222222222222222222',delegate = '333333333333333333',role = '444444444444444444',channelId = '555555555555555555',otherGuild = '666666666666666666';
export async function webFixture(db: Database,origin = 'http://127.0.0.1:4173') {
  let member = true,hasRole = true;
  const membership = { async lookup(userId: string,guild: string) { return member && guild === guildId ? { guildId: guild,userId,ownerId: owner,botPresent: true,roleIds: userId === delegate && hasRole ? [role] : [],roles: [{ id: role,permissions: '0' }] } : null; },async isTextChannel(guild: string,id: string) { return guild === guildId && id === channelId; } };
  const access = new AccessPolicy(owner,membership,accessRepository(db.pool)),settings = new SettingsService(db,access,new CredentialCipher(1,new Map([[1,Buffer.alloc(32,7)]])));
  await db.pool.query('INSERT INTO guild_settings(guild_id) VALUES($1) ON CONFLICT DO NOTHING',[guildId]);
  await settings.setApproval(owner,guildId,true);
  await settings.grantAccess(owner,guildId,{ subjectType: 'role',subjectId: role },1,true);
  const directory = new DashboardDirectory(db,access,async path => path.endsWith('/channels') ? [{ id: channelId,guild_id: guildId,type: 0,name: 'general' },{ id: otherGuild,guild_id: guildId,type: 11,name: 'excluded thread' }] : { id: guildId,name: 'Bubble Galaxy' });
  const app = await createWebServer({ database: db,access,settings,directory,origin,clientId: owner,sessionSecret: Buffer.alloc(32,8),oauth: {
    authorize(state: string) { return `${origin}/mock/discord?state=${state}`; },async identify(code: string) { if (!['owner','delegate'].includes(code)) throw new Error('private-oauth-secret'); return code === 'owner' ? owner : delegate; },
  } });
  return { app,access,settings,restoreMembership() { member = true; hasRole = true; },leave() { member = false; },removeRole() { hasRole = false; } };
}
