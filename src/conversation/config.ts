import type { Database } from '../db/index.js';
import { isSnowflake } from '../access/policy.js';
import type { GuildSettings } from '../settings/service.js';
import { ConversationError,type ConversationConfigRepository } from './types.js';
/** Internal worker config snapshot, not a dashboard endpoint or an ACL bypass.
 * One SQL snapshot includes approval/config/provider revisions without encrypted keys.
 */
export class PostgresConversationConfigRepository implements ConversationConfigRepository {
  constructor(private readonly database: Database) {}
  async load(guildId: string): Promise<GuildSettings | null> {
    if (!isSnowflake(guildId)) return null;
    try {
      const row = (await this.database.pool.query(`SELECT s.*,
        ARRAY(SELECT channel_id FROM auto_channels WHERE guild_id=s.guild_id ORDER BY channel_id) AS channels,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('provider',provider,'modelId',model_id,'effort',effort,'priority',priority,'dailyAllowance',daily_allowance::text,'credentialConfigured',true) ORDER BY priority) FROM provider_configs WHERE guild_id=s.guild_id),'[]'::jsonb) AS providers
        FROM guild_settings s JOIN approved_guilds a USING(guild_id) WHERE s.guild_id=$1 AND s.enabled`,[guildId])).rows[0];
      if (!row) return null;
      return { guildId: row.guild_id,revision: row.revision,instructions: row.instructions,enabled: row.enabled,directEnabled: row.direct_enabled,humanContextLimit: row.human_context_limit,selfContextLimit: row.self_context_limit,contextTokenLimit: row.context_token_limit,autoPolicy: row.auto_policy,autoGapSeconds: row.auto_gap_seconds,autoThreshold: row.auto_threshold,answerTargetTokens: row.answer_target_tokens,maxGenerationTokens: row.max_generation_tokens,autoChannels: row.channels,providers: row.providers };
    } catch { throw new ConversationError('context_unavailable'); }
  }
}
