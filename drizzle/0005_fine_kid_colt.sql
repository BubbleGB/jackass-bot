CREATE TABLE "worker_ownership" (
	"name" text PRIMARY KEY NOT NULL,
	"token" uuid NOT NULL,
	CONSTRAINT "worker_ownership_singleton" CHECK ("worker_ownership"."name" = 'conversation')
);
