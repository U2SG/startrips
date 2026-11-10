ALTER TABLE "journal_import_jobs" ADD COLUMN "segments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_import_jobs" ADD COLUMN "segments_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_import_jobs" ADD COLUMN "degraded_lines" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_import_jobs" ADD COLUMN "degradations" jsonb;