// Test-only HTTP harness: same production server/services, fake Discord identity and metadata.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../../src/db/index.js';
import { localTestDatabaseUrl } from './test-database-url.js';
import { webFixture,guildId,owner,role } from './web-fixture.js';
import { MODELS } from '../../src/providers/catalog.js';
import type { LookupFault } from './dashboard-discord.js';
import { createServer,request as httpRequest } from 'node:http';
const url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_browser_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 });
await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; const db = createDatabase(url.toString());
await migrate(db.db,{ migrationsFolder: './drizzle' });
const f = await webFixture(db); await f.app.register(import('@fastify/static'),{ root: `${process.cwd()}/dist/dashboard`,index: false });
let clientAddress = 1;
// Each browser case is an independent client. Use actual loopback source addresses,
// preserving production IP-based limits and trustProxy=false (no header-based bypass).
const proxy = createServer((req,res) => {
  const upstream = httpRequest({ hostname: '127.0.0.1',port: 4174,localAddress: `127.0.0.${clientAddress}`,method: req.method,path: req.url,headers: req.headers },response => {
    res.writeHead(response.statusCode ?? 502,response.headers); response.pipe(res);
  });
  upstream.on('error',() => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('aborted',() => upstream.destroy()); req.pipe(upstream);
});
for (const path of ['/','/privacy','/servers','/servers/:guildId','/servers/:guildId/knowledge','/creator']) f.app.get(path,(_r,reply) => reply.sendFile('index.html'));
f.app.get('/mock/discord',async (r,reply) => {
  const state = encodeURIComponent((r.query as { state: string }).state);
  return reply.type('text/html').send(`<form action="/auth/discord/callback"><input name="iss" type="hidden" value="https://discord.com"><input name="state" type="hidden" value="${state}"><button name="code" value="owner">Continue as owner</button><button name="code" value="delegate">Continue as delegate</button></form>`);
});
f.app.post('/mock/reset',async () => {
  clientAddress = clientAddress%250+1;
  f.restoreMembership(); await db.pool.query('TRUNCATE daily_usage,usage_reservations,request_receipts,guild_settings,approved_guilds,web_sessions,oauth_states CASCADE');
  await db.pool.query('INSERT INTO guild_settings(guild_id) VALUES($1)',[guildId]); await f.settings.setApproval(owner,guildId,true);
  await f.settings.grantAccess(owner,guildId,{ subjectType: 'role',subjectId: role },1,true);
  await f.settings.setCredential(owner,guildId,'openai','fake-provider-secret');
  const s = await f.settings.getSettings(owner,guildId); await f.settings.updateSettings(owner,guildId,{ providers: [{ provider: 'openai',modelId: MODELS[0].id,dailyAllowance: '5000' }] },s.revision);
  return { ready: true };
});
f.app.post('/mock/concurrent',async () => { const s = await f.settings.getSettings(owner,guildId); await f.settings.updateSettings(owner,guildId,{ instructions: 'Their newer personality',autoThreshold: 44 },s.revision); return {}; });
f.app.post('/mock/remove-provider',async () => { await f.settings.removeCredential(owner,guildId,'openai'); return {}; });
f.app.post('/mock/leave',async () => { f.leave(); return {}; });
f.app.post('/mock/access-fault',async r => { const b = r.body as { mode: LookupFault; at?: number }; f.discord.fault(b.mode,b.at); return {}; });
f.app.get('/mock/access-trace',async () => f.discord.trace());
let closed = false;
const close = async () => { if (closed) return; closed = true; await new Promise<void>(resolve => proxy.close(() => resolve())); await f.app.close(); await db.close(); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); };
process.on('SIGTERM',() => { void close(); }); process.on('SIGINT',() => { void close(); });
await f.app.listen({ port: 4174,host: '127.0.0.1' });
await new Promise<void>((resolve,reject) => { proxy.once('error',reject); proxy.listen(4173,'127.0.0.1',resolve); });
