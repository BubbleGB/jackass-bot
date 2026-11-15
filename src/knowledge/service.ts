import type { PoolClient } from 'pg';
import type { Database } from '../db/index.js';
import { AccessPolicy,isSnowflake,SettingsError } from '../access/policy.js';
import { accessRepository } from '../settings/service.js';
import { knowledgeLimits as limits } from './limits.js';
import { characters,chunks,validText } from './text.js';
import type { KnowledgeEntry,KnowledgeSummary } from './types.js';
export const isEntryId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function fields(value: unknown,allowed: readonly string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new SettingsError('invalid_knowledge'); return value as Record<string,unknown>;
}
function patch(value: unknown,creating = false): { title?: string; body?: string; enabled?: boolean } {
  const p = fields(value,['title','body','enabled']);
  if ((creating || 'title' in p) && !validText(p.title,limits.titleCharacters)) throw new SettingsError('invalid_knowledge');
  if ((creating || 'body' in p) && !validText(p.body,limits.bodyCharacters)) throw new SettingsError('invalid_knowledge');
  if ('enabled' in p && typeof p.enabled !== 'boolean') throw new SettingsError('invalid_knowledge');
  if (!Object.keys(p).length) throw new SettingsError('invalid_knowledge'); return p;
}
const metadata = (r: Record<string,unknown>): KnowledgeSummary => ({ id: String(r.id),title: String(r.title),enabled: r.enabled === true,revision: Number(r.revision),bodyCharacters: Number(r.body_characters),createdAt: (r.created_at as Date).toISOString(),updatedAt: (r.updated_at as Date).toISOString() });
const entry = (r: Record<string,unknown>): KnowledgeEntry => ({ ...metadata(r),body: String(r.body) });
/** Every operation reuses current access policy and the settings/approval guild lock. */
export class KnowledgeService {
  constructor(private readonly db: Database,private readonly access: AccessPolicy) {}
  private async protected<T>(actor: string,guild: string,write: boolean,run: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!isSnowflake(guild)) throw new SettingsError('invalid_settings'); let c: PoolClient | undefined;
    try {
      c = await this.db.pool.connect(); await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='5000ms'");
      await c.query(`SELECT ${write ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,[guild]);
      await this.access.require(actor,guild,write ? 'settings' : 'read',accessRepository(c));
      const result = await run(c); await c.query('COMMIT'); return result;
    } catch (e) { if (c) await c.query('ROLLBACK').catch(() => undefined); if (e instanceof SettingsError) throw e; throw new SettingsError('storage_failed'); }
    finally { c?.release(); }
  }
  private async row(c: PoolClient,guild: string,id: string) {
    if (!isEntryId(id)) throw new SettingsError('invalid_knowledge');
    const r = (await c.query('SELECT * FROM knowledge_entries WHERE guild_id=$1 AND id=$2',[guild,id])).rows[0]; if (!r) throw new SettingsError('knowledge_not_found'); return r;
  }
  private revision(current: number,expected: unknown): void {
    if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw new SettingsError('invalid_knowledge');
    if (current !== expected) throw new SettingsError('revision_conflict');
  }
  private async quota(c: PoolClient,guild: string,added: number,creating: boolean): Promise<void> {
    const r = (await c.query('SELECT count(*)::int AS entries,coalesce(sum(body_characters),0)::int AS characters FROM knowledge_entries WHERE guild_id=$1',[guild])).rows[0];
    if (r.entries+(creating ? 1 : 0) > limits.entries || r.characters+added > limits.totalBodyCharacters) throw new SettingsError('knowledge_limit');
  }
  private async index(c: PoolClient,guild: string,e: KnowledgeEntry): Promise<void> {
    await c.query('DELETE FROM knowledge_chunks WHERE guild_id=$1 AND entry_id=$2',[guild,e.id]);
    await c.query('INSERT INTO knowledge_chunks(guild_id,entry_id,ordinal,title,body) SELECT $1,$2,ordinality-1,$3,body FROM unnest($4::text[]) WITH ORDINALITY AS parts(body,ordinality)',[guild,e.id,e.title,chunks(e.body)]);
  }
  private async audit(c: PoolClient,actor: string,guild: string,id: string,action: string,changed: string[]): Promise<void> {
    await c.query('INSERT INTO audit_events(guild_id,actor,action,changed_fields,target_entry_id) VALUES($1,$2,$3,$4,$5)',[guild,actor,action,changed,id]);
  }
  list(actor: string,guild: string) {
    return this.protected(actor,guild,false,async c => {
      const rows = (await c.query('SELECT id,title,enabled,revision,body_characters,created_at,updated_at FROM knowledge_entries WHERE guild_id=$1 ORDER BY created_at,id',[guild])).rows;
      return { entries: rows.map(metadata),totalBodyCharacters: rows.reduce((n,r) => n+Number(r.body_characters),0),limits };
    });
  }
  get(actor: string,guild: string,id: string): Promise<KnowledgeEntry> { return this.protected(actor,guild,false,async c => entry(await this.row(c,guild,id))); }
  create(actor: string,guild: string,input: unknown): Promise<KnowledgeEntry> {
    return this.protected(actor,guild,true,async c => {
      const p = patch(input,true); await this.quota(c,guild,characters(p.body!),true);
      const e = entry((await c.query('INSERT INTO knowledge_entries(guild_id,title,body,enabled) VALUES($1,$2,$3,$4) RETURNING *',[guild,p.title,p.body,p.enabled ?? true])).rows[0]);
      await this.index(c,guild,e); await this.audit(c,actor,guild,e.id,'knowledge_create',['title','body','enabled']); return e;
    });
  }
  update(actor: string,guild: string,id: string,input: unknown): Promise<KnowledgeEntry> {
    return this.protected(actor,guild,true,async c => {
      const b = fields(input,['revision','patch']),p = patch(b.patch),old = entry(await this.row(c,guild,id)); this.revision(old.revision,b.revision);
      const next = { ...old,...p }; await this.quota(c,guild,characters(next.body)-old.bodyCharacters,false);
      const e = entry((await c.query('UPDATE knowledge_entries SET title=$3,body=$4,enabled=$5,revision=revision+1,updated_at=now() WHERE guild_id=$1 AND id=$2 RETURNING *',[guild,id,next.title,next.body,next.enabled])).rows[0]);
      if (p.title !== undefined || p.body !== undefined) await this.index(c,guild,e);
      await this.audit(c,actor,guild,id,'knowledge_update',Object.keys(p)); return e;
    });
  }
  remove(actor: string,guild: string,id: string,input: unknown): Promise<void> {
    return this.protected(actor,guild,true,async c => {
      const b = fields(input,['revision']),old = await this.row(c,guild,id); this.revision(old.revision,b.revision);
      await c.query('DELETE FROM knowledge_entries WHERE guild_id=$1 AND id=$2',[guild,id]); await this.audit(c,actor,guild,id,'knowledge_delete',['entry']);
    });
  }
}
