CREATE TABLE "everyday_fragments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atlas_id" uuid NOT NULL,
	"occurred_on" date NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"place_label" text,
	"note" text,
	"home_base_period_id" uuid,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "journey_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "everyday_fragment_id" uuid;--> statement-breakpoint
ALTER TABLE "everyday_fragments" ADD CONSTRAINT "everyday_fragments_atlas_id_atlases_id_fk" FOREIGN KEY ("atlas_id") REFERENCES "public"."atlases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "everyday_fragments" ADD CONSTRAINT "everyday_fragments_home_base_period_id_home_base_periods_id_fk" FOREIGN KEY ("home_base_period_id") REFERENCES "public"."home_base_periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "everyday_fragments_atlas_occurred_idx" ON "everyday_fragments" USING btree ("atlas_id","occurred_on");--> statement-breakpoint
CREATE INDEX "everyday_fragments_home_base_period_idx" ON "everyday_fragments" USING btree ("home_base_period_id");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_everyday_fragment_id_everyday_fragments_id_fk" FOREIGN KEY ("everyday_fragment_id") REFERENCES "public"."everyday_fragments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_everyday_fragment_order_idx" ON "media_assets" USING btree ("everyday_fragment_id","sort_order");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_single_owner" CHECK (("media_assets"."journey_id" is not null) <> ("media_assets"."everyday_fragment_id" is not null)
        and ("media_assets"."everyday_fragment_id" is null or "media_assets"."route_point_id" is null));