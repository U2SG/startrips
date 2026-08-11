ALTER TABLE "memories" RENAME TO "journeys";--> statement-breakpoint
ALTER TABLE "journeys" RENAME COLUMN "visited_at" TO "started_on";--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "ended_on" date;--> statement-breakpoint
UPDATE "journeys" SET "ended_on" = "started_on";--> statement-breakpoint
CREATE TABLE "journey_route_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"is_stop" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "journey_route_points" (
	"journey_id",
	"sort_order",
	"latitude",
	"longitude",
	"label",
	"is_stop",
	"occurred_at"
)
SELECT
	"id",
	0,
	"latitude",
	"longitude",
	CASE
		WHEN "country_code" = '' THEN "place_name"
		ELSE "place_name" || ', ' || "country_code"
	END,
	true,
	"started_on"::timestamp AT TIME ZONE 'UTC'
FROM "journeys";--> statement-breakpoint
ALTER TABLE "media_assets" RENAME COLUMN "memory_id" TO "journey_id";--> statement-breakpoint
ALTER TABLE "media_uploads" RENAME COLUMN "memory_id" TO "journey_id";--> statement-breakpoint
ALTER TABLE "journeys" DROP COLUMN "place_name";--> statement-breakpoint
ALTER TABLE "journeys" DROP COLUMN "country_code";--> statement-breakpoint
ALTER TABLE "journeys" DROP COLUMN "latitude";--> statement-breakpoint
ALTER TABLE "journeys" DROP COLUMN "longitude";--> statement-breakpoint
ALTER TABLE "journeys" RENAME CONSTRAINT "memories_atlas_id_atlases_id_fk" TO "journeys_atlas_id_atlases_id_fk";--> statement-breakpoint
ALTER TABLE "media_assets" RENAME CONSTRAINT "media_assets_memory_id_memories_id_fk" TO "media_assets_journey_id_journeys_id_fk";--> statement-breakpoint
ALTER TABLE "media_uploads" RENAME CONSTRAINT "media_uploads_memory_id_memories_id_fk" TO "media_uploads_journey_id_journeys_id_fk";--> statement-breakpoint
ALTER INDEX "memories_atlas_date_idx" RENAME TO "journeys_atlas_start_idx";--> statement-breakpoint
ALTER INDEX "media_assets_memory_order_idx" RENAME TO "media_assets_journey_order_idx";--> statement-breakpoint
ALTER INDEX "media_uploads_memory_idx" RENAME TO "media_uploads_journey_idx";--> statement-breakpoint
ALTER TABLE "journey_route_points" ADD CONSTRAINT "journey_route_points_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_route_points_journey_order_unique" ON "journey_route_points" USING btree ("journey_id","sort_order");--> statement-breakpoint
CREATE INDEX "journey_route_points_coordinates_idx" ON "journey_route_points" USING btree ("latitude","longitude");
