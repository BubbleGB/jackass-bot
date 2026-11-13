CREATE TABLE "access_grants" (
	"guild_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grants_guild_id_subject_type_subject_id_pk" PRIMARY KEY("guild_id","subject_type","subject_id"),
	CONSTRAINT "access_subject_type" CHECK ("access_grants"."subject_type" IN ('user','role'))
);
--> statement-breakpoint
CREATE TABLE "approved_guilds" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"changed_fields" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_channels" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	CONSTRAINT "auto_channels_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "channel_state" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"pending_count" bigint DEFAULT 0 NOT NULL,
	"assessment_snapshot" bigint,
	"assessment_id" uuid,
	"assessment_started_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_state_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id"),
	CONSTRAINT "channel_state_counts" CHECK ("channel_state"."pending_count" >= 0 AND ("channel_state"."assessment_snapshot" IS NULL OR ("channel_state"."assessment_snapshot" >= 0 AND "channel_state"."assessment_snapshot" <= "channel_state"."pending_count"))),
	CONSTRAINT "channel_state_assessment" CHECK (("channel_state"."assessment_snapshot" IS NULL AND "channel_state"."assessment_id" IS NULL AND "channel_state"."assessment_started_at" IS NULL) OR ("channel_state"."assessment_snapshot" IS NOT NULL AND "channel_state"."assessment_id" IS NOT NULL AND "channel_state"."assessment_started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"guild_id" text NOT NULL,
	"provider" text NOT NULL,
	"utc_date" date NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"uncertain_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_tokens" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_usage_guild_id_provider_utc_date_pk" PRIMARY KEY("guild_id","provider","utc_date"),
	CONSTRAINT "daily_usage_nonnegative" CHECK ("daily_usage"."provider" IN ('openai','google') AND "daily_usage"."input_tokens" >= 0 AND "daily_usage"."output_tokens" >= 0 AND "daily_usage"."reasoning_tokens" >= 0 AND "daily_usage"."total_tokens" >= 0 AND "daily_usage"."uncertain_tokens" >= 0 AND "daily_usage"."reserved_tokens" >= 0 AND "daily_usage"."requests" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"direct_enabled" boolean DEFAULT false NOT NULL,
	"human_context_limit" integer DEFAULT 30 NOT NULL,
	"self_context_limit" integer DEFAULT 5 NOT NULL,
	"context_token_limit" integer DEFAULT 8000 NOT NULL,
	"auto_policy" text DEFAULT 'conditional' NOT NULL,
	"auto_gap_seconds" integer DEFAULT 60 NOT NULL,
	"auto_threshold" integer DEFAULT 30 NOT NULL,
	"answer_target_tokens" integer DEFAULT 400 NOT NULL,
	"max_generation_tokens" integer DEFAULT 2048 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_settings_snowflake" CHECK ("guild_settings"."guild_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "guild_settings_bounds" CHECK (length("guild_settings"."instructions") <= 8000 AND "guild_settings"."human_context_limit" BETWEEN 0 AND 100 AND "guild_settings"."self_context_limit" BETWEEN 0 AND 20 AND "guild_settings"."context_token_limit" BETWEEN 1 AND 32000 AND "guild_settings"."auto_gap_seconds" BETWEEN 5 AND 3600 AND "guild_settings"."auto_threshold" BETWEEN 1 AND 10000 AND "guild_settings"."revision" > 0 AND "guild_settings"."answer_target_tokens" > 0 AND "guild_settings"."max_generation_tokens" >= "guild_settings"."answer_target_tokens"),
	CONSTRAINT "guild_settings_policy" CHECK ("guild_settings"."auto_policy" IN ('conditional','always'))
);
--> statement-breakpoint
CREATE TABLE "operational_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"provider" text NOT NULL,
	"safe_code" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_safe_code" CHECK ("operational_errors"."provider" IN ('openai','google') AND "operational_errors"."safe_code" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"guild_id" text NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"model_id" text NOT NULL,
	"effort" text,
	"priority" integer NOT NULL,
	"daily_allowance" bigint DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_configs_guild_id_provider_pk" PRIMARY KEY("guild_id","provider"),
	CONSTRAINT "provider_priority_unique" UNIQUE("guild_id","priority"),
	CONSTRAINT "provider_config_bounds" CHECK ("provider_configs"."provider" IN ('openai','google') AND "provider_configs"."priority" BETWEEN 1 AND 2 AND "provider_configs"."daily_allowance" >= 0 AND "provider_configs"."revision" > 0 AND "provider_configs"."key_version" > 0 AND length("provider_configs"."model_id") BETWEEN 1 AND 200 AND octet_length("provider_configs"."nonce") = 12 AND octet_length("provider_configs"."ciphertext") > 16)
);
--> statement-breakpoint
CREATE TABLE "request_receipts" (
	"guild_id" text NOT NULL,
	"event_id" text NOT NULL,
	"state" text DEFAULT 'accepted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_receipts_guild_id_event_id_pk" PRIMARY KEY("guild_id","event_id"),
	CONSTRAINT "receipt_state" CHECK ("request_receipts"."state" IN ('accepted','processing','completed','uncertain','failed'))
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"provider" text NOT NULL,
	"utc_date" date NOT NULL,
	"reserved" bigint NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"attempt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_reservations_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "reservation_bounds" CHECK ("usage_reservations"."reserved" >= 0 AND "usage_reservations"."provider" IN ('openai','google') AND "usage_reservations"."state" IN ('reserved','known','uncertain','not_sent'))
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"session_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_ciphertext" "bytea",
	"token_nonce" "bytea",
	"token_key_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_hash_format" CHECK ("web_sessions"."session_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_token_envelope" CHECK (("web_sessions"."token_ciphertext" IS NULL AND "web_sessions"."token_nonce" IS NULL AND "web_sessions"."token_key_version" IS NULL) OR ("web_sessions"."token_ciphertext" IS NOT NULL AND "web_sessions"."token_nonce" IS NOT NULL AND "web_sessions"."token_key_version" IS NOT NULL AND octet_length("web_sessions"."token_ciphertext") > 16 AND octet_length("web_sessions"."token_nonce") = 12 AND "web_sessions"."token_key_version" > 0)),
	CONSTRAINT "session_expiry" CHECK ("web_sessions"."expires_at" > "web_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_channels" ADD CONSTRAINT "auto_channels_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_state" ADD CONSTRAINT "channel_state_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_state" ADD CONSTRAINT "channel_state_guild_id_channel_id_auto_channels_guild_id_channel_id_fk" FOREIGN KEY ("guild_id","channel_id") REFERENCES "public"."auto_channels"("guild_id","channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_errors" ADD CONSTRAINT "operational_errors_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_receipts" ADD CONSTRAINT "request_receipts_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_guild_created" ON "audit_events" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "errors_guild_created" ON "operational_errors" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "reservation_guild_bucket" ON "usage_reservations" USING btree ("guild_id","provider","utc_date");--> statement-breakpoint
CREATE INDEX "session_expiry_idx" ON "web_sessions" USING btree ("expires_at");