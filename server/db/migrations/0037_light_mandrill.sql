CREATE TABLE "journey_route_point_batch_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atlas_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"base_revision" integer NOT NULL,
	"applied_revision" integer,
	"receipt" jsonb,
	"outcome" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_route_point_batch_status_check" CHECK ("journey_route_point_batch_operations"."status" in ('staged', 'applied', 'partially-undone', 'undone'))
);
--> statement-breakpoint
ALTER TABLE "journey_route_point_batch_operations" ADD CONSTRAINT "journey_route_point_batch_operations_atlas_id_atlases_id_fk" FOREIGN KEY ("atlas_id") REFERENCES "public"."atlases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_route_point_batch_operations" ADD CONSTRAINT "journey_route_point_batch_operations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_route_point_batch_operation_unique" ON "journey_route_point_batch_operations" USING btree ("journey_id","operation_id");--> statement-breakpoint
CREATE INDEX "journey_route_point_batch_journey_status_idx" ON "journey_route_point_batch_operations" USING btree ("journey_id","status");