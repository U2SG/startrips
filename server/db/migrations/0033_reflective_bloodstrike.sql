CREATE TABLE "provider_id_token_consumptions" (
	"token_digest" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "provider_id_token_consumptions_expires_idx" ON "provider_id_token_consumptions" USING btree ("expires_at");