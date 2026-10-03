// ST-115 Route Point batch integration coverage
import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atlases,
  journeyRoutePointBatchOperations,
  journeyRoutePoints,
  mediaAssets,
  mediaUploads,
} from "../db/app-schema";
import { db, pool } from "../db/client";
import {
  applyJourneyRoutePointBatchForAtlas,
  createJourneyForAtlas,
  getJourneyForAtlas,
  getJourneyRoutePointBatchForAtlas,
  JourneyRouteChangedError,
  JourneyRoutePointBatchError,
  undoJourneyRoutePointBatchForAtlas,
  updateJourneyForAtlas,
} from "../repositories/journey-repository";
import { moveJourneyMediaForAtlas, undoJourneyMediaMoveForAtlas } from "../services/journey-media";

const atlasIds: string[] = [];
let atlasA = "";
let atlasB = "";

const baseJourney = {
  title: "Route batch",
  startedOn: "2026-09-01",
  endedOn: "2026-09-03",
  note: "private",
  lightColor: "#6c8fb7",
  routePoints: [
    { latitude: 22.543096, longitude: 114.057865, label: "Shenzhen", isStop: true,
      occurredAt: new Date("2026-09-01T00:00:00Z") },
    { latitude: 22.3193, longitude: 114.1694, label: "Hong Kong", isStop: true,
      occurredAt: new Date("2026-09-02T00:00:00Z") },
  ],
};

beforeAll(async () => {
  const rows = await db.insert(atlases).values([
    { organizationId: `st115-a-${randomUUID()}`, title: "ST115 A" },
    { organizationId: `st115-b-${randomUUID()}`, title: "ST115 B" },
  ]).returning({ id: atlases.id });
  [atlasA, atlasB] = rows.map((row) => row.id);
  atlasIds.push(atlasA, atlasB);
});

afterAll(async () => {
  if (atlasIds.length) await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  await pool.end();
});

async function journey(atlasId: string, title: string) {
  const result = await createJourneyForAtlas(atlasId, `user-${atlasId}`, {
    ...baseJourney,
    title,
  });
  if (!result) throw new Error("Journey fixture was not created");
  return result;
}

async function asset(options: {
  journeyId: string;
  routePointId?: string | null;
  sortOrder?: number;
  hash?: string | null;
  verified?: boolean;
  fileName?: string;
}) {
  const [result] = await db.insert(mediaAssets).values({
    journeyId: options.journeyId,
    routePointId: options.routePointId ?? null,
    storageDriver: "test",
    storageKey: `st115/${randomUUID()}`,
    fileName: options.fileName ?? "batch.jpg",
    mimeType: "image/jpeg",
    bytes: 128,
    contentHash: options.hash ?? null,
    contentHashVerified: options.verified ?? false,
    sortOrder: options.sortOrder ?? 0,
    uploadedByUserId: "st115-user",
  }).returning();
  return result;
}

async function upload(journeyId: string, status: string) {
  const [result] = await db.insert(mediaUploads).values({
    atlasId: atlasA,
    journeyId,
    routePointId: null,
    storageDriver: "test",
    storageKey: `st115-upload/${randomUUID()}`,
    providerUploadId: randomUUID(),
    fileName: "pending.jpg",
    mimeType: "image/jpeg",
    bytes: 128,
    partSize: 128,
    partCount: 1,
    status,
    createdByUserId: "st115-user",
  }).returning();
  return result;
}

function batch(
  operationId: string,
  baseRevision: number,
  attachment: { assetId?: string; uploadId?: string; intentionalReuse?: boolean },
  candidateId = "new-stop",
) {
  return {
    operationId,
    baseRevision,
    points: [{
      candidateId,
      latitude: 22.2855,
      longitude: 114.1577,
      label: "Batch stop",
      isStop: true,
      occurredAt: new Date("2026-09-03T00:00:00Z"),
    }],
    attachments: [{ ...attachment, candidateId }],
  };
}

