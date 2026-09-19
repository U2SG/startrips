import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  everydayFragments,
  mediaAssetEvidence,
  mediaAssets,
  mediaUploads,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { createJourneyForAtlas } from "../repositories/journey-repository";
import { disabledStorage } from "../storage/disabled-storage";
import type { MultipartStorage } from "../storage/multipart-storage";
import {
  finalizeUpload,
  reconcileUploadCandidates,
  type ReconciliationDependencies,
  type UploadRecord,
} from "../routes/uploads";

const TEST_ORIGIN = "http://127.0.0.1:5173";
const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

const baseJourney = {
  startedOn: "2026-09-01",
  endedOn: "2026-09-02",
  note: "private",
  lightColor: "#6c8fb7",
  routePoints: [
    {
      latitude: 22.543096,
      longitude: 114.057865,
      label: "Shenzhen",
      isStop: true,
      occurredAt: new Date("2026-09-01T00:00:00Z"),
    },
    {
      latitude: 22.3193,
      longitude: 114.1694,
      label: "Hong Kong",
      isStop: true,
      occurredAt: new Date("2026-09-02T00:00:00Z"),
    },
  ],
};

async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  await db.delete(rateLimit);
  const signUp = await app.request(`${TEST_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: label, email, password }),
  });
  expect(signUp.status).toBe(200);
  const token = await createEmailVerificationToken(serverConfig.authSecret, email);
  const verification = await app.request(
    `${TEST_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    { headers: authHeaders() },
  );
  expect(verification.status).toBe(200);

  const signIn = await app.request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();
  const { user } = await signIn.json() as { user: { id: string } };

  const orgResponse = await app.request(
    `${TEST_ORIGIN}/api/auth/organization/create`,
    {
      method: "POST",
      headers: authHeaders(cookie!),
      body: JSON.stringify({
        name: `${label} Atlas`,
        slug: `${label.toLowerCase()}-${randomUUID()}`,
      }),
    },
  );
  expect(orgResponse.status).toBe(200);
  const organization = await orgResponse.json() as { id: string };
  authOrganizationIds.push(organization.id);

  const bootstrap = await app.request(`${TEST_ORIGIN}/api/atlases/bootstrap`, {
    method: "POST",
    headers: authHeaders(cookie!),
    body: JSON.stringify({ title: `${label} Atlas`, dedication: "private" }),
  });
  expect([200, 201]).toContain(bootstrap.status);
  const payload = await bootstrap.json() as { atlas: { id: string } };
  atlasIds.push(payload.atlas.id);
  return { cookie: cookie!, userId: user.id, atlasId: payload.atlas.id };
}

/**
 * The document an accepted upload carries, in the wire shape the existing
 * `parseRecordedEvidenceWrite` normalizer defines. Its coordinates are
 * deliberately nowhere near the Journey's Route Points, so an assertion that
 * finds them has found the evidence and not the route.
 */
const TOKYO_EVIDENCE = {
  spatial: {
    source: "exif",
    granularity: "coordinate",
    latitude: 35.689487,
    longitude: 139.691711,
    accuracyMeters: 8,
    label: null,
  },
  captureTime: {
    source: "exif-original",
    timezone: "offset-known",
    local: "2026-09-01T18:30:00",
    instant: "2026-09-01T09:30:00.000Z",
    offsetMinutes: 540,
  },
} as const;

/** A second, clearly different document, where one must not overwrite another. */
const OSLO_EVIDENCE = {
  spatial: {
    source: "container-metadata",
    granularity: "city",
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    label: "Oslo",
  },
  captureTime: {
    source: "container-metadata",
    timezone: "local-only",
    local: "2026-09-02T11:00:00",
    instant: null,
    offsetMinutes: null,
  },
} as const;

let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let outsiderIdentity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let journeyId = "";
let secondJourneyId = "";
let routePointIds: string[] = [];

/**
 * A row in exactly the state `POST /api/uploads/start` leaves behind. The
 * `core` CI lane runs `STORAGE_DRIVER=disabled`, so the multipart half of the
 * pipeline cannot run here at all; the state it would have produced is written
 * directly, and every assertion below is about what finalization does with it.
 */
