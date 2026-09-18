CREATE TABLE "media_asset_evidence" (
	"media_asset_id" uuid PRIMARY KEY NOT NULL,
	"spatial_source" text DEFAULT 'unknown' NOT NULL,
	"spatial_granularity" text DEFAULT 'unknown' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_meters" double precision,
	"spatial_label" text,
	"capture_time_source" text DEFAULT 'unknown' NOT NULL,
	"timezone_state" text DEFAULT 'unknown' NOT NULL,
	"captured_local" text,
	"captured_at_utc" timestamp with time zone,
	"captured_offset_minutes" integer,
	"display_hidden" boolean DEFAULT false NOT NULL,
	"correction_granularity" text,
	"correction_latitude" double precision,
	"correction_longitude" double precision,
	"correction_label" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_asset_evidence_spatial_source_check" CHECK ("media_asset_evidence"."spatial_source" in ('exif', 'container-metadata', 'imported', 'unknown')),
	CONSTRAINT "media_asset_evidence_spatial_shape_check" CHECK ((
        ("media_asset_evidence"."spatial_granularity" = 'coordinate'
          and "media_asset_evidence"."spatial_source" <> 'unknown'
          and "media_asset_evidence"."latitude" between -90 and 90
          and "media_asset_evidence"."longitude" between -180 and 180
          and "media_asset_evidence"."spatial_label" is null
          and ("media_asset_evidence"."accuracy_meters" is null
            or "media_asset_evidence"."accuracy_meters" between 0 and 1000000))
        or
        ("media_asset_evidence"."spatial_granularity" = 'city'
          and "media_asset_evidence"."spatial_source" <> 'unknown'
          and "media_asset_evidence"."latitude" is null and "media_asset_evidence"."longitude" is null
          and "media_asset_evidence"."accuracy_meters" is null and "media_asset_evidence"."spatial_label" is not null)
        or
        ("media_asset_evidence"."spatial_granularity" = 'unknown'
          and "media_asset_evidence"."spatial_source" = 'unknown'
          and "media_asset_evidence"."latitude" is null and "media_asset_evidence"."longitude" is null
          and "media_asset_evidence"."accuracy_meters" is null and "media_asset_evidence"."spatial_label" is null)
      )),
	CONSTRAINT "media_asset_evidence_capture_source_check" CHECK ("media_asset_evidence"."capture_time_source" in ('exif-original', 'exif-digitized', 'gps', 'container-metadata', 'imported', 'unknown')),
	CONSTRAINT "media_asset_evidence_capture_shape_check" CHECK ((
        ("media_asset_evidence"."timezone_state" = 'offset-known'
          and "media_asset_evidence"."capture_time_source" <> 'unknown'
          and "media_asset_evidence"."captured_local" is not null
          and "media_asset_evidence"."captured_at_utc" is not null
          and "media_asset_evidence"."captured_offset_minutes" between -840 and 840)
        or
        ("media_asset_evidence"."timezone_state" = 'local-only'
          and "media_asset_evidence"."capture_time_source" <> 'unknown'
          and "media_asset_evidence"."captured_local" is not null
          and "media_asset_evidence"."captured_at_utc" is null
          and "media_asset_evidence"."captured_offset_minutes" is null)
        or
        ("media_asset_evidence"."timezone_state" = 'unknown'
          and "media_asset_evidence"."capture_time_source" = 'unknown'
          and "media_asset_evidence"."captured_local" is null
          and "media_asset_evidence"."captured_at_utc" is null
          and "media_asset_evidence"."captured_offset_minutes" is null)
      )),
	CONSTRAINT "media_asset_evidence_correction_shape_check" CHECK ((
        ("media_asset_evidence"."correction_granularity" is null
          and "media_asset_evidence"."correction_latitude" is null
          and "media_asset_evidence"."correction_longitude" is null
          and "media_asset_evidence"."correction_label" is null)
        or
        ("media_asset_evidence"."correction_granularity" = 'coordinate'
          and "media_asset_evidence"."correction_latitude" between -90 and 90
          and "media_asset_evidence"."correction_longitude" between -180 and 180)
        or
        ("media_asset_evidence"."correction_granularity" = 'city'
          and "media_asset_evidence"."correction_latitude" is null
          and "media_asset_evidence"."correction_longitude" is null
          and "media_asset_evidence"."correction_label" is not null)
      )),
	CONSTRAINT "media_asset_evidence_revision_check" CHECK ("media_asset_evidence"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "media_asset_evidence" ADD CONSTRAINT "media_asset_evidence_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;