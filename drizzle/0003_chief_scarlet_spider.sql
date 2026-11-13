CREATE TABLE "provider_health" (
	"guild_id" text NOT NULL,
	"provider" text NOT NULL,
	"configuration_revision" integer NOT NULL,
	"configuration_key" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"next_retry_at" timestamp with time zone,
	CONSTRAINT "provider_health_guild_id_provider_pk" PRIMARY KEY("guild_id","provider"),
	CONSTRAINT "provider_health_bounds" CHECK ("provider_health"."provider" IN ('openai','google') AND "provider_health"."failures" BETWEEN 0 AND 30 AND "provider_health"."configuration_revision" > 0 AND "provider_health"."configuration_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "configuration_key" text;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "configuration_revision" integer;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "known_input" bigint;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "known_output" bigint;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "known_reasoning" bigint;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "known_total" bigint;--> statement-breakpoint
ALTER TABLE "provider_health" ADD CONSTRAINT "provider_health_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "reservation_known_counts" CHECK (("usage_reservations"."known_input" IS NULL AND "usage_reservations"."known_output" IS NULL AND "usage_reservations"."known_reasoning" IS NULL AND "usage_reservations"."known_total" IS NULL) OR ("usage_reservations"."known_input" IS NOT NULL AND "usage_reservations"."known_output" IS NOT NULL AND "usage_reservations"."known_reasoning" IS NOT NULL AND "usage_reservations"."known_total" IS NOT NULL AND "usage_reservations"."known_input" >= 0 AND "usage_reservations"."known_output" >= 0 AND "usage_reservations"."known_reasoning" >= 0 AND "usage_reservations"."known_reasoning" <= "usage_reservations"."known_output" AND "usage_reservations"."known_total" = "usage_reservations"."known_input"+"usage_reservations"."known_output"));