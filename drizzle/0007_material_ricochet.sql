ALTER TABLE "daily_usage" DROP CONSTRAINT "daily_usage_guild_id_guild_settings_guild_id_fk";
--> statement-breakpoint
ALTER TABLE "request_receipts" DROP CONSTRAINT "request_receipts_guild_id_guild_settings_guild_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_reservations" DROP CONSTRAINT "usage_reservations_guild_id_guild_settings_guild_id_fk";
