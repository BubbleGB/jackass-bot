CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
