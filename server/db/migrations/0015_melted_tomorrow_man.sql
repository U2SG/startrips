CREATE TABLE "home_base_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atlas_id" uuid NOT NULL,
	"label" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "home_base_periods" ADD CONSTRAINT "home_base_periods_atlas_id_atlases_id_fk" FOREIGN KEY ("atlas_id") REFERENCES "public"."atlases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_base_periods_atlas_start_idx" ON "home_base_periods" USING btree ("atlas_id","started_on");