CREATE TABLE "journey_recorded_track_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment_id" uuid NOT NULL,
	"sample_order" integer NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"recorded_at" timestamp with time zone,
	"accuracy_meters" double precision,
	CONSTRAINT "journey_recorded_track_samples_coordinate_check" CHECK ("journey_recorded_track_samples"."latitude" between -90 and 90
        and "journey_recorded_track_samples"."longitude" between -180 and 180),
	CONSTRAINT "journey_recorded_track_samples_accuracy_check" CHECK ("journey_recorded_track_samples"."accuracy_meters" is null
        or "journey_recorded_track_samples"."accuracy_meters" between 0 and 1000000),
	CONSTRAINT "journey_recorded_track_samples_order_check" CHECK ("journey_recorded_track_samples"."sample_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "journey_recorded_track_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"segment_order" integer NOT NULL,
	"source" text NOT NULL,
	"provenance" text DEFAULT '' NOT NULL,
	"sample_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_recorded_track_segments_source_check" CHECK ("journey_recorded_track_segments"."source" in ('device-recording', 'imported-file', 'unknown')),
	CONSTRAINT "journey_recorded_track_segments_order_check" CHECK ("journey_recorded_track_segments"."segment_order" >= 0 and "journey_recorded_track_segments"."segment_order" < 64),
	CONSTRAINT "journey_recorded_track_segments_sample_count_check" CHECK ("journey_recorded_track_segments"."sample_count" between 1 and 5000)
);
--> statement-breakpoint
ALTER TABLE "journey_recorded_track_samples" ADD CONSTRAINT "journey_recorded_track_samples_segment_id_journey_recorded_track_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."journey_recorded_track_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_recorded_track_segments" ADD CONSTRAINT "journey_recorded_track_segments_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_recorded_track_samples_segment_order_unique" ON "journey_recorded_track_samples" USING btree ("segment_id","sample_order");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_recorded_track_segments_operation_unique" ON "journey_recorded_track_segments" USING btree ("journey_id","operation_key","segment_order");--> statement-breakpoint
CREATE INDEX "journey_recorded_track_segments_journey_order_idx" ON "journey_recorded_track_segments" USING btree ("journey_id","segment_order");