async function startedUpload(options: {
  recordedEvidence?: unknown;
  routePointId?: string | null;
  storageKey?: string;
  status?: string;
  bytes?: number;
} = {}) {
  const [upload] = await db.insert(mediaUploads).values({
    atlasId: identity.atlasId,
    journeyId,
    routePointId: options.routePointId ?? null,
    storageDriver: "disabled",
    storageKey: options.storageKey ?? `${identity.atlasId}/${journeyId}/${randomUUID()}`,
    providerUploadId: `provider-${randomUUID()}`,
    fileName: "still.jpg",
    mimeType: "image/jpeg",
    bytes: options.bytes ?? 2048,
    recordedEvidence: options.recordedEvidence ?? null,
    partSize: 8 * 1024 * 1024,
    partCount: 1,
    status: options.status ?? "initiated",
    createdByUserId: identity.userId,
  }).returning();
  return upload as UploadRecord;
}

function contentHash(seed: string) {
  return seed.repeat(64).slice(0, 64);
}

async function evidenceRowFor(assetId: string) {
  const [row] = await db
    .select()
    .from(mediaAssetEvidence)
    .where(eq(mediaAssetEvidence.mediaAssetId, assetId));
  return row;
}

beforeAll(async () => {
  identity = await createAuthenticatedAtlas("UploadEvidence");
  outsiderIdentity = await createAuthenticatedAtlas("UploadEvidenceOutsider");
  const journey = await createJourneyForAtlas(identity.atlasId, identity.userId, {
    ...baseJourney,
    title: "Evidence upload journey",
  });
  if (!journey) throw new Error("Journey fixture was not created");
  journeyId = journey.id;
  routePointIds = journey.routePoints.map((point) => point.id);

  const second = await createJourneyForAtlas(identity.atlasId, identity.userId, {
    ...baseJourney,
    title: "Second evidence journey",
  });
  if (!second) throw new Error("Second Journey fixture was not created");
  secondJourneyId = second.id;
});

afterAll(async () => {
  if (atlasIds.length) await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  if (authOrganizationIds.length) {
    await db.delete(authOrganizations)
      .where(inArray(authOrganizations.id, authOrganizationIds));
  }
  if (authUserEmails.length) {
    await db.delete(authUsers).where(inArray(authUsers.email, authUserEmails));
  }
  await pool.end();
});

describe("upload start validation", () => {
  it("refuses malformed evidence with the upload-family 400 and echoes no coordinates", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/uploads/start`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId,
        fileName: "still.jpg",
        mimeType: "image/jpeg",
        bytes: 2048,
        recordedEvidence: {
          ...TOKYO_EVIDENCE,
          spatial: { ...TOKYO_EVIDENCE.spatial, latitude: 991.5 },
        },
      }),
    });
    // 400 rather than the 503 a storage call raises under
    // STORAGE_DRIVER=disabled: the document is refused before any storage work.
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "INVALID_UPLOAD" });
    expect(body).not.toContain("991.5");
    expect(body).not.toContain("139.691711");
  });

  it("carries a well-formed document past validation into the storage call", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/uploads/start`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId,
        fileName: "still.jpg",
        mimeType: "image/jpeg",
        bytes: 2048,
        recordedEvidence: TOKYO_EVIDENCE,
      }),
    });
    // The lane has no storage backend, so the truthful end of this path is
    // STORAGE_UNAVAILABLE — only reachable because validation accepted the
    // evidence document instead of refusing the request.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "STORAGE_UNAVAILABLE",
    });
  });
});

