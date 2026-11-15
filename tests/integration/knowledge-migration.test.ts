import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,readFile,writeFile,copyFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { verifySchema } from '../../src/runtime/schema.js';
import { chunks } from '../../src/knowledge/text.js';
const guild = '111111111111111111',url = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_knowledge_upgrade_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: url.toString(),max: 1 }); let db: Database,oldFolder: string;
describe('knowledge additive migration and bounded FTS storage',() => {
  beforeAll(async () => {
    oldFolder = await mkdtemp(join(tmpdir(),'galaxy-before-knowledge-')); await mkdir(join(oldFolder,'meta'));
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json','utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter(e => !e.tag.startsWith('0008_'));
    await writeFile(join(oldFolder,'meta/_journal.json'),JSON.stringify(journal));
    for (const e of journal.entries) await copyFile(join('drizzle',e.tag+'.sql'),join(oldFolder,e.tag+'.sql'));
    await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`; db = createDatabase(url.toString()); await migrate(db.db,{ migrationsFolder: oldFolder });
  });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); if (oldFolder) await rm(oldFolder,{ recursive: true,force: true }); } });
  it('preserves populated old settings/credentials/usage, supplies the new default and enforces image/schema hash compatibility',async () => {
    await db.pool.query('INSERT INTO guild_settings(guild_id,instructions,context_token_limit,revision) VALUES($1,$2,777,9)',[guild,'Existing personality']);
    await db.pool.query('INSERT INTO approved_guilds(guild_id,approved_by) VALUES($1,$1)',[guild]);
    await db.pool.query("INSERT INTO provider_configs(guild_id,provider,ciphertext,nonce,key_version,model_id,priority,daily_allowance) VALUES($1,'openai',$2,$3,1,'gpt-5.4-mini-2026-03-17',1,12345)",[guild,Buffer.alloc(32,7),Buffer.alloc(12,8)]);
    await db.pool.query("INSERT INTO daily_usage(guild_id,provider,utc_date,total_tokens,uncertain_tokens,reserved_tokens) VALUES($1,'openai','2026-11-15',7,9,8)",[guild]);
    const providers = (await db.pool.query('SELECT * FROM provider_configs')).rows,before = (await db.pool.query('SELECT * FROM daily_usage')).rows;
    await verifySchema(db,oldFolder); await expect(verifySchema(db,'./drizzle')).rejects.toThrow('schema_unavailable');
    await migrate(db.db,{ migrationsFolder: './drizzle' }); await verifySchema(db,'./drizzle'); await expect(verifySchema(db,oldFolder)).rejects.toThrow('schema_unavailable');
    expect((await db.pool.query('SELECT instructions,context_token_limit,revision,knowledge_token_limit FROM guild_settings')).rows[0]).toEqual({ instructions: 'Existing personality',context_token_limit: 777,revision: 9,knowledge_token_limit: 2000 });
    expect((await db.pool.query('SELECT * FROM provider_configs')).rows).toEqual(providers); expect((await db.pool.query('SELECT * FROM daily_usage')).rows).toEqual(before);
    expect((await db.pool.query('SELECT 1 FROM knowledge_entries')).rowCount).toBe(0);
  });
  it('measures populated chunk/vector/GIN costs at the aggregate body limit and filters queries by guild',async () => {
    const words = Array.from({ length: 10000 },(_,i) => 't'+i.toString(36).padStart(4,'0')).join(' '),body = ('selenite '+words+' '+words).slice(0,100000);
    for (let i = 0; i < 10; i++) {
      const id = randomUUID(),title = 'Synthetic reference '+i;
      await db.pool.query('INSERT INTO knowledge_entries(guild_id,id,title,body) VALUES($1,$2,$3,$4)',[guild,id,title,body]);
      await db.pool.query('INSERT INTO knowledge_chunks(guild_id,entry_id,ordinal,title,body) SELECT $1,$2,ordinality-1,$3,body FROM unnest($4::text[]) WITH ORDINALITY AS parts(body,ordinality)',[guild,id,title,chunks(body)]);
    }
    await db.pool.query('ANALYZE knowledge_chunks');
    const sizes = (await db.pool.query("SELECT (SELECT sum(body_characters)::int FROM knowledge_entries) AS body_characters,(SELECT count(*)::int FROM knowledge_chunks) AS chunks,pg_total_relation_size('knowledge_entries')::text AS entries_bytes,pg_total_relation_size('knowledge_chunks')::text AS chunks_and_indexes_bytes,pg_relation_size('knowledge_search_idx')::text AS gin_bytes")).rows[0];
    const plan = (await db.pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT entry_id,ordinal FROM knowledge_chunks WHERE guild_id=$1 AND search @@ to_tsquery('simple',$2) ORDER BY ts_rank_cd(search,to_tsquery('simple',$2)) DESC,entry_id,ordinal LIMIT 8",[guild,'selenite'])).rows[0]!['QUERY PLAN'];
    expect(sizes.body_characters).toBe(1000000); expect(sizes.chunks).toBeLessThanOrEqual(2000); expect(BigInt(sizes.gin_bytes)).toBeGreaterThan(0n);
    expect(JSON.stringify(plan)).toContain('guild_id'); expect((await db.pool.query("SELECT 1 FROM knowledge_chunks WHERE guild_id=$1 AND search @@ to_tsquery('simple','selenite')",['222222222222222222'])).rowCount).toBe(0);
    if (process.env.CI !== 'true') { await mkdir('/workspace/scratch/knowledge-names',{ recursive: true }); await writeFile('/workspace/scratch/knowledge-names/index-measurement.json',JSON.stringify({ sizes,plan },null,2)); }
  });
});
