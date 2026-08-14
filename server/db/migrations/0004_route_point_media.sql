ALTER TABLE "media_assets" ADD COLUMN "route_point_id" uuid;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD COLUMN "route_point_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_route_point_id_journey_route_points_id_fk" FOREIGN KEY ("route_point_id") REFERENCES "public"."journey_route_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_route_point_id_journey_route_points_id_fk" FOREIGN KEY ("route_point_id") REFERENCES "public"."journey_route_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_route_point_order_idx" ON "media_assets" USING btree ("route_point_id","sort_order");--> statement-breakpoint
CREATE INDEX "media_uploads_route_point_idx" ON "media_uploads" USING btree ("route_point_id");