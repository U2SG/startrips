CREATE TABLE "account_media_presentations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"style" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_media_presentations_style_check" CHECK ("account_media_presentations"."style" in ('classic', 'note-overlay', 'book', 'book-3d', 'stream'))
);
--> statement-breakpoint
ALTER TABLE "account_media_presentations" ADD CONSTRAINT "account_media_presentations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;