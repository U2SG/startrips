CREATE TABLE "home_base_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atlas_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"dismissed_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_base_dismissals_kind_check" CHECK ("home_base_dismissals"."kind" in ('soft', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "home_base_dismissals" ADD CONSTRAINT "home_base_dismissals_atlas_id_atlases_id_fk" FOREIGN KEY ("atlas_id") REFERENCES "public"."atlases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "home_base_dismissals_atlas_unique" ON "home_base_dismissals" USING btree ("atlas_id");