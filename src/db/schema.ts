import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => time('created_at').defaultNow().notNull();
const guildId = () => text('guild_id').notNull().references(() => guildSettings.guildId, { onDelete: 'cascade' });
const provider = () => text('provider', { enum: ['openai', 'google'] }).notNull();
const counter = (name: string) => bigint(name, { mode: 'bigint' }).default(sql`0`).notNull();

// Approval is intentionally independent of guild settings and survives guild removal.
export const approvedGuilds = pgTable('approved_guilds', {
  guildId: text('guild_id').primaryKey(), approvedBy: text('approved_by').notNull(), approvedAt: time('approved_at').defaultNow().notNull(),
});
export const guildSettings = pgTable('guild_settings', {
  guildId: text('guild_id').primaryKey(), instructions: text('instructions').default('').notNull(),
  enabled: boolean('enabled').default(false).notNull(), directEnabled: boolean('direct_enabled').default(false).notNull(),
  humanContextLimit: integer('human_context_limit').default(30).notNull(), selfContextLimit: integer('self_context_limit').default(5).notNull(),
  contextTokenLimit: integer('context_token_limit').default(8000).notNull(), autoPolicy: text('auto_policy', { enum: ['conditional', 'always'] }).default('conditional').notNull(),
  autoGapSeconds: integer('auto_gap_seconds').default(60).notNull(), autoThreshold: integer('auto_threshold').default(30).notNull(),
  answerTargetTokens: integer('answer_target_tokens').default(400).notNull(), maxGenerationTokens: integer('max_generation_tokens').default(2048).notNull(),
  revision: integer('revision').default(1).notNull(), createdAt: createdAt(), updatedAt: time('updated_at').defaultNow().notNull(),
}, (t) => [
  check('guild_settings_snowflake', sql`${t.guildId} ~ '^[0-9]{17,20}$'`),
  check('guild_settings_bounds', sql`length(${t.instructions}) <= 8000 AND ${t.humanContextLimit} BETWEEN 0 AND 100 AND ${t.selfContextLimit} BETWEEN 0 AND 20 AND ${t.contextTokenLimit} BETWEEN 1 AND 32000 AND ${t.autoGapSeconds} BETWEEN 5 AND 3600 AND ${t.autoThreshold} BETWEEN 1 AND 10000 AND ${t.revision} > 0 AND ${t.answerTargetTokens} > 0 AND ${t.maxGenerationTokens} >= ${t.answerTargetTokens}`),
  check('guild_settings_policy', sql`${t.autoPolicy} IN ('conditional','always')`),
]);
export const providerConfigs = pgTable('provider_configs', {
  guildId: guildId(), provider: provider(), ciphertext: bytea('ciphertext').notNull(), nonce: bytea('nonce').notNull(),
  keyVersion: integer('key_version').notNull(), modelId: text('model_id'), effort: text('effort'),
  priority: integer('priority').notNull(), dailyAllowance: counter('daily_allowance'), revision: integer('revision').default(1).notNull(),
  createdAt: createdAt(), updatedAt: time('updated_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.guildId, t.provider] }), unique('provider_priority_unique').on(t.guildId, t.priority),
  check('provider_config_bounds', sql`${t.provider} IN ('openai','google') AND ${t.priority} BETWEEN 1 AND 2 AND ${t.dailyAllowance} >= 0 AND ${t.revision} > 0 AND ${t.keyVersion} > 0 AND (${t.modelId} IS NULL OR length(${t.modelId}) BETWEEN 1 AND 200) AND octet_length(${t.nonce}) = 12 AND octet_length(${t.ciphertext}) > 16`),
]);
export const autoChannels = pgTable('auto_channels', {
  guildId: guildId(), channelId: text('channel_id').notNull(),
}, (t) => [primaryKey({ columns: [t.guildId, t.channelId] })]);
export const channelState = pgTable('channel_state', {
  guildId: guildId(), channelId: text('channel_id').notNull(), pendingCount: counter('pending_count'),
  assessmentSnapshot: bigint('assessment_snapshot', { mode: 'bigint' }), assessmentId: uuid('assessment_id'), assessmentStartedAt: time('assessment_started_at'),
  lastSuccessAt: time('last_success_at'), updatedAt: time('updated_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.guildId, t.channelId] }),
  foreignKey({ columns: [t.guildId, t.channelId], foreignColumns: [autoChannels.guildId, autoChannels.channelId] }).onDelete('cascade'),
  check('channel_state_counts', sql`${t.pendingCount} >= 0 AND (${t.assessmentSnapshot} IS NULL OR (${t.assessmentSnapshot} >= 0 AND ${t.assessmentSnapshot} <= ${t.pendingCount}))`),
  check('channel_state_assessment', sql`(${t.assessmentSnapshot} IS NULL AND ${t.assessmentId} IS NULL AND ${t.assessmentStartedAt} IS NULL) OR (${t.assessmentSnapshot} IS NOT NULL AND ${t.assessmentId} IS NOT NULL AND ${t.assessmentStartedAt} IS NOT NULL)`),
]);
export const accessGrants = pgTable('access_grants', {
  guildId: guildId(), subjectType: text('subject_type', { enum: ['user', 'role'] }).notNull(), subjectId: text('subject_id').notNull(), grantedBy: text('granted_by').notNull(), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.subjectType, t.subjectId] }), check('access_subject_type', sql`${t.subjectType} IN ('user','role')`)]);
