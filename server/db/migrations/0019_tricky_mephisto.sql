DROP INDEX "home_base_dismissals_atlas_unique";--> statement-breakpoint
ALTER TABLE "home_base_dismissals" ADD COLUMN "evidence_digest_hash" text;--> statement-breakpoint
UPDATE "home_base_dismissals"
SET "evidence_digest_hash" = encode(sha256(convert_to("evidence_digest", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "home_base_dismissals" ALTER COLUMN "evidence_digest_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "home_base_dismissals_atlas_digest_hash_unique" ON "home_base_dismissals" USING btree ("atlas_id","evidence_digest_hash");
