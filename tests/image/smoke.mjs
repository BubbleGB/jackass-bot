import assert from 'node:assert/strict';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,readFile,rm,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
const exec = promisify(execFile),image = process.argv[2];
assert(image,'Pass a locally built production image');
const root = await mkdtemp(tmpdir()+'/galaxy-image-test-'),project = `galaxy-image-test-${process.pid}`,fixtures = resolve('tests/image');
const secrets = { database_url: 'postgresql://galaxy:fake-image-db-password@postgres:5432/galaxy',app_db_password: 'fake-image-db-password',postgres_password: 'fake-image-bootstrap-password',encryption_key: randomBytes(32).toString('base64'),discord_bot_token: 'fake-image-discord-token',discord_client_secret: 'fake-image-oauth-secret' };
for (const [key,value] of Object.entries(secrets)) { await writeFile(`${root}/${key}`,value+'\n'); await chmod(`${root}/${key}`,0o644); } // synthetic test files; see production ownership guidance.
const override = `${root}/test-compose.json`;
await writeFile(override,JSON.stringify({ services: { app: { restart: 'no',command: ['node','--import','/fixtures/preload.mjs','dist/main.js'],environment: { GALAXY_MOCK_URL: 'http://mocks:9000' },volumes: [`${fixtures}:/fixtures:ro`] },postgres: { restart: 'no' },mocks: { image,restart: 'no',healthcheck: { test: ['CMD','node','-e',"fetch('http://127.0.0.1:9000/control/results').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval: '1s',timeout: '2s',retries: 30 },networks: ['public'],command: ['node','/fixtures/mocks.mjs'],volumes: [`${fixtures}:/fixtures:ro`],ports: ['127.0.0.1::9000'] } } }));
const env = { ...process.env,GALAXY_IMAGE: image,GALAXY_SECRETS_DIR: root,GALAXY_HTTP_PORT: '0',PUBLIC_ORIGIN: 'https://galaxy.test',DISCORD_CLIENT_ID: '444444444444444444',CREATOR_USER_ID: '333333333333333333',CONTACT_URL: '' };
const prefix = ['compose','-f',resolve('compose.yaml'),'-f',override,'--project-name',project];
async function docker(args,check = true) { try { return (await exec('docker',args,{ env,maxBuffer: 6*1024*1024 })).stdout.trim(); } catch (e) { if (check) { let detail = String(e.stderr ?? ''); for (const value of Object.values(secrets)) detail = detail.replaceAll(value,'[redacted]'); throw new Error(`docker command failed: ${args[0]} ${args[1]}: ${detail}`,{ cause: e }); } return String(e.stdout ?? '')+String(e.stderr ?? ''); } }
const compose = (args,check = true) => docker([...prefix,...args],check);
const sql = async statement => compose(['exec','-T','postgres','psql','-U','postgres','-d','galaxy','-Atc',statement]);
async function wait(fn,timeout = 45000) { const deadline = Date.now()+timeout; let last; while (Date.now()<deadline) { try { const r = await fn(); if (r) return r; } catch (e) { last = e; } await new Promise(r => setTimeout(r,100)); } throw last ?? new Error('image smoke deadline'); }
async function call(origin,path,body) { const r = await fetch(origin+path,{ method: body === undefined ? 'GET' : 'POST',signal: AbortSignal.timeout(2000),...(body === undefined ? {} : { headers: { 'content-type': 'application/json' },body: JSON.stringify(body) }) }); return r; }
let appId,mockOrigin,origin,phase = 'inspect';
function step(name) { phase = name; console.log(JSON.stringify({ step: name })); }
try {
  const inspect = JSON.parse(await docker(['image','inspect',image]))[0]; assert.equal(inspect.Architecture,process.arch === 'arm64' ? 'arm64' : 'amd64'); assert.equal(inspect.Config.User,'node'); assert(!JSON.stringify(inspect.Config.Env).match(/fake-image-/));
  assert.equal(await docker(['run','--rm',image,'node','-e','process.stdout.write(String(process.getuid()))']),'1000');
  step('database_and_mocks'); await compose(['up','-d','--wait','postgres','mocks']);
  assert.equal(await sql("SELECT usesuper FROM pg_user WHERE usename='galaxy'"),'f');
  const pgId = await compose(['ps','-q','postgres']),pgInspect = JSON.parse(await docker(['inspect',pgId]))[0]; assert(!Object.values(pgInspect.NetworkSettings.Ports ?? {}).some(Boolean)); assert.equal(pgInspect.Config.Labels['com.centurylinklabs.watchtower.enable'],'false');
  const configured = JSON.parse(await compose(['config','--format','json'])); assert.equal(configured.networks.backend.internal,true); assert.equal(configured.services.app.labels['com.centurylinklabs.watchtower.enable'],'false');
  step('explicit_migrations'); const missing = await compose(['run','--rm','--no-deps','app'],false); assert(missing.includes('runtime_failed'),missing); assert.equal(await sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='guild_settings'"),'0');
  await compose(['--profile','ops','run','--rm','--no-deps','migrate']); await compose(['run','--rm','--no-deps','app','node','/fixtures/seed.mjs']);
  step('startup'); mockOrigin = 'http://'+await compose(['port','mocks','9000']); await compose(['up','-d','app']); appId = await compose(['ps','-q','app']); origin = 'http://'+await compose(['port','app','3000']);
  await wait(async () => (await call(origin,'/health/live')).ok); assert.equal((await call(origin,'/health/ready')).status,503);
  await wait(async () => (await (await call(mockOrigin,'/control/results')).json()).logins === 1);
  step('singleton'); const second = await compose(['exec','-T','-e','PORT=3001','app','node','--import','/fixtures/preload.mjs','dist/main.js'],false); assert(second.includes('runtime_failed'),second); assert.equal((await (await call(mockOrigin,'/control/results')).json()).logins,1);
  await call(mockOrigin,'/control/ready',{}); await wait(async () => (await call(origin,'/health/ready')).ok);
  step('assets'); const html = await (await call(origin,'/')).text(); assert(html.includes('id="root"')); const script = html.match(/src="([^"]+\.js)"/); assert(script); assert((await call(origin,script[1])).ok); assert((await call(origin,'/privacy')).ok); assert((await (await call(origin,'/servers/111111111111111111')).text()).includes('id="root"'));
  const logo = Buffer.from(await (await call(origin,'/galaxy-neegy-logo.png')).arrayBuffer()); assert.equal(createHash('sha256').update(logo).digest('hex'),createHash('sha256').update(await readFile('web/public/galaxy-neegy-logo.png')).digest('hex'));
  assert.equal((await call(origin,'/auth.js')).status,404);
  step('event_pipeline'); await call(mockOrigin,'/control/send',{ id: '555555555555555551' }); await wait(async () => (await (await call(mockOrigin,'/control/results')).json()).deliveries === 1);
  assert.equal(await sql('SELECT sum(total_tokens) FROM daily_usage'),'30');
  step('graceful_drain'); await call(mockOrigin,'/control/hold',{}); await call(mockOrigin,'/control/send',{ id: '555555555555555552',user: '333333333333333334' }); await wait(async () => (await (await call(mockOrigin,'/control/results')).json()).generations === 2);
  const stop = spawn('docker',[...prefix,'stop','app'],{ env,stdio: 'ignore' }),stopped = new Promise((res,rej) => { stop.on('error',rej); stop.on('exit',code => code === 0 ? res() : rej(new Error('stop failed'))); });
  await wait(async () => { try { return (await call(origin,'/health/ready')).status === 503; } catch { return true; } }); await call(mockOrigin,'/control/release',{}); await stopped;
  assert.equal(JSON.parse(await docker(['inspect',appId]))[0].State.ExitCode,0); assert.equal(await sql('SELECT sum(total_tokens) FROM daily_usage'),'60');
  step('restart'); await compose(['start','app']); origin = 'http://'+await compose(['port','app','3000']); await wait(async () => (await call(origin,'/health/ready')).ok);
  await call(mockOrigin,'/control/send',{ id: '555555555555555551' }); await new Promise(r => setTimeout(r,200)); assert.equal((await (await call(mockOrigin,'/control/results')).json()).generations,2);
  step('crash'); await call(mockOrigin,'/control/hold',{}); await call(mockOrigin,'/control/send',{ id: '555555555555555553' }); await wait(async () => (await (await call(mockOrigin,'/control/results')).json()).generations === 3);
  await docker(['kill','--signal=KILL',appId]); await wait(async () => JSON.parse(await docker(['inspect',appId]))[0].State.Status === 'exited'); assert.equal(JSON.parse(await docker(['inspect',appId]))[0].State.ExitCode,137);
  await compose(['start','app']); origin = 'http://'+await compose(['port','app','3000']); await wait(async () => (await call(origin,'/health/ready')).ok); assert(BigInt(await sql('SELECT sum(uncertain_tokens) FROM daily_usage'))>0n); assert.equal(await sql('SELECT sum(reserved_tokens) FROM daily_usage'),'0');
  await call(mockOrigin,'/control/release',{}); await call(mockOrigin,'/control/send',{ id: '555555555555555553' }); await new Promise(r => setTimeout(r,200)); const results = await (await call(mockOrigin,'/control/results')).json(); assert.equal(results.generations,3); assert.equal(results.deliveries,2); assert(results.safeMentions); assert(results.counts >= 2);
  step('log_redaction_and_stop'); const logs = await compose(['logs','--no-color','app']); for (const secret of Object.values(secrets)) assert(!logs.includes(secret)); assert(!logs.includes('Synthetic image conversation')); assert(!logs.includes('Image smoke answer'));
  await compose(['stop','app']); assert.equal(JSON.parse(await docker(['inspect',appId]))[0].State.ExitCode,0);
  console.log(JSON.stringify({ image,arch: process.arch,nonroot: true,privateDatabase: true,migrationsExplicit: true,readiness: true,singleWorker: true,dashboardAndLogo: true,eventToProviderAccountingDelivery: true,gracefulDrain: true,crashRecoveryWithoutReplay: true,logsSanitized: true }));
} catch (e) {
  console.error(`Production image smoke failed at ${phase}:`,e instanceof Error ? e.message : 'unknown'); let logs = await compose(['logs','--no-color'],false); for (const value of Object.values(secrets)) logs = logs.replaceAll(value,'[redacted]'); console.error(logs); process.exitCode = 1;
} finally { await compose(['down','-v','--remove-orphans'],false); await rm(root,{ recursive: true,force: true }); }
