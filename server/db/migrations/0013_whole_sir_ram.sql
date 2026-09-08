CREATE TABLE "media_preview_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_preview_writes_storage_key_unique" ON "media_preview_writes" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_preview_writes_expires_idx" ON "media_preview_writes" USING btree ("expires_at");