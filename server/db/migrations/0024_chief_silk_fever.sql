CREATE TABLE "account_experience_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"earth_experience" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_experience_preferences_earth_experience_check" CHECK ("account_experience_preferences"."earth_experience" in ('default', 'particle-only')),
	CONSTRAINT "account_experience_preferences_revision_check" CHECK ("account_experience_preferences"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "account_experience_preferences" ADD CONSTRAINT "account_experience_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;