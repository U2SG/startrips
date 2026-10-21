CREATE TABLE "media_person_classifications" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"has_person" boolean NOT NULL,
	"model" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_grant_media" (
	"share_grant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "share_grant_media_pk" PRIMARY KEY("share_grant_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "share_grants" ADD COLUMN "media_scoped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_person_classifications" ADD CONSTRAINT "media_person_classifications_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grant_media" ADD CONSTRAINT "share_grant_media_share_grant_id_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_grant_media" ADD CONSTRAINT "share_grant_media_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_grant_media_asset_idx" ON "share_grant_media" USING btree ("asset_id");