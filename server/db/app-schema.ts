import {
  boolean,
  check,
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
import { sql } from "drizzle-orm";

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

// #231: Home Base as a timeline of dated life periods rather than one mutable
// field. Each row is one primary life base over a half-open interval,
// `started_on <= date < ended_on`, with `ended_on` null for the current
// period. A move inserts a period and closes the previous one; it never
// rewrites the base an earlier Journey resolved to.
//
// Atlas-owned like every other record here, so an Atlas deletion cascades the
// history away. Deliberately a separate table and NOT a column on
// `journey_route_points`: a Home Base is where a member lived for a while, not
// a recorded coordinate on a route, and a Journey stays canonical recorded
// travel data.
//
// `latitude` / `longitude` are a representative city or metro anchor. V1
// neither needs nor stores an exact residential address.
export const homeBasePeriods = pgTable(
  "home_base_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    atlasId: uuid("atlas_id")
      .notNull()
      .references(() => atlases.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    // Required in V1. An approximate month may be normalised into a date by
    // the caller, but "unknown historical start" must never be stored as
    // "valid from the infinite past".
    startedOn: date("started_on", { mode: "string" }).notNull(),
    // Null is the current period, not a missing value.
    endedOn: date("ended_on", { mode: "string" }),
    // "manual" | "suggested-confirmed"; a confirmed suggestion is still a
    // member decision, which is why it is recorded rather than inferred.
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("home_base_periods_atlas_start_idx").on(table.atlasId, table.startedOn),
  ],
);

// #232: the member's answer to a Home Base suggestion, so that answer can
// survive the session it was given in. One row per Atlas: the suggestion
// surface asks about at most one region at a time, so a later answer replaces
// the same evidence revision rather than accumulating duplicate clicks; answers for
// other regions/evidence revisions remain available to the inference selector.
//
// `evidence_digest` stores `homeBaseEvidenceDigest()` verbatim. That string is
// structured, not opaque — the inference core parses the anchor and the
// supporting Journey ids back out of it to decide whether materially new
// residence evidence exists — so it is stored unbounded and untrimmed.
//
// `kind` separates an ordinary "not now" from an explicit rejection, which the
// issue asks to respect more strongly. `dismissed_on` is the calendar date the
// 90-day re-prompt rule counts from.
export const homeBaseDismissals = pgTable(
  "home_base_dismissals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    atlasId: uuid("atlas_id")
      .notNull()
      .references(() => atlases.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    // Fixed-size MD5 hex key keeps the unique B-tree independent of the
    // unbounded evidence digest while the full digest remains byte-exact.
    evidenceDigestHash: text("evidence_digest_hash").notNull(),
    dismissedOn: date("dismissed_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("home_base_dismissals_atlas_digest_hash_unique").on(table.atlasId, table.evidenceDigestHash),
    check(
      "home_base_dismissals_kind_check",
      sql`${table.kind} in ('soft', 'rejected')`,
    ),
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

// #234: an Everyday Fragment — one everyday experience rooted in a place,
// recorded without the ceremony a Journey asks for. No title, no route, no
// start/end pair: an occurrence date, one position, and optionally a place
// label, a sentence and media.
//
// Atlas-owned like every other record here, so an Atlas deletion cascades the
// fragments away. `home_base_period_id` is context, not ownership: it is
// nullable because a member may record an ordinary evening long before any
// Home Base is confirmed, and `on delete set null` because withdrawing a life
// period must never delete the evening that happened during it. Grouping is
// derived from the date by `resolveHomeBaseForDate`; this column only records
// an association that was already made.
//
// A Journey that stays in one area is still a Journey. Nothing here
// reclassifies one, and this table is not a second, lighter Journey: it has no
// route, so no route point, segment or stop can exist on it.
export const everydayFragments = pgTable(
  "everyday_fragments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    atlasId: uuid("atlas_id")
      .notNull()
      .references(() => atlases.id, { onDelete: "cascade" }),
    // The day the fragment happened, which is the only date it has. Never
    // rewritten by Home Base grouping.
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    // Optional human context, exactly like a route point's Place Label: it
    // describes the position without defining the fragment.
    placeLabel: text("place_label"),
    note: text("note"),
    // Contextual association with the life period that held on `occurred_on`.
    homeBasePeriodId: uuid("home_base_period_id").references(
      () => homeBasePeriods.id,
      { onDelete: "set null" },
    ),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("everyday_fragments_atlas_occurred_idx").on(
      table.atlasId,
      table.occurredOn,
    ),
    index("everyday_fragments_home_base_period_idx").on(table.homeBasePeriodId),
  ],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // #234: nullable, because media now has two possible owners and exactly
    // one of them at a time. A null here is not a missing Journey — it means
    // an Everyday Fragment owns this asset instead, which the check
    // constraint below makes the only other legal state.
    journeyId: uuid("journey_id").references(() => journeys.id, {
      onDelete: "cascade",
    }),
    everydayFragmentId: uuid("everyday_fragment_id").references(
      () => everydayFragments.id,
      { onDelete: "cascade" },
    ),
    routePointId: uuid("route_point_id").references(() => journeyRoutePoints.id, {
      onDelete: "set null",
    }),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    contentHash: text("content_hash"),
    // #311: true only when contentHash was derived from the durable stored bytes.
    // Historical/client-declared hashes remain false and cannot drive exact identity.
    contentHashVerified: boolean("content_hash_verified").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    uploadedByUserId: text("uploaded_by_user_id").notNull(),
    // #260: the presentable size of this asset after its EXIF orientation has
    // been applied, so a frame can be reserved before any byte of the original
    // arrives. Nullable because every asset uploaded before #260 landed has no
    // measured source size and stays preview-less by design.
    displayWidth: integer("display_width"),
    displayHeight: integer("display_height"),
    // #260: the derived preview — a size-bounded still of THIS asset, kept
    // under the same id. The original stays authoritative; these columns only
    // ever describe a second, smaller object beside it.
    previewStorageKey: text("preview_storage_key"),
    previewMimeType: text("preview_mime_type"),
    previewBytes: integer("preview_bytes"),
    // #265: the pixel size of the still THIS generation's producer was issued,
    // written beside the key that identifies the generation and cleared with
    // it. Recomputing the plan at completion would read the completing
    // process's live `MEDIA_PREVIEW_MAX_EDGE_PIXELS`, so a ceiling raised
    // between begin and completion would retroactively widen what an
    // already-issued producer was authorized to create. A later policy may
    // tighten what is servable; it may not redefine an earlier generation's
    // instructions. Nullable for the same reason the display size is: an asset
    // with no issued preview has none.
    previewWidth: integer("preview_width"),
    previewHeight: integer("preview_height"),
    // "none" | "pending" | "ready" | "failed"; only "ready" is ever served.
    previewState: text("preview_state").notNull().default("none"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("media_assets_storage_key_unique").on(table.storageKey),
    // Nullable unique: Postgres allows many NULLs, so preview-less assets are
    // unconstrained while no two assets can ever claim one derived object.
    uniqueIndex("media_assets_preview_storage_key_unique").on(
      table.previewStorageKey,
    ),
    index("media_assets_journey_order_idx").on(
      table.journeyId,
      table.sortOrder,
    ),
    index("media_assets_route_point_order_idx").on(
      table.routePointId,
      table.sortOrder,
    ),
    index("media_assets_everyday_fragment_order_idx").on(
      table.everydayFragmentId,
      table.sortOrder,
    ),
    // #234: the media-ownership rule, in the database rather than in prose.
    // One constraint because it is one rule: an asset belongs to exactly one
    // owner, and a fragment-owned asset cannot borrow a Route Point, which
    // by definition belongs to some other owner's Journey. Splitting it in
    // two would let a future write satisfy one half and describe an asset
    // that is owned by a fragment while hanging off a foreign route.
    check(
      "media_assets_single_owner",
      sql`(${table.journeyId} is not null) <> (${table.everydayFragmentId} is not null)
        and (${table.everydayFragmentId} is null or ${table.routePointId} is null)`,
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

// #260: the record of one issued preview write, deliberately outside the
// cascade that owns everything else about the asset.
//
// A preview is written by a single presigned PUT, so unlike the multipart
// pipeline there is no provider-side session to abort and no upload row to
// consult: once the URL is handed out, the write can land at any moment
// inside its short lifetime. If the media, its Journey or its Atlas is
// deleted in that window, the row that named the key is gone before the
// object exists, and the object that lands afterwards is referenced by
// nothing and discoverable by nobody.
//
// This table is that missing owner. It carries no foreign key on purpose —
// a reference to `media_assets`, `journeys` or `atlases` would cascade away
// with exactly the row whose disappearance the record exists to survive.
// `media_asset_id` is therefore a plain identifier kept for diagnosis, and
// the sweep in `server/services/media-preview.ts` decides by asking whether
// any asset still references the key, never by joining.
export const mediaPreviewWrites = pgTable(
  "media_preview_writes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mediaAssetId: uuid("media_asset_id").notNull(),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    // When the presigned write stops being usable. The sweep waits out this
    // instant plus a grace margin, so it can only ever see a window that is
    // already closed.
    //
    // It is not a terminal write state and nothing here treats it as one: a
    // PUT authorised a moment before it may still be streaming afterwards.
    // Past the margin this record is retired and dropped, and a write that
    // lands later is found by the prefix sweep over the preview namespace,
    // which is what makes forgetting a record safe.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("media_preview_writes_storage_key_unique").on(table.storageKey),
    index("media_preview_writes_expires_idx").on(table.expiresAt),
  ],
);
