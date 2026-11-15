import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from '../../src/db/index.js';
import { webFixture,owner,guildId } from '../helpers/web-fixture.js';
import { localTestDatabaseUrl } from '../helpers/test-database-url.js';
import { UsageService } from '../../src/usage/service.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import type { GenerationInput } from '../../src/domain/types.js';
const source = localTestDatabaseUrl(process.env.TEST_DATABASE_URL),name = `galaxy_luna_test_${randomUUID().replaceAll('-','')}`,admin = new Pool({ connectionString: source.toString(),max: 1 }); let db: Database;
const mini = 'gpt-5.4-mini-2026-03-17',luna = 'gpt-6-luna',now = new Date('2026-11-15T23:59:59Z'),tomorrow = new Date('2026-11-16T00:00:01Z');
describe('Luna settings and existing PostgreSQL usage settlement',() => {
  beforeAll(async () => { await admin.query(`CREATE DATABASE "${name}"`); source.pathname = `/${name}`; db = createDatabase(source.toString()); await migrate(db.db,{ migrationsFolder: './drizzle' }); });
  beforeEach(async () => { await db.pool.query('TRUNCATE daily_usage,usage_reservations,request_receipts,guild_settings,approved_guilds,web_sessions,oauth_states CASCADE'); });
  afterAll(async () => { await db?.close(); try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { await admin.end(); } });
  it('preserves saved Mini selections until staff explicitly select Luna and rejects unsupported Luna effort',async () => {
    const f = await webFixture(db); try {
      await f.settings.setCredential(owner,guildId,'openai','synthetic-key'); let s = await f.settings.getSettings(owner,guildId);
      s = await f.settings.updateSettings(owner,guildId,{ providers: [{ provider: 'openai',modelId: mini,effort: 'high',dailyAllowance: '2200' }] },s.revision);
      s = await f.settings.updateSettings(owner,guildId,{ instructions: 'Only change personality.' },s.revision);
      expect(s.providers[0]).toMatchObject({ modelId: mini,effort: 'high',dailyAllowance: '2200' });
      s = await f.settings.updateSettings(owner,guildId,{ providers: [{ provider: 'openai',modelId: luna,effort: null }] },s.revision);
      expect(s.providers[0]).toMatchObject({ modelId: luna,effort: null,dailyAllowance: '2200' });
      await expect(f.settings.updateSettings(owner,guildId,{ providers: [{ provider: 'openai',effort: 'minimal' }] },s.revision)).rejects.toMatchObject({ code: 'invalid_settings' });
      await expect(f.settings.updateSettings(owner,guildId,{ maxGenerationTokens: 15,answerTargetTokens: 15 },s.revision)).rejects.toMatchObject({ code: 'invalid_settings' });
      expect((await f.settings.getSettings(owner,guildId)).revision).toBe(s.revision);
    } finally { await f.app.close(); }
  });
  it('settles Luna cached/reasoning usage in full once, retains uncertainty and exhausts the original UTC allowance',async () => {
    const f = await webFixture(db); try {
      await f.settings.setCredential(owner,guildId,'openai','synthetic-key'); const s = await f.settings.getSettings(owner,guildId);
      await f.settings.updateSettings(owner,guildId,{ enabled: true,providers: [{ provider: 'openai',modelId: luna,effort: null,dailyAllowance: '2200' }] },s.revision);
      const input: GenerationInput = { modelId: luna,instructions: 'Be kind.',context: [],mode: 'direct',maxGenerationTokens: 2048 };
      const adapter = new OpenAIAdapter(async r => ({ status: 200,headers: {},body: r.url.endsWith('/input_tokens') ? { input_tokens: 120 } : { status: 'completed',output: [{ type: 'message',content: [{ type: 'output_text',text: '{"kind":"answer","text":"Hello"}' }] }],usage: { input_tokens: 2290,input_tokens_details: { cached_tokens: 80,cache_write_tokens: 20 },output_tokens: 10,output_tokens_details: { reasoning_tokens: 4 },total_tokens: 2300 } } }));
      const signal = new AbortController().signal,estimate = await adapter.estimateUsage(input,'synthetic-key',signal),usage = new UsageService(db);
      expect(estimate).toBe(2168); const reservation = (await usage.reserveUsage(guildId,'openai',randomUUID(),estimate,now))!;
      await usage.settleUsage(reservation.id,null,'uncertain'); await usage.settleUsage(reservation.id,null,'uncertain');
      const bucket = async (day: string) => (await db.pool.query('SELECT * FROM daily_usage WHERE guild_id=$1 AND provider=$2 AND utc_date=$3',[guildId,'openai',day])).rows[0];
      expect(await bucket('2026-11-15')).toMatchObject({ reserved_tokens: '0',uncertain_tokens: '2168',total_tokens: '0' });
      const result = await adapter.generate(input,'synthetic-key',signal);
      await Promise.all([usage.settleUsage(reservation.id,result.usage,'known'),usage.settleUsage(reservation.id,result.usage,'known')]);
      expect(await bucket('2026-11-15')).toMatchObject({ input_tokens: '2290',output_tokens: '10',reasoning_tokens: '4',total_tokens: '2300',reserved_tokens: '0',uncertain_tokens: '0',requests: '1' });
      expect(await usage.reserveUsage(guildId,'openai',randomUUID(),16,now)).toBeNull();
      expect((await f.settings.getSettings(owner,guildId)).providers[0]!.dailyAllowance).toBe('2200');
      expect(await bucket('2026-11-16')).toBeUndefined();
      expect((await usage.reserveUsage(guildId,'openai',randomUUID(),estimate,tomorrow))?.utcDate).toBe('2026-11-16');
      expect((await bucket('2026-11-15')).total_tokens).toBe('2300');
    } finally { await f.app.close(); }
  });
});
