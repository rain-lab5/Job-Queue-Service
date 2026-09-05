CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'completed', 'dead');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_queue_length" CHECK (char_length("jobs"."queue") BETWEEN 1 AND 100),
	CONSTRAINT "jobs_payload_object" CHECK (jsonb_typeof("jobs"."payload") = 'object'),
	CONSTRAINT "jobs_attempts_valid" CHECK ("jobs"."max_attempts" BETWEEN 1 AND 20 AND "jobs"."attempts" BETWEEN 0 AND "jobs"."max_attempts"),
	CONSTRAINT "jobs_worker_length" CHECK ("jobs"."worker_id" IS NULL OR char_length("jobs"."worker_id") BETWEEN 1 AND 100),
	CONSTRAINT "jobs_key_length" CHECK ("jobs"."idempotency_key" IS NULL OR char_length("jobs"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "jobs_state_valid" CHECK (
        ("jobs"."status" = 'queued' AND "jobs"."worker_id" IS NULL AND "jobs"."lease_expires_at" IS NULL AND "jobs"."attempts" < "jobs"."max_attempts") OR
        ("jobs"."status" = 'processing' AND "jobs"."worker_id" IS NOT NULL AND "jobs"."lease_expires_at" IS NOT NULL AND "jobs"."attempts" > 0) OR
        ("jobs"."status" = 'completed' AND "jobs"."worker_id" IS NOT NULL AND "jobs"."lease_expires_at" IS NULL AND "jobs"."attempts" > 0) OR
        ("jobs"."status" = 'dead' AND "jobs"."worker_id" IS NULL AND "jobs"."lease_expires_at" IS NULL AND "jobs"."attempts" = "jobs"."max_attempts")
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("queue","created_at","id") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_expired_idx" ON "jobs" USING btree ("lease_expires_at","id") WHERE "jobs"."status" = 'processing';