// Usage belongs to the guild, not the credential row: replacing/removing a key cannot reset spend.
export const dailyUsage = pgTable('daily_usage', {
  guildId: guildId(), provider: provider(), utcDate: date('utc_date', { mode: 'string' }).notNull(),
  inputTokens: counter('input_tokens'), outputTokens: counter('output_tokens'), reasoningTokens: counter('reasoning_tokens'), totalTokens: counter('total_tokens'),
  uncertainTokens: counter('uncertain_tokens'), reservedTokens: counter('reserved_tokens'), requests: counter('requests'),
}, (t) => [
  primaryKey({ columns: [t.guildId, t.provider, t.utcDate] }),
  check('daily_usage_nonnegative', sql`${t.provider} IN ('openai','google') AND ${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.reasoningTokens} >= 0 AND ${t.totalTokens} >= 0 AND ${t.uncertainTokens} >= 0 AND ${t.reservedTokens} >= 0 AND ${t.requests} >= 0`),
]);
export const usageReservations = pgTable('usage_reservations', {
  id: uuid('id').defaultRandom().primaryKey(), guildId: guildId(), provider: provider(), utcDate: date('utc_date', { mode: 'string' }).notNull(),
  reserved: bigint('reserved', { mode: 'bigint' }).notNull(), state: text('state', { enum: ['reserved', 'known', 'uncertain', 'not_sent'] }).default('reserved').notNull(),
  attemptId: uuid('attempt_id').notNull().unique(), createdAt: createdAt(), updatedAt: time('updated_at').defaultNow().notNull(),
}, (t) => [check('reservation_bounds', sql`${t.reserved} >= 0 AND ${t.provider} IN ('openai','google') AND ${t.state} IN ('reserved','known','uncertain','not_sent')`), index('reservation_guild_bucket').on(t.guildId,t.provider,t.utcDate)]);
export const requestReceipts = pgTable('request_receipts', {
  guildId: guildId(), eventId: text('event_id').notNull(), state: text('state', { enum: ['accepted', 'processing', 'completed', 'uncertain', 'failed'] }).default('accepted').notNull(),
  createdAt: createdAt(), updatedAt: time('updated_at').defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.guildId, t.eventId] }), check('receipt_state', sql`${t.state} IN ('accepted','processing','completed','uncertain','failed')`)]);
export const webSessions = pgTable('web_sessions', {
  sessionHash: text('session_hash').primaryKey(), userId: text('user_id').notNull(),
  tokenCiphertext: bytea('token_ciphertext'), tokenNonce: bytea('token_nonce'), tokenKeyVersion: integer('token_key_version'),
  createdAt: createdAt(), expiresAt: time('expires_at').notNull(),
}, (t) => [
  check('session_hash_format', sql`${t.sessionHash} ~ '^[0-9a-f]{64}$'`),
  check('session_token_envelope', sql`(${t.tokenCiphertext} IS NULL AND ${t.tokenNonce} IS NULL AND ${t.tokenKeyVersion} IS NULL) OR (${t.tokenCiphertext} IS NOT NULL AND ${t.tokenNonce} IS NOT NULL AND ${t.tokenKeyVersion} IS NOT NULL AND octet_length(${t.tokenCiphertext}) > 16 AND octet_length(${t.tokenNonce}) = 12 AND ${t.tokenKeyVersion} > 0)`),
  check('session_expiry', sql`${t.expiresAt} > ${t.createdAt}`), index('session_expiry_idx').on(t.expiresAt),
]);
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').defaultRandom().primaryKey(), guildId: text('guild_id').references(() => guildSettings.guildId, { onDelete: 'cascade' }),
  targetGuildId: text('target_guild_id'),
  actor: text('actor').notNull(), action: text('action').notNull(), changedFields: text('changed_fields').array().notNull().default(sql`ARRAY[]::text[]`), createdAt: createdAt(),
}, (t) => [check('audit_target_snowflake', sql`${t.targetGuildId} IS NULL OR ${t.targetGuildId} ~ '^[0-9]{17,20}$'`), index('audit_guild_created').on(t.guildId,t.createdAt)]);
export const operationalErrors = pgTable('operational_errors', {
  id: uuid('id').defaultRandom().primaryKey(), guildId: guildId(), provider: provider(), safeCode: text('safe_code').notNull(), correlationId: uuid('correlation_id').notNull(), createdAt: createdAt(),
}, (t) => [check('operational_safe_code', sql`${t.provider} IN ('openai','google') AND ${t.safeCode} ~ '^[a-z0-9_]{1,64}$'`), index('errors_guild_created').on(t.guildId,t.createdAt)]);
