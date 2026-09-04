import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const atlases = pgTable(
  "atlases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    title: text("title").notNull(),
    dedication: text("dedication").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletionStartedAt: timestamp("deletion_started_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("atlases_organization_unique").on(table.organizationId),
  ],
);

export const journeys = pgTable(
  "journeys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    atlasId: uuid("atlas_id")
      .notNull()
      .references(() => atlases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startedOn: date("started_on", { mode: "string" }).notNull(),
    endedOn: date("ended_on", { mode: "string" }),
    note: text("note").notNull().default(""),
    lightColor: text("light_color").notNull().default("#f4ce73"),
    lightEffect: text("light_effect"),
    // #14: explicit journey cover. Nullable; falls back to the first visual
    // media by sortOrder when unset. Deletion of the referenced asset clears
    // it (set null), and the app layer validates ownership + visual kind.
    // AnyPgColumn breaks the type-inference cycle journeys <-> mediaAssets.
    coverMediaAssetId: uuid("cover_media_asset_id").references(
      (): AnyPgColumn => mediaAssets.id,
      { onDelete: "set null" },
    ),
    revision: integer("revision").notNull().default(1),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletionStartedAt: timestamp("deletion_started_at", { withTimezone: true }),
  },
  (table) => [
    index("journeys_atlas_start_idx").on(table.atlasId, table.startedOn),
  ],
);

export const journeyRoutePoints = pgTable(
  "journey_route_points",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    label: text("label").notNull().default(""),
    isStop: boolean("is_stop").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    // #10: a short personal note for this route point. Plain text, nullable;
    // empty strings are stored as null. Kept simple for future journaling.
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("journey_route_points_journey_order_unique").on(
      table.journeyId,
      table.sortOrder,
    ),
    index("journey_route_points_coordinates_idx").on(
      table.latitude,
      table.longitude,
    ),
  ],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    routePointId: uuid("route_point_id").references(() => journeyRoutePoints.id, {
      onDelete: "set null",
    }),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    contentHash: text("content_hash"),
    sortOrder: integer("sort_order").notNull().default(0),
    uploadedByUserId: text("uploaded_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("media_assets_storage_key_unique").on(table.storageKey),
    index("media_assets_journey_order_idx").on(
      table.journeyId,
      table.sortOrder,
    ),
    index("media_assets_route_point_order_idx").on(
      table.routePointId,
      table.sortOrder,
    ),
  ],
);

// #200: an expiring read-only capability over an explicit Journey set. The
// raw bearer token is never stored; only its SHA-256 hash, which is what the
// guest request is resolved by. Atlas deletion cascades the grants away, so a
// hard-deleted Atlas can never leave an orphan public capability behind.
export const shareGrants = pgTable(
  "share_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    atlasId: uuid("atlas_id")
      .notNull()
      .references(() => atlases.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("share_grants_token_hash_unique").on(table.tokenHash),
    index("share_grants_atlas_created_idx").on(table.atlasId, table.createdAt),
  ],
);

// #200: the selected Journey set of one grant. A join table rather than a JSON
// array so membership is validated by the database and a hard Journey deletion
// cascades it out of every grant scope.
export const shareGrantJourneys = pgTable(
  "share_grant_journeys",
  {
    shareGrantId: uuid("share_grant_id")
      .notNull()
      .references(() => shareGrants.id, { onDelete: "cascade" }),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [
    primaryKey({
      name: "share_grant_journeys_pk",
      columns: [table.shareGrantId, table.journeyId],
    }),
    index("share_grant_journeys_journey_idx").on(table.journeyId),
  ],
);

export const mediaUploads = pgTable(
  "media_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    atlasId: uuid("atlas_id")
      .notNull()
      .references(() => atlases.id, { onDelete: "cascade" }),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    routePointId: uuid("route_point_id").references(() => journeyRoutePoints.id, {
      onDelete: "set null",
    }),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, {
      onDelete: "set null",
    }),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    providerUploadId: text("provider_upload_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    contentHash: text("content_hash"),
    partSize: integer("part_size").notNull(),
    partCount: integer("part_count").notNull(),
    status: text("status").notNull().default("initiated"),
    completionAttemptId: text("completion_attempt_id"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("media_uploads_storage_key_unique").on(table.storageKey),
    index("media_uploads_atlas_status_idx").on(table.atlasId, table.status),
    index("media_uploads_journey_idx").on(table.journeyId),
    index("media_uploads_route_point_idx").on(table.routePointId),
  ],
);