describe("finalization attaches the evidence the upload carried", () => {
  it("writes the new asset and its evidence in one transaction", async () => {
    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      routePointId: routePointIds[0],
    });
    const asset = await finalizeUpload(upload, contentHash("1"));

    const row = await evidenceRowFor(asset.id);
    expect(row).toMatchObject({
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      latitude: 35.689487,
      longitude: 139.691711,
      accuracyMeters: 8,
      spatialLabel: null,
      captureTimeSource: "exif-original",
      timezoneState: "offset-known",
      capturedLocal: "2026-09-01T18:30:00",
      capturedOffsetMinutes: 540,
      displayHidden: false,
      correctionGranularity: null,
      revision: 1,
    });
    expect(row.capturedAtUtc?.toISOString()).toBe("2026-09-01T09:30:00.000Z");
  });

  it("commits neither the asset nor its evidence when finalization rolls back", async () => {
    // The storage key already names an asset of another Journey, so
    // finalization reaches its reconciliation guard and aborts the transaction
    // the asset and its evidence would both have been written in.
    const storageKey = `${identity.atlasId}/${journeyId}/${randomUUID()}`;
    const [blocking] = await db.insert(mediaAssets).values({
      journeyId: secondJourneyId,
      storageDriver: "disabled",
      storageKey,
      fileName: "blocking.jpg",
      mimeType: "image/jpeg",
      bytes: 2048,
      uploadedByUserId: identity.userId,
    }).returning({ id: mediaAssets.id });

    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      storageKey,
    });
    await expect(finalizeUpload(upload, contentHash("2"))).rejects.toThrow(
      /could not be reconciled/,
    );

    // Nothing the aborted transaction wrote survives it: the asset it tried to
    // create is absent, the storage key still names only the blocking asset,
    // and the upload was not marked completed. The evidence insert is the
    // second-to-last statement of that same transaction and no statement after
    // it can fail, so there is no reachable state where the asset commits
    // without it.
    const byKey = await db.select({ id: mediaAssets.id }).from(mediaAssets)
      .where(eq(mediaAssets.storageKey, storageKey));
    expect(byKey).toEqual([{ id: blocking.id }]);
    const [reread] = await db.select().from(mediaUploads)
      .where(eq(mediaUploads.id, upload.id));
    expect(reread.status).toBe("initiated");
    expect(reread.mediaAssetId).toBeNull();
  });

  it("refuses to finalize the bytes when it cannot read the stored document", async () => {
    const upload = await startedUpload({ recordedEvidence: TOKYO_EVIDENCE });
    // Unreachable for a row this pipeline wrote; asserted so the guard can
    // never silently degrade into an asset that lost the evidence it carried.
    await db.update(mediaUploads)
      .set({ recordedEvidence: { spatial: "here", captureTime: "then" } })
      .where(eq(mediaUploads.id, upload.id));
    const [poisoned] = await db.select().from(mediaUploads)
      .where(eq(mediaUploads.id, upload.id));

    await expect(
      finalizeUpload(poisoned as UploadRecord, contentHash("3")),
    ).rejects.toThrow(/recorded evidence document/);

    const assets = await db.select({ id: mediaAssets.id }).from(mediaAssets)
      .where(eq(mediaAssets.storageKey, upload.storageKey));
    expect(assets).toHaveLength(0);
  });

  it("writes no coordinate into any log line along the whole path", async () => {
    // `server/request-log.ts` logs the matched route PATTERN, status and
    // duration and never a body or a raw path, so the evidence document cannot
    // reach it; this holds every console channel to that, across a refused
    // start, an accepted start and a finalization.
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (channel) => vi.spyOn(console, channel).mockImplementation(() => {}),
    );
    try {
      for (const evidence of [
        { ...TOKYO_EVIDENCE, spatial: { ...TOKYO_EVIDENCE.spatial, latitude: 991.5 } },
        TOKYO_EVIDENCE,
      ]) {
        await app.request(`${TEST_ORIGIN}/api/uploads/start`, {
          method: "POST",
          headers: authHeaders(identity.cookie),
          body: JSON.stringify({
            journeyId,
            fileName: "still.jpg",
            mimeType: "image/jpeg",
            bytes: 2048,
            recordedEvidence: evidence,
          }),
        });
      }
      const upload = await startedUpload({ recordedEvidence: TOKYO_EVIDENCE });
      await finalizeUpload(upload, contentHash("d"));

      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((argument) => String(argument))
        .join(" ");
      for (const coordinate of ["35.689487", "139.691711", "991.5"]) {
        expect(logged).not.toContain(coordinate);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("leaves an upload without evidence exactly as it is today", async () => {
    const upload = await startedUpload({ routePointId: routePointIds[1] });
    const asset = await finalizeUpload(upload, contentHash("4"));
    expect(asset.contentHashVerified).toBe(true);
    expect(asset.routePointId).toBe(routePointIds[1]);
    expect(await evidenceRowFor(asset.id)).toBeUndefined();
  });
});

describe("dedupe, replay and recovery", () => {
  it("leaves an existing asset's evidence and revision unchanged on a deduplicated completion", async () => {
    const hash = contentHash("5");
    const first = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      routePointId: routePointIds[0],
    });
    const asset = await finalizeUpload(first, hash);
    const before = await evidenceRowFor(asset.id);

    const second = await startedUpload({
      recordedEvidence: OSLO_EVIDENCE,
      routePointId: routePointIds[0],
    });
    const deduplicated = await finalizeUpload(second, hash);
    expect(deduplicated.id).toBe(asset.id);

    expect(await evidenceRowFor(asset.id)).toEqual(before);
    expect(
      await db.select().from(mediaAssetEvidence)
        .where(eq(mediaAssetEvidence.mediaAssetId, asset.id)),
    ).toHaveLength(1);
  });

  it("does not add a second evidence row or move the revision when a completion is replayed", async () => {
    const upload = await startedUpload({ recordedEvidence: TOKYO_EVIDENCE });
    const asset = await finalizeUpload(upload, contentHash("6"));
    const before = await evidenceRowFor(asset.id);

    // The client never saw the first answer and completes the same upload again.
    const [reread] = await db.select().from(mediaUploads)
      .where(eq(mediaUploads.id, upload.id));
    const replayed = await finalizeUpload(reread as UploadRecord, contentHash("6"));
    expect(replayed.id).toBe(asset.id);
    expect(await evidenceRowFor(asset.id)).toEqual(before);
  });

  it("never rewrites the evidence of an asset the same storage key already named", async () => {
    // The lost-response case where the object landed and the asset was created
    // by an earlier attempt: finalization re-finds it by storage key rather
    // than by content hash, and its evidence has since been corrected by the
    // owner to revision 4.
    const storageKey = `${identity.atlasId}/${journeyId}/${randomUUID()}`;
    const [existing] = await db.insert(mediaAssets).values({
      journeyId,
      storageDriver: "disabled",
      storageKey,
      fileName: "still.jpg",
      mimeType: "image/jpeg",
      bytes: 2048,
      uploadedByUserId: identity.userId,
    }).returning({ id: mediaAssets.id });
    await db.insert(mediaAssetEvidence).values({
      mediaAssetId: existing.id,
      spatialSource: "container-metadata",
      spatialGranularity: "city",
      spatialLabel: "Oslo",
      captureTimeSource: "container-metadata",
      timezoneState: "local-only",
      capturedLocal: "2026-09-02T11:00:00",
      revision: 4,
    });
    const before = await evidenceRowFor(existing.id);

    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      storageKey,
    });
    const asset = await finalizeUpload(upload, contentHash("c"));
    expect(asset.id).toBe(existing.id);
    expect(await evidenceRowFor(existing.id)).toEqual(before);
  });

  it("attaches the same document when the response-lost path finalizes the upload", async () => {
    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      status: "completion_unknown",
    });
    // What `recoverCompletedUpload` does once it has re-read the object and
    // established its content identity: finalize that very same upload row.
    const asset = await finalizeUpload(upload, contentHash("7"));
    expect(await evidenceRowFor(asset.id)).toMatchObject({
      spatialSource: "exif",
      latitude: 35.689487,
      longitude: 139.691711,
      revision: 1,
    });
  });

  it("attaches the same document when stale reconciliation finalizes the upload", async () => {
    const hash = contentHash("8");
    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      status: "completion_unknown",
    });

    // `reconcileStaleUploads` returns immediately under STORAGE_DRIVER=disabled
    // because it has no configured backend to inspect. Its whole body is the
    // candidate query plus `reconcileUploadCandidates`, which takes the storage
    // and the finalizer as dependencies, so the reconciler path is exercised
    // here through that seam.
    const storage: MultipartStorage = {
      ...disabledStorage,
      driver: "disabled",
      async inspectObject() {
        return { exists: true as const, bytes: upload.bytes };
      },
      async hashObject() {
        return { exists: true as const, sha256: hash };
      },
    };
    const dependencies: ReconciliationDependencies = {
      async claim(candidate, attemptId) {
        const [claimed] = await db.update(mediaUploads)
          .set({
            status: "reconciling",
            completionAttemptId: attemptId,
            updatedAt: new Date(),
          })
          .where(eq(mediaUploads.id, candidate.id))
          .returning();
        return claimed;
      },
      storageForBackend: () => storage,
      finalize: finalizeUpload,
      async markAborted() {
        throw new Error("reconciliation aborted an upload whose object exists");
      },
      async markRetryable() {
        throw new Error("reconciliation gave up on a finalizable upload");
      },
      onError(_upload, error) {
        throw error;
      },
    };

    const now = new Date();
    await reconcileUploadCandidates(
      [upload],
      now,
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
      dependencies,
    );

    const [completed] = await db.select().from(mediaUploads)
      .where(eq(mediaUploads.id, upload.id));
    expect(completed.status).toBe("completed");
    expect(completed.mediaAssetId).not.toBeNull();
    expect(await evidenceRowFor(completed.mediaAssetId!)).toMatchObject({
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      latitude: 35.689487,
      longitude: 139.691711,
      capturedOffsetMinutes: 540,
      revision: 1,
    });
  });
});

