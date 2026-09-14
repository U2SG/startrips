CREATE TABLE "account_identity_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identity_actions_kind_check" CHECK ("account_identity_actions"."kind" in ('reverify', 'link')),
	CONSTRAINT "account_identity_actions_provider_shape_check" CHECK (("account_identity_actions"."kind" = 'reverify' and "account_identity_actions"."provider_id" is null)
        or ("account_identity_actions"."kind" = 'link' and "account_identity_actions"."provider_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "account_identity_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"provider_id" text,
	"account_record_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identity_audit_event_check" CHECK ("account_identity_audit"."event" in ('reverify', 'link-intent', 'link', 'unlink')),
	CONSTRAINT "account_identity_audit_outcome_check" CHECK ("account_identity_audit"."outcome" in ('success', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "account_identity_ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_record_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_subject" text NOT NULL,
	"provider_email" text,
	"provider_email_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_identity_actions" ADD CONSTRAINT "account_identity_actions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identity_actions" ADD CONSTRAINT "account_identity_actions_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identity_ownerships" ADD CONSTRAINT "account_identity_ownerships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identity_ownerships" ADD CONSTRAINT "account_identity_ownerships_account_record_id_account_id_fk" FOREIGN KEY ("account_record_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_identity_actions_secret_hash_unique" ON "account_identity_actions" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "account_identity_actions_user_idx" ON "account_identity_actions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_identity_actions_expires_idx" ON "account_identity_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "account_identity_audit_user_created_idx" ON "account_identity_audit" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_identity_ownership_provider_subject_unique" ON "account_identity_ownerships" USING btree ("provider_id","provider_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "account_identity_ownership_account_unique" ON "account_identity_ownerships" USING btree ("account_record_id");--> statement-breakpoint
CREATE INDEX "account_identity_ownership_user_idx" ON "account_identity_ownerships" USING btree ("user_id");