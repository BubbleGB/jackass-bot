import type { PoolClient } from 'pg';
import type { Database } from '../db/index.js';
import { isSnowflake,SettingsError } from '../access/policy.js';
import { knowledgeLimits as limits } from './limits.js';
import { searchQuery } from './text.js';
import { isEntryId } from './service.js';
import type { KnowledgeSource,KnowledgePassage } from './types.js';
/** Internal retrieval only. Fresh committed snapshots; no browser ACL shortcut. */
export class KnowledgeRepository implements KnowledgeSource {
  constructor(private readonly db: Database) {}
  private async read<T>(signal: AbortSignal,run: (c: PoolClient) => Promise<T>): Promise<T> {
    let c: PoolClient | undefined;
    try {
      if (signal.aborted) throw new Error(); c = await this.db.pool.connect(); if (signal.aborted) throw new Error();
      await c.query('BEGIN READ ONLY'); await c.query(`SET LOCAL statement_timeout='${limits.queryTimeoutMs}ms'`);
      const value = await run(c); if (signal.aborted) throw new Error(); await c.query('COMMIT'); return value;
    } catch { if (c) await c.query('ROLLBACK').catch(() => undefined); throw new SettingsError('storage_failed'); }
    finally { c?.release(); }
  }
  async retrieve(guild: string,query: string,signal: AbortSignal): Promise<KnowledgePassage[]> {
    const terms = searchQuery(query); if (!isSnowflake(guild) || !terms || signal.aborted) return [];
    return this.read(signal,async c => (await c.query(`WITH query AS (SELECT to_tsquery('simple',$2) AS q)
      SELECT e.id AS "entryId",e.revision,c.ordinal AS "chunkIndex",e.title,c.body AS text
      FROM knowledge_chunks c JOIN knowledge_entries e ON e.guild_id=c.guild_id AND e.id=c.entry_id CROSS JOIN query
      WHERE c.guild_id=$1 AND e.enabled AND c.search @@ query.q
      ORDER BY ts_rank_cd(c.search,query.q) DESC,e.id,c.ordinal LIMIT ${limits.retrievedChunks}`,[guild,terms])).rows);
  }
  async current(guild: string,passages: readonly KnowledgePassage[],signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !isSnowflake(guild) || !Array.isArray(passages) || passages.length > limits.retrievedChunks) return false;
    if (!passages.length) return true;
    if (passages.some(p => !isEntryId(p.entryId) || !Number.isSafeInteger(p.revision) || p.revision < 1 || !Number.isSafeInteger(p.chunkIndex) || p.chunkIndex < 0 || typeof p.title !== 'string' || typeof p.text !== 'string' || !p.text.trim())) return false;
    return this.read(signal,async c => {
      const rows = (await c.query(`SELECT e.id,e.revision,e.title,c.ordinal,c.body FROM knowledge_entries e JOIN knowledge_chunks c ON c.guild_id=e.guild_id AND c.entry_id=e.id
        WHERE e.guild_id=$1 AND e.enabled AND (e.id,c.ordinal) IN (SELECT * FROM unnest($2::uuid[],$3::int[]))`,[guild,passages.map(p => p.entryId),passages.map(p => p.chunkIndex)])).rows;
      return passages.every(p => rows.some(r => r.id === p.entryId && r.revision === p.revision && r.ordinal === p.chunkIndex && r.title === p.title && r.body.startsWith(p.text)));
    });
  }
}