describe("the evidence stays asset-owned and owner-only", () => {
  it("refuses a cross-Atlas read at the existing Atlas boundary", async () => {
    const upload = await startedUpload({ recordedEvidence: TOKYO_EVIDENCE });
    const asset = await finalizeUpload(upload, contentHash("9"));

    const owner = await app.request(
      `${TEST_ORIGIN}/api/media-evidence/${asset.id}`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({
      evidence: { recorded: { spatial: { latitude: 35.689487 } } },
    });

    const outsider = await app.request(
      `${TEST_ORIGIN}/api/media-evidence/${asset.id}`,
      { headers: authHeaders(outsiderIdentity.cookie) },
    );
    expect(outsider.status).toBe(404);
    expect(await outsider.text()).not.toContain("35.689487");
  });

  it("keeps the evidence row byte-identical when the asset is moved and reclassified", async () => {
    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      routePointId: routePointIds[0],
    });
    const asset = await finalizeUpload(upload, contentHash("a"));
    const before = await evidenceRowFor(asset.id);

    const ontoPoint = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId,
        assetIds: [asset.id],
        routePointId: routePointIds[1],
      }),
    });
    expect(ontoPoint.status).toBe(200);

    const acrossJourneys = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId,
        targetJourneyId: secondJourneyId,
        assetIds: [asset.id],
        routePointId: null,
      }),
    });
    expect(acrossJourneys.status).toBe(200);

    const [moved] = await db.select().from(mediaAssets)
      .where(eq(mediaAssets.id, asset.id));
    expect(moved.journeyId).toBe(secondJourneyId);
    expect(moved.routePointId).toBeNull();
    expect(await evidenceRowFor(asset.id)).toEqual(before);

    // Reclassified from Journey-owned to Everyday Fragment-owned: the evidence
    // is keyed by the asset, so changing who owns the asset cannot touch it.
    const [fragment] = await db.insert(everydayFragments).values({
      atlasId: identity.atlasId,
      occurredOn: "2026-09-03",
      latitude: 1.3521,
      longitude: 103.8198,
      placeLabel: "Singapore",
      createdByUserId: identity.userId,
    }).returning({ id: everydayFragments.id });
    await db.update(mediaAssets).set({
      journeyId: null,
      routePointId: null,
      everydayFragmentId: fragment.id,
    }).where(eq(mediaAssets.id, asset.id));

    expect(await evidenceRowFor(asset.id)).toEqual(before);
  });

  it("emits no evidence field in the guest share payload", async () => {
    const upload = await startedUpload({
      recordedEvidence: TOKYO_EVIDENCE,
      routePointId: routePointIds[0],
    });
    const asset = await finalizeUpload(upload, contentHash("b"));

    const created = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyIds: [journeyId],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(created.status).toBe(201);
    const { token } = await created.json() as { token: string };

    const guest = await app.request(`${TEST_ORIGIN}/api/shared/journeys`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(guest.status).toBe(200);
    const body = await guest.text();
    expect(body).toContain(asset.id);
    for (const absent of [
      "recordedEvidence",
      "spatialSource",
      "captureTime",
      "35.689487",
      "139.691711",
    ]) {
      expect(body).not.toContain(absent);
    }
  });
});
