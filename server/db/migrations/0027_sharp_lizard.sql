CREATE TABLE "account_email_change_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"change_id" uuid,
	"action_id" uuid,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_email_change_audit_event_check" CHECK ("account_email_change_audit"."event" in ('start', 'old-confirm', 'new-verify', 'complete', 'cancel', 'replace', 'expire')),
	CONSTRAINT "account_email_change_audit_outcome_check" CHECK ("account_email_change_audit"."outcome" in ('success', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "account_email_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"initiating_session_id" text NOT NULL,
	"current_email" text NOT NULL,
	"proposed_email" text NOT NULL,
	"reverification_action_id" uuid NOT NULL,
	"old_proof_hash" text NOT NULL,
	"new_proof_hash" text NOT NULL,
	"old_confirmed_at" timestamp with time zone,
	"new_verified_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_email_changes_status_check" CHECK ("account_email_changes"."status" in ('pending', 'completed', 'cancelled', 'replaced', 'expired', 'conflicted')),
	CONSTRAINT "account_email_changes_closed_shape_check" CHECK (("account_email_changes"."status" = 'pending' and "account_email_changes"."closed_at" is null)
        or ("account_email_changes"."status" <> 'pending' and "account_email_changes"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_email_changes" ADD CONSTRAINT "account_email_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_email_change_audit_user_created_idx" ON "account_email_change_audit" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_email_change_audit_change_idx" ON "account_email_change_audit" USING btree ("change_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_changes_old_proof_unique" ON "account_email_changes" USING btree ("old_proof_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_changes_new_proof_unique" ON "account_email_changes" USING btree ("new_proof_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_changes_pending_user_unique" ON "account_email_changes" USING btree ("user_id") WHERE "account_email_changes"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_changes_pending_email_unique" ON "account_email_changes" USING btree ("proposed_email") WHERE "account_email_changes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "account_email_changes_user_created_idx" ON "account_email_changes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_email_changes_expires_idx" ON "account_email_changes" USING btree ("expires_at");