CREATE TABLE "cover_reveal_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" uuid NOT NULL,
	"source_media_asset_id" uuid NOT NULL,
	"source_content_hash" text NOT NULL,
	"generation_kind" text NOT NULL,
	"generation_version" integer NOT NULL,
	"preset_id" text NOT NULL,
	"seed" text NOT NULL,
	"output_storage_driver" text,
	"output_storage_key" text,
	"output_mime_type" text,
	"output_bytes" integer,
	"output_width" integer,
	"output_height" integer,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_token_hash" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cover_reveal_derivatives_state_check" CHECK ("cover_reveal_derivatives"."state" in ('queued', 'leased', 'ready', 'failed', 'superseded')),
	CONSTRAINT "cover_reveal_derivatives_lease_shape_check" CHECK (("cover_reveal_derivatives"."lease_token_hash" is null) = ("cover_reveal_derivatives"."lease_expires_at" is null)),
	CONSTRAINT "cover_reveal_derivatives_ready_shape_check" CHECK ("cover_reveal_derivatives"."state" <> 'ready'
        or ("cover_reveal_derivatives"."output_storage_driver" is not null
          and "cover_reveal_derivatives"."output_storage_key" is not null
          and "cover_reveal_derivatives"."output_mime_type" is not null
          and "cover_reveal_derivatives"."output_bytes" is not null
          and "cover_reveal_derivatives"."output_width" is not null
          and "cover_reveal_derivatives"."output_height" is not null)),
	CONSTRAINT "cover_reveal_derivatives_attempts_check" CHECK ("cover_reveal_derivatives"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cover_reveal_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"derivative_id" uuid NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cover_reveal_derivatives" ADD CONSTRAINT "cover_reveal_derivatives_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cover_reveal_derivatives_output_key_unique" ON "cover_reveal_derivatives" USING btree ("output_storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_reveal_derivatives_lease_hash_unique" ON "cover_reveal_derivatives" USING btree ("lease_token_hash");--> statement-breakpoint
CREATE INDEX "cover_reveal_derivatives_state_created_idx" ON "cover_reveal_derivatives" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "cover_reveal_derivatives_journey_idx" ON "cover_reveal_derivatives" USING btree ("journey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_reveal_writes_storage_key_unique" ON "cover_reveal_writes" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "cover_reveal_writes_expires_idx" ON "cover_reveal_writes" USING btree ("expires_at");