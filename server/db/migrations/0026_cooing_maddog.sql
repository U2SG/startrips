ALTER TABLE "media_asset_evidence" DROP CONSTRAINT "media_asset_evidence_spatial_shape_check";--> statement-breakpoint
ALTER TABLE "media_asset_evidence" DROP CONSTRAINT "media_asset_evidence_capture_shape_check";--> statement-breakpoint
ALTER TABLE "media_asset_evidence" DROP CONSTRAINT "media_asset_evidence_correction_shape_check";--> statement-breakpoint
ALTER TABLE "media_asset_evidence" ADD CONSTRAINT "media_asset_evidence_spatial_shape_check" CHECK ((
        ("media_asset_evidence"."spatial_granularity" = 'coordinate'
          and "media_asset_evidence"."spatial_source" <> 'unknown'
          and "media_asset_evidence"."latitude" is not null
          and "media_asset_evidence"."longitude" is not null
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
      ));--> statement-breakpoint
ALTER TABLE "media_asset_evidence" ADD CONSTRAINT "media_asset_evidence_capture_shape_check" CHECK ((
        ("media_asset_evidence"."timezone_state" = 'offset-known'
          and "media_asset_evidence"."capture_time_source" <> 'unknown'
          and "media_asset_evidence"."captured_local" is not null
          and "media_asset_evidence"."captured_at_utc" is not null
          and "media_asset_evidence"."captured_offset_minutes" is not null
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
      ));--> statement-breakpoint
ALTER TABLE "media_asset_evidence" ADD CONSTRAINT "media_asset_evidence_correction_shape_check" CHECK ((
        ("media_asset_evidence"."correction_granularity" is null
          and "media_asset_evidence"."correction_latitude" is null
          and "media_asset_evidence"."correction_longitude" is null
          and "media_asset_evidence"."correction_label" is null)
        or
        ("media_asset_evidence"."correction_granularity" = 'coordinate'
          and "media_asset_evidence"."correction_latitude" is not null
          and "media_asset_evidence"."correction_longitude" is not null
          and "media_asset_evidence"."correction_latitude" between -90 and 90
          and "media_asset_evidence"."correction_longitude" between -180 and 180)
        or
        ("media_asset_evidence"."correction_granularity" = 'city'
          and "media_asset_evidence"."correction_latitude" is null
          and "media_asset_evidence"."correction_longitude" is null
          and "media_asset_evidence"."correction_label" is not null)
      ));