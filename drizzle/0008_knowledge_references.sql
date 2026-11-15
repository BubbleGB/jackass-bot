CREATE TABLE "knowledge_chunks" (
	"guild_id" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple',normalize("title",NFKC)),'A') || setweight(to_tsvector('simple',normalize("body",NFKC)),'B')) STORED NOT NULL,
	CONSTRAINT "knowledge_chunks_guild_id_entry_id_ordinal_pk" PRIMARY KEY("guild_id","entry_id","ordinal"),
	CONSTRAINT "knowledge_chunk_ordinal" CHECK ("knowledge_chunks"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"guild_id" text NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_characters" integer GENERATED ALWAYS AS (char_length("body")) STORED NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entries_guild_id_id_pk" PRIMARY KEY("guild_id","id"),
	CONSTRAINT "knowledge_entry_bounds" CHECK (char_length("knowledge_entries"."title") BETWEEN 1 AND 120 AND "knowledge_entries"."body_characters" BETWEEN 1 AND 100000 AND "knowledge_entries"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "target_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "knowledge_token_limit" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_guild_id_entry_id_knowledge_entries_guild_id_id_fk" FOREIGN KEY ("guild_id","entry_id") REFERENCES "public"."knowledge_entries"("guild_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_guild_id_guild_settings_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guild_settings"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_search_idx" ON "knowledge_chunks" USING gin ("search");--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "knowledge_token_bounds" CHECK ("guild_settings"."knowledge_token_limit" BETWEEN 0 AND 8000);