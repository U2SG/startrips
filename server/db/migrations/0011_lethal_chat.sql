CREATE TABLE "share_grant_journeys" (
	"share_grant_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "share_grant_journeys_pk" PRIMARY KEY("share_grant_id","journey_id")
);
--> statement-breakpoint
CREATE TABLE "share_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atlas_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "share_grant_journeys" ADD CONSTRAINT "share_grant_journeys_share_grant_id_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grant_journeys" ADD CONSTRAINT "share_grant_journeys_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grants" ADD CONSTRAINT "share_grants_atlas_id_atlases_id_fk" FOREIGN KEY ("atlas_id") REFERENCES "public"."atlases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_grant_journeys_journey_idx" ON "share_grant_journeys" USING btree ("journey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_grants_token_hash_unique" ON "share_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_grants_atlas_created_idx" ON "share_grants" USING btree ("atlas_id","created_at");