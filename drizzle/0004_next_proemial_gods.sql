ALTER TABLE "channel_state" ADD COLUMN "last_event_id" text;--> statement-breakpoint
ALTER TABLE "channel_state" ADD COLUMN "last_user_id" text;--> statement-breakpoint
ALTER TABLE "channel_state" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_state" ADD COLUMN "last_was_direct" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_state" ADD COLUMN "ready_event_id" text;--> statement-breakpoint
ALTER TABLE "channel_state" ADD COLUMN "assessment_event_id" text;