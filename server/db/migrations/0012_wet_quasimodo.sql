ALTER TABLE "media_assets" ADD COLUMN "display_width" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "display_height" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "preview_storage_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "preview_mime_type" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "preview_bytes" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "preview_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_preview_storage_key_unique" ON "media_assets" USING btree ("preview_storage_key");