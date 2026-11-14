import type { Database } from '../db/index.js';
import { AccessPolicy,isSnowflake,SettingsError } from '../access/policy.js';
import type { DiscordGet } from '../access/discord-membership.js';
/** Discovery is not access proof. Each returned guild and channel operation is authorized afresh. */
export class DashboardDirectory {
  constructor(private readonly db: Database,private readonly access: AccessPolicy,private readonly get: DiscordGet) {}
  async servers(actor: string,after = '') {
    if (after && !isSnowflake(after)) throw new SettingsError('invalid_settings');
    const rows = (await this.db.pool.query('SELECT s.guild_id FROM guild_settings s JOIN approved_guilds a USING(guild_id) WHERE s.guild_id>$1 ORDER BY s.guild_id LIMIT 50',[after])).rows;
    const servers: { id: string; name: string; level: string }[] = [];
    // Bounded enumeration: unapproved/inaccessible identifiers never leave the backend.
    for (const row of rows) {
      const level = await this.access.resolveAccess(actor,row.guild_id); if (level === 'none') continue;
      let name = 'Discord server'; try { const g = await this.get(`/guilds/${row.guild_id}`,AbortSignal.timeout(5000)) as { id?: unknown; name?: unknown }; if (g.id === row.guild_id && typeof g.name === 'string') name = g.name.slice(0,100); } catch { /* ID is still usable if display metadata is unavailable. */ }
      servers.push({ id: row.guild_id,name,level });
    }
    return { servers,next: rows.length === 50 ? rows.at(-1)!.guild_id as string : null };
  }
  async channels(actor: string,guild: string) {
    await this.access.require(actor,guild,'read');
    try {
      const result = await this.get(`/guilds/${guild}/channels`,AbortSignal.timeout(5000));
      if (!Array.isArray(result) || result.length > 500) throw new Error();
      return result.filter((c: { type?: unknown; guild_id?: unknown; id?: unknown; name?: unknown }) => c.type === 0 && c.guild_id === guild && isSnowflake(c.id) && typeof c.name === 'string').map(c => ({ id: c.id as string,name: (c.name as string).slice(0,100) }));
    } catch { throw new SettingsError('storage_failed'); }
  }
}
