// Test-only HTTP harness: same production server/services, fake Discord identity and metadata.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../../src/db/index.js';
import { localTestDatabaseUrl } from './test-database-url.js';
import { webFixture,guildId,owner,role } from './web-fixture.js';
import { MODELS } from '../../src/providers/catalog.js';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_browser_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 });
await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; const db = createDatabase(url.toString());
await migrate(db.db,{ migrationsFolder: './drizzle' });
const f = await webFixture(db); await f.app.register(import('@fastify/static'),{ root: `${process.cwd()}/dist/dashboard`,index: false });
for (const path of ['/','/servers','/servers/:guildId','/creator']) f.app.get(path,(_r,reply) => reply.sendFile('index.html'));
f.app.get('/mock/discord',async (r,reply) => {
  const state = encodeURIComponent((r.query as { state: string }).state);
  return reply.type('text/html').send(`<form action="/auth/discord/callback"><input name="iss" type="hidden" value="https://discord.com"><input name="state" type="hidden" value="${state}"><button name="code" value="owner">Continue as owner</button><button name="code" value="delegate">Continue as delegate</button></form>`);
});
f.app.post('/mock/reset',async () => {
  f.restoreMembership(); await db.pool.query('TRUNCATE guild_settings,approved_guilds,web_sessions,oauth_states CASCADE');
  await db.pool.query('INSERT INTO guild_settings(guild_id) VALUES($1)',[guildId]); await f.settings.setApproval(owner,guildId,true);
  await f.settings.grantAccess(owner,guildId,{ subjectType: 'role',subjectId: role },1,true);
  await f.settings.setCredential(owner,guildId,'openai','fake-provider-secret');
  const s = await f.settings.getSettings(owner,guildId); await f.settings.updateSettings(owner,guildId,{ providers: [{ provider: 'openai',modelId: MODELS[0].id,dailyAllowance: '5000' }] },s.revision);
  return { ready: true };
});
f.app.post('/mock/concurrent',async () => { const s = await f.settings.getSettings(owner,guildId); await f.settings.updateSettings(owner,guildId,{ instructions: 'Their newer personality',autoThreshold: 44 },s.revision); return {}; });
f.app.post('/mock/remove-provider',async () => { await f.settings.removeCredential(owner,guildId,'openai'); return {}; });
f.app.post('/mock/leave',async () => { f.leave(); return {}; });
let closed = false;
const close = async () => { if (closed) return; closed = true; await f.app.close(); await db.close(); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); };
process.on('SIGTERM',() => { void close(); }); process.on('SIGINT',() => { void close(); });
await f.app.listen({ port: 4173,host: '127.0.0.1' });