describe("Route Point batch apply and undo", () => {
  it("validates revision/scope, replays lost responses, and stages incomplete uploads", async () => {
    const owned = await journey(atlasA, "Guard and replay");
    const foreign = await journey(atlasB, "Foreign");
    const localAsset = await asset({ journeyId: owned.id });
    const foreignAsset = await asset({ journeyId: foreign.id });

    await expect(applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      batch("stale", owned.revision + 1, { assetId: localAsset.id }),
    )).rejects.toBeInstanceOf(JourneyRouteChangedError);

    await expect(applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      batch("foreign", owned.revision, { assetId: foreignAsset.id }),
    )).rejects.toMatchObject({
      status: 404,
      code: "ROUTE_POINT_BATCH_MEDIA_NOT_FOUND",
    } satisfies Partial<JourneyRoutePointBatchError>);

    const request = batch("lost-response", owned.revision, { assetId: localAsset.id });
    const applied = await applyJourneyRoutePointBatchForAtlas(owned.id, atlasA, request);
    expect(applied).toMatchObject({ status: "applied", outcome: { status: "applied", mounted: true } });
    const replay = await applyJourneyRoutePointBatchForAtlas(owned.id, atlasA, request);
    expect(replay?.receipt).toEqual(applied?.receipt);
    expect(replay?.appliedRevision).toBe(applied?.appliedRevision);

    await expect(applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      { ...request, points: [{ ...request.points[0], latitude: 22.29 }] },
    )).rejects.toMatchObject({ status: 409, code: "ROUTE_POINT_BATCH_ID_REUSED" });

    const [pointCount] = await db.select({ value: count() })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, owned.id));
    expect(pointCount.value).toBe(3);

    const stagedJourney = await journey(atlasA, "Staged uploads");
    const preserved = await asset({
      journeyId: stagedJourney.id,
      routePointId: stagedJourney.routePoints[0].id,
    });
    const pending = await upload(stagedJourney.id, "initiated");
    const failed = await upload(stagedJourney.id, "aborted");
    const staged = await applyJourneyRoutePointBatchForAtlas(
      stagedJourney.id,
      atlasA,
      batch("pending-upload", stagedJourney.revision, { uploadId: pending.id }, "pending-point"),
    );
    expect(staged).toMatchObject({
      status: "staged",
      outcome: { status: "staged", mounted: false },
    });
    const partial = await applyJourneyRoutePointBatchForAtlas(
      stagedJourney.id,
      atlasA,
      batch("failed-upload", stagedJourney.revision, { uploadId: failed.id }, "failed-point"),
    );
    expect(partial).toMatchObject({
      status: "staged",
      outcome: { status: "partial", mounted: false },
    });
    const [stillThere] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, preserved.id));
    expect(stillThere.routePointId).toBe(stagedJourney.routePoints[0].id);
    const [stagedPointCount] = await db.select({ value: count() })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, stagedJourney.id));
    expect(stagedPointCount.value).toBe(2);
  });

  it("uses verified identity and remains compatible with the canonical Journey update", async () => {
    const owned = await journey(atlasA, "Verified identity");
    const hash = "a".repeat(64);
    const placed = await asset({
      journeyId: owned.id,
      routePointId: owned.routePoints[0].id,
      hash,
      verified: true,
    });
    const reuploaded = await asset({
      journeyId: owned.id,
      sortOrder: 1,
      hash,
      verified: true,
    });

    await expect(applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      batch("automatic-duplicate", owned.revision, { assetId: reuploaded.id }),
    )).rejects.toMatchObject({
      status: 409,
      code: "ROUTE_POINT_BATCH_DUPLICATE_MEDIA",
    } satisfies Partial<JourneyRoutePointBatchError>);

    const intentional = await applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      batch("intentional-reuse", owned.revision, {
        assetId: placed.id,
        intentionalReuse: true,
      }),
    );
    expect(intentional?.status).toBe("applied");
    const targetId = intentional?.receipt?.pointMappings[0]?.routePointId;
    expect(targetId).toBeTruthy();
    const [moved] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, placed.id));
    expect(moved.routePointId).toBe(targetId);

    const live = await getJourneyForAtlas(owned.id, atlasA);
    if (!live) throw new Error("Applied Journey disappeared");
    const updated = await updateJourneyForAtlas(owned.id, atlasA, {
      title: "Verified identity renamed",
      startedOn: live.startedOn,
      endedOn: live.endedOn,
      note: live.note,
      lightColor: live.lightColor,
      lightEffect: live.lightEffect,
      revision: live.revision,
      routePoints: live.routePoints.map((point) => ({
        id: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        label: point.label,
        isStop: point.isStop,
        occurredAt: point.occurredAt,
        note: point.note,
        regionContext: point.regionContext,
        placeRole: point.placeRole,
        overviewVisibility: point.overviewVisibility,
        stayAnchorRoutePointId: point.stayAnchorRoutePointId,
      })),
    });
    expect(updated?.title).toBe("Verified identity renamed");
    expect(updated?.routePoints.some((point) => point.id === targetId)).toBe(true);

    await expect(undoJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      "intentional-reuse",
    )).rejects.toMatchObject({
      status: 409,
      code: "ROUTE_POINT_BATCH_UNDO_CONFLICT",
    } satisfies Partial<JourneyRoutePointBatchError>);
  });

  it("keeps the existing media move/undo contract intact after a batch-created point", async () => {
    const owned = await journey(atlasA, "Legacy media move");
    const originalPointId = owned.routePoints[0].id;
    const legacyAsset = await asset({
      journeyId: owned.id,
      routePointId: originalPointId,
      sortOrder: 0,
      fileName: "legacy.jpg",
    });
    const batchAsset = await asset({ journeyId: owned.id, sortOrder: 1, fileName: "batch.jpg" });
    const applied = await applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      batch("media-move-regression", owned.revision, { assetId: batchAsset.id }),
    );
    const createdPointId = applied?.receipt?.pointMappings[0]?.routePointId;
    expect(createdPointId).toBeTruthy();

    const beforeMove = await getJourneyForAtlas(owned.id, atlasA);
    if (!beforeMove) throw new Error("Batch Journey disappeared");
    const assetOrder = beforeMove.media.map((media) => media.id);
    const moved = await moveJourneyMediaForAtlas(atlasA, {
      journeyId: owned.id,
      assetIds: [legacyAsset.id],
      routePointId: createdPointId!,
    });
    expect(moved.status).toBe(200);

    const undone = await undoJourneyMediaMoveForAtlas(atlasA, {
      journeyId: owned.id,
      expectedRoutePointId: createdPointId!,
      assignments: [{ assetId: legacyAsset.id, routePointId: originalPointId }],
      assetOrder,
    });
    expect(undone.status).toBe(200);
    const afterUndo = await getJourneyForAtlas(owned.id, atlasA);
    expect(afterUndo?.media.map((media) => media.id)).toEqual(assetOrder);
    expect(afterUndo?.media.find((media) => media.id === legacyAsset.id)?.routePointId).toBe(originalPointId);
  });

  it("undoes from its receipt, exposes expiry, and compensates partially after later media", async () => {
    const owned = await journey(atlasA, "Undo batch");
    const originalPointId = owned.routePoints[0].id;
    const movedAsset = await asset({
      journeyId: owned.id,
      routePointId: originalPointId,
    });
    const applied = await applyJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      batch("undo-happy", owned.revision, {
        assetId: movedAsset.id,
        intentionalReuse: true,
      }),
    );
    const createdPointId = applied?.receipt?.pointMappings[0]?.routePointId;
    expect(createdPointId).toBeTruthy();
    expect((await getJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      "undo-happy",
    ))?.undo).toMatchObject({ eligible: true });

    const undone = await undoJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      "undo-happy",
    );
    expect(undone?.status).toBe("undone");
    expect((await undoJourneyRoutePointBatchForAtlas(
      owned.id,
      atlasA,
      "undo-happy",
    ))?.status).toBe("undone");
    const [restored] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, movedAsset.id));
    expect(restored.routePointId).toBe(originalPointId);
    expect((await db.select().from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.id, createdPointId!)))).toHaveLength(0);

    const expiryJourney = await journey(atlasA, "Expiry batch");
    const expiryAsset = await asset({ journeyId: expiryJourney.id });
    await applyJourneyRoutePointBatchForAtlas(
      expiryJourney.id,
      atlasA,
      batch("undo-expired", expiryJourney.revision, { assetId: expiryAsset.id }),
    );
    await db.update(journeyRoutePointBatchOperations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(journeyRoutePointBatchOperations.operationId, "undo-expired"));
    await expect(undoJourneyRoutePointBatchForAtlas(
      expiryJourney.id,
      atlasA,
      "undo-expired",
    )).rejects.toMatchObject({
      status: 410,
      code: "ROUTE_POINT_BATCH_UNDO_EXPIRED",
    } satisfies Partial<JourneyRoutePointBatchError>);
    expect((await getJourneyRoutePointBatchForAtlas(
      expiryJourney.id,
      atlasA,
      "undo-expired",
    ))?.undo).toMatchObject({ eligible: false, reason: "expired" });

    const editable = await getJourneyForAtlas(expiryJourney.id, atlasA);
    if (!editable) throw new Error("Expiry Journey disappeared");
    const afterExpiry = await updateJourneyForAtlas(expiryJourney.id, atlasA, {
      title: "Still editable",
      startedOn: editable.startedOn,
      endedOn: editable.endedOn,
      note: editable.note,
      lightColor: editable.lightColor,
      lightEffect: editable.lightEffect,
      revision: editable.revision,
      routePoints: editable.routePoints.map((point) => ({
        id: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        label: point.label,
        isStop: point.isStop,
        occurredAt: point.occurredAt,
        note: point.note,
        regionContext: point.regionContext,
        placeRole: point.placeRole,
        overviewVisibility: point.overviewVisibility,
        stayAnchorRoutePointId: point.stayAnchorRoutePointId,
      })),
    });
    expect(afterExpiry?.title).toBe("Still editable");

    const partialJourney = await journey(atlasA, "Partial undo");
    const partialAsset = await asset({ journeyId: partialJourney.id });
    const partialApply = await applyJourneyRoutePointBatchForAtlas(
      partialJourney.id,
      atlasA,
      batch("undo-partial", partialJourney.revision, { assetId: partialAsset.id }),
    );
    const partialPointId = partialApply?.receipt?.pointMappings[0]?.routePointId;
    expect(partialPointId).toBeTruthy();
    await asset({
      journeyId: partialJourney.id,
      routePointId: partialPointId!,
      sortOrder: 50,
      fileName: "later.jpg",
    });
    const partialUndo = await undoJourneyRoutePointBatchForAtlas(
      partialJourney.id,
      atlasA,
      "undo-partial",
    );
    expect(partialUndo).toMatchObject({
      status: "partially-undone",
      outcome: {
        status: "partial",
        conflicts: [{ kind: "route-point-referenced", id: partialPointId }],
      },
    });
    const [partialRestored] = await db.select().from(mediaAssets)
      .where(eq(mediaAssets.id, partialAsset.id));
    expect(partialRestored.routePointId).toBeNull();
    expect((await db.select().from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.id, partialPointId!)))).toHaveLength(1);
  });
});
