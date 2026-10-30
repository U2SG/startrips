CREATE TABLE "journal_import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"atlas_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"characters" integer DEFAULT 0 NOT NULL,
	"chunks" integer DEFAULT 0 NOT NULL,
	"lease" uuid,
	"envelope" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_import_jobs" ADD CONSTRAINT "journal_import_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_import_jobs" ADD CONSTRAINT "journal_import_jobs_atlas_id_atlases_id_fk" FOREIGN KEY ("atlas_id") REFERENCES "public"."atlases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_import_jobs" ADD CONSTRAINT "journal_import_jobs_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_import_jobs_status_idx" ON "journal_import_jobs" USING btree ("status","created_at");