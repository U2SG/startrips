import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, mediaAssets } from "../db/app-schema";
import {
  organization as authOrganizations,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { PREVIEW_MIME_TYPE } from "../media/preview-derivation";
import {
  createJourneyForAtlas,
  deferJourneyDeletionRetryForAtlas,
  deleteJourneyForAtlas,
  getJourneyDeletionCandidateForAtlas,
  getJourneyForAtlas,
  listJourneysPendingDeletion,
  markJourneyForDeletionForAtlas,
  restoreJourneyForAtlas,
} from "../repositories/journey-repository";
import { signPrivateMediaRead } from "../routes/uploads";
import { deleteMediaAssetForAtlas } from "../services/delete-media";
import { reconcileJourneyDeletionCandidates } from "../services/delete-journey";
import {
  beginAssetPreview,
  completeAssetPreview,
} from "../services/media-preview";
import { disabledStorage } from "../storage/disabled-storage";
import type { MultipartStorage } from "../storage/multipart-storage";

const TEST_ORIGIN = "http://127.0.0.1:5173";
const UPLOAD_TTL_SECONDS = 900;
const CEILINGS = {
  maxEdgePixels: serverConfig.mediaPreviewMaxEdgePixels,
  maxBytes: serverConfig.mediaPreviewMaxBytes,
};

const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];

const baseJourney = {
  startedOn: "2026-08-11",
  endedOn: "2026-08-12",
  note: "private",
  lightColor: "#f4ce73",
  routePoints: [
    {
      latitude: 1.3521,
      longitude: 103.8198,
      label: "Singapore",
      isStop: true,
      occurredAt: new Date("2026-08-11T00:00:00Z"),
    },
    {
      latitude: 35.6762,
      longitude: 139.6503,
      label: "Tokyo",
      isStop: true,
      occurredAt: new Date("2026-08-12T00:00:00Z"),
    },
  ],
};

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

/**
 * One verified identity with an Atlas, created the way the product creates
 * one. Modelled on the fixture in `share-grants.integration.test.ts`; each
 * integration file owns its own so no test depends on another file's order.
 */
async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  const signUp = await app.request(`${TEST_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: label, email, password }),
  });
  expect(signUp.status).toBe(200);

  const verificationToken = await createEmailVerificationToken(
    serverConfig.authSecret,
    email,
  );
  const verification = await app.request(
    `${TEST_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`,
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

  const organizationResponse = await app.request(
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
  expect(organizationResponse.status).toBe(200);
  const organization = await organizationResponse.json() as { id: string };
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
 * A storage adapter that records what it was asked to sign, inspect and
 * delete, and answers exactly what the case under test needs.
 *
 * The `core` lane runs with `STORAGE_DRIVER=disabled`, so this is how the
 * derived-object behaviour is exercised at all: the real registry has no
 * backend and every route that reaches it degrades truthfully to 503, which
 * is itself asserted below.
 */
function recordingStorage(overrides: Partial<MultipartStorage> = {}) {
  const signedReads: Array<{ key: string; expiresInSeconds: number }> = [];
  const deleted: string[] = [];
  const storage: MultipartStorage = {
    ...disabledStorage,
    driver: "s3",
    async signObjectUpload(input) {
      return {
        url: `https://storage.test/put/${encodeURIComponent(input.key)}`,
        headers: { "content-type": input.mimeType },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
    async inspectObject() {
      return { exists: true, bytes: 48_000 };
    },
    async deleteObject(input) {
      deleted.push(input.key);
    },
    async createPrivateReadUrl(input) {
      signedReads.push(input);
      return {
        url: `https://storage.test/${encodeURIComponent(input.key)}`,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
    ...overrides,
  };
  return {
    signedReads,
    deleted,
    resolve: () => storage,
    storage,
  };
}

describe("#260 same-asset preview for private media reads", () => {
  let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
  let journeyId = "";
  let routePointIds: string[] = [];

  /**
   * Asset rows are written straight in: without a storage driver there is no
   * reachable upload path, and every case here is about the columns and the
   * derived object rather than about multipart mechanics.
   */
  async function insertAsset(
    mimeType = "image/jpeg",
    routePointId: string | null = null,
  ) {
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId,
        routePointId,
        storageDriver: "s3",
        storageKey: `preview-tests/${randomUUID()}/original`,
        fileName: "route-point-media.jpg",
        mimeType,
        bytes: 4_194_304,
        uploadedByUserId: identity.userId,
      })
      .returning();
    return asset;
  }

  async function readAsset(assetId: string) {
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    return asset;
  }

  /** The two-step derivation, run end to end against an injected backend. */
  async function deriveReadyPreview(
    assetId: string,
    backend = recordingStorage(),
    source = { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 6 },
  ) {
    const begun = await beginAssetPreview(
      await readAsset(assetId),
      identity.atlasId,
      source,
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );
    expect(begun.ok).toBe(true);
    const completed = await completeAssetPreview(
      await readAsset(assetId),
      CEILINGS,
      { storageForBackend: backend.resolve },
    );
    expect(completed.ok).toBe(true);
    return { begun, completed };
  }

  beforeAll(async () => {
    identity = await createAuthenticatedAtlas("preview");
    const journey = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, title: "Journey holding preview media" },
    );
    if (!journey) throw new Error("Journey fixture was not created");
    journeyId = journey.id;
    routePointIds = journey.routePoints.map((point) => point.id);
    expect(routePointIds.length).toBe(2);
  });

  afterAll(async () => {
    if (atlasIds.length) {
      await db.delete(atlases).where(inArray(atlases.id, atlasIds));
    }
    if (authOrganizationIds.length) {
      await db
        .delete(authOrganizations)
        .where(inArray(authOrganizations.id, authOrganizationIds));
    }
    if (authUserEmails.length) {
      await db.delete(authUsers).where(inArray(authUsers.email, authUserEmails));
    }
    await pool.end();
  });

  it("plans the preview from the ceilings in server/config.ts", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    const begun = await beginAssetPreview(
      asset,
      identity.atlasId,
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 6 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );

    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // The pinned 6000x4000 portrait source, measured against both configured
    // ceilings. Neither is a literal here: they come from the config the
    // deployment actually loads.
    expect(Math.max(begun.preview.width, begun.preview.height))
      .toBeLessThanOrEqual(serverConfig.mediaPreviewMaxEdgePixels);
    expect(begun.preview.maxBytes).toBe(serverConfig.mediaPreviewMaxBytes);
    expect(begun.preview.mimeType).toBe(PREVIEW_MIME_TYPE);
    // Orientation 6 is a quarter turn, so the display size is the transpose.
    expect(begun.preview.displayWidth).toBe(4000);
    expect(begun.preview.displayHeight).toBe(6000);

    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("pending");
    expect(stored.displayWidth).toBe(4000);
    expect(stored.displayHeight).toBe(6000);
    expect(stored.previewStorageKey).toBeTruthy();
    expect(stored.previewBytes).toBeNull();
  });

  it("adds a preview block under the same asset id once one is ready", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    await deriveReadyPreview(asset.id, backend);
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("ready");
    expect(stored.previewBytes).toBe(48_000);

    backend.signedReads.length = 0;
    const read = await signPrivateMediaRead(
      stored,
      serverConfig.mediaReadUrlExpiresInSeconds,
      backend.resolve,
    );

    expect(read.url).toContain(encodeURIComponent(stored.storageKey));
    expect(read.preview).toBeDefined();
    expect(read.preview!.url)
      .toContain(encodeURIComponent(stored.previewStorageKey!));
    expect(read.preview!.mimeType).toBe(PREVIEW_MIME_TYPE);
    // The display size, so the preview and the original fill one frame.
    expect(read.preview!.width).toBe(4000);
    expect(read.preview!.height).toBe(6000);
    // Both signatures asked for the owner lifetime, and nothing else was
    // signed under this asset.
    expect(backend.signedReads.map((read) => read.expiresInSeconds)).toEqual([
      serverConfig.mediaReadUrlExpiresInSeconds,
      serverConfig.mediaReadUrlExpiresInSeconds,
    ]);
    expect(Object.keys(read).sort()).toEqual(["expiresAt", "preview", "url"]);
  });

  it("omits the block when no preview was ever derived", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    const read = await signPrivateMediaRead(asset, 900, backend.resolve);

    expect(asset.previewState).toBe("none");
    expect(read.preview).toBeUndefined();
    expect(Object.keys(read).sort()).toEqual(["expiresAt", "url"]);
    expect(read.url).toContain(encodeURIComponent(asset.storageKey));
    expect(backend.signedReads).toHaveLength(1);
  });

  it("omits the block while derivation is still running", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    await beginAssetPreview(
      asset,
      identity.atlasId,
      { sourceWidth: 4000, sourceHeight: 3000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );

    const pending = await readAsset(asset.id);
    expect(pending.previewState).toBe("pending");
    expect(pending.previewStorageKey).toBeTruthy();

    backend.signedReads.length = 0;
    const read = await signPrivateMediaRead(pending, 900, backend.resolve);
    expect(read.preview).toBeUndefined();
    expect(read.url).toBeTruthy();
    // A pending derived key is never signed, not even speculatively.
    expect(backend.signedReads.map((entry) => entry.key))
      .toEqual([pending.storageKey]);
  });

  it("omits the block when derivation failed, and keeps the original readable", async () => {
    // A soundtrack has no still to derive, which is the explicit degradation
    // #260 asks for rather than a blocked save or an invented image.
    const asset = await insertAsset("audio/mpeg");
    const backend = recordingStorage();
    const begun = await beginAssetPreview(
      asset,
      identity.atlasId,
      { sourceWidth: 1, sourceHeight: 1, exifOrientation: null },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );

    expect(begun).toMatchObject({
      ok: false,
      error: "PREVIEW_UNSUPPORTED",
      status: 409,
    });
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(stored.previewStorageKey).toBeNull();

    const read = await signPrivateMediaRead(stored, 900, backend.resolve);
    expect(read.preview).toBeUndefined();
    expect(read.url).toContain(encodeURIComponent(stored.storageKey));
  });

  it("refuses a produced object over the byte ceiling and serves no preview", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage({
      async inspectObject() {
        return {
          exists: true,
          bytes: serverConfig.mediaPreviewMaxBytes + 1,
        };
      },
    });
    await beginAssetPreview(
      asset,
      identity.atlasId,
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );
    const pending = await readAsset(asset.id);
    const oversizedKey = pending.previewStorageKey!;

    const completed = await completeAssetPreview(pending, CEILINGS, {
      storageForBackend: backend.resolve,
    });

    expect(completed).toMatchObject({ ok: false, error: "PREVIEW_TOO_LARGE" });
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(stored.previewStorageKey).toBeNull();
    // The object that broke the ceiling is not left behind either.
    expect(backend.deleted).toContain(oversizedKey);
    const read = await signPrivateMediaRead(stored, 900, backend.resolve);
    expect(read.preview).toBeUndefined();
  });

  it("keeps a write that never landed retryable instead of failing it", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage({
      async inspectObject() {
        return { exists: false };
      },
    });
    await beginAssetPreview(
      asset,
      identity.atlasId,
      { sourceWidth: 2000, sourceHeight: 1000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );

    const completed = await completeAssetPreview(
      await readAsset(asset.id),
      CEILINGS,
      { storageForBackend: backend.resolve },
    );

    expect(completed).toMatchObject({
      ok: false,
      error: "PREVIEW_OBJECT_MISSING",
    });
    // Still pending, not failed: a retryable fault must not become a
    // permanent loss.
    expect((await readAsset(asset.id)).previewState).toBe("pending");
  });

  it("replaces a previous derived object rather than orphaning it", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    await deriveReadyPreview(asset.id, backend);
    const first = await readAsset(asset.id);

    await deriveReadyPreview(asset.id, backend);
    const second = await readAsset(asset.id);

    expect(second.previewStorageKey).not.toBe(first.previewStorageKey);
    expect(second.previewState).toBe("ready");
    // The key no row references any more is gone from storage.
    expect(backend.deleted).toContain(first.previewStorageKey);
    expect(backend.deleted).not.toContain(second.previewStorageKey);
  });

  it("carries no EXIF, GPS or local file path into the derived resource", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    await deriveReadyPreview(asset.id, backend);
    const stored = await readAsset(asset.id);
    const read = await signPrivateMediaRead(stored, 900, backend.resolve);

    // The derived key is opaque: it names the Atlas and Journey that own it
    // and nothing about the file it came from.
    expect(stored.previewStorageKey).not.toContain(stored.fileName);
    expect(stored.previewStorageKey).not.toContain("route-point-media");
    expect(stored.previewStorageKey!.startsWith(
      `${identity.atlasId}/${journeyId}/previews/`,
    )).toBe(true);
    // The block is exactly the five agreed fields, so no capture time, no
    // coordinates and no source path can ride along inside it.
    expect(Object.keys(read.preview!).sort()).toEqual([
      "expiresAt",
      "height",
      "mimeType",
      "url",
      "width",
    ]);
    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain(stored.fileName);
    expect(serialized).not.toContain("1.3521");
    expect(serialized).not.toContain("103.8198");
  });

  it("degrades truthfully when STORAGE_DRIVER is disabled", async () => {
    // The deployed default in the `core` lane. The original read answered a
    // structured 503 before #260 and answers exactly the same one now,
    // whether or not the asset carries a preview.
    expect(serverConfig.storageDriver).toBe("disabled");
    const plain = await insertAsset();
    const withPreview = await insertAsset();
    await deriveReadyPreview(withPreview.id);

    const bodies: string[] = [];
    for (const asset of [plain, withPreview]) {
      const response = await app.request(
        `${TEST_ORIGIN}/api/uploads/assets/${asset.id}/read-url`,
        { headers: authHeaders(identity.cookie) },
      );
      expect(response.status).toBe(503);
      bodies.push(await response.text());
    }
    expect(JSON.parse(bodies[0]).error).toBe("STORAGE_UNAVAILABLE");
    // Byte-identical: a preview neither adds a failure mode nor changes one.
    expect(bodies[1]).toBe(bodies[0]);
    // No placeholder bytes and no fake ready state anywhere in the answer.
    expect(bodies[1]).not.toContain("preview");
  });

  it("takes the derived object with the media when the media is deleted", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    await deriveReadyPreview(asset.id, backend);
    const stored = await readAsset(asset.id);
    backend.deleted.length = 0;

    const deleted = await deleteMediaAssetForAtlas(asset.id, identity.atlasId, {
      async findAsset(assetId) {
        return await readAsset(assetId);
      },
      storageForBackend: backend.resolve,
      async deleteRow(assetId) {
        await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId));
      },
    });

    expect(deleted).toBe(true);
    expect(backend.deleted.sort()).toEqual(
      [stored.previewStorageKey!, stored.storageKey].sort(),
    );
    expect(await readAsset(asset.id)).toBeUndefined();
  });

  it("keeps the preview across a soft delete and restore, and clears it on the hard delete", async () => {
    const doomed = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, startedOn: "2026-09-03", title: "Doomed preview journey" },
    );
    if (!doomed) throw new Error("Journey fixture was not created");
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId: doomed.id,
        storageDriver: "s3",
        storageKey: `preview-tests/${randomUUID()}/doomed`,
        fileName: "doomed.jpg",
        mimeType: "image/jpeg",
        bytes: 2048,
        uploadedByUserId: identity.userId,
      })
      .returning();
    const backend = recordingStorage();
    const begun = await beginAssetPreview(
      asset,
      identity.atlasId,
      { sourceWidth: 3000, sourceHeight: 2000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      { storageForBackend: backend.resolve },
    );
    expect(begun.ok).toBe(true);
    await completeAssetPreview(await readAsset(asset.id), CEILINGS, {
      storageForBackend: backend.resolve,
    });
    const ready = await readAsset(asset.id);

    // Soft delete then restore: the grace window is a recovery path, so the
    // derived object has to survive it intact.
    expect(await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId))
      .toBeTruthy();
    expect(await restoreJourneyForAtlas(doomed.id, identity.atlasId))
      .toBeTruthy();
    const restored = await readAsset(asset.id);
    expect(restored.previewState).toBe("ready");
    expect(restored.previewStorageKey).toBe(ready.previewStorageKey);
    expect(await getJourneyForAtlas(doomed.id, identity.atlasId))
      .toBeTruthy();

    // The hard deletion after the grace window takes both objects.
    await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId);
    const candidate = await getJourneyDeletionCandidateForAtlas(
      doomed.id,
      identity.atlasId,
    );
    expect(candidate?.media[0].previewStorageKey)
      .toBe(ready.previewStorageKey);
    backend.deleted.length = 0;
    await reconcileJourneyDeletionCandidates(
      [{ id: doomed.id, atlasId: identity.atlasId }],
      {
        markForDeletion: markJourneyForDeletionForAtlas,
        getCandidate: getJourneyDeletionCandidateForAtlas,
        deleteJourney: deleteJourneyForAtlas,
        deferRetry: deferJourneyDeletionRetryForAtlas,
        listPending: listJourneysPendingDeletion,
        storageForBackend: backend.resolve,
        onCleanupError: vi.fn(),
      },
    );
    expect(backend.deleted.sort()).toEqual(
      [ready.previewStorageKey!, ready.storageKey].sort(),
    );
    expect(await readAsset(asset.id)).toBeUndefined();
  });

  it("keeps one derived object when media moves to another Route Point", async () => {
    const asset = await insertAsset("image/jpeg", routePointIds[0]);
    const backend = recordingStorage();
    await deriveReadyPreview(asset.id, backend);
    const before = await readAsset(asset.id);
    backend.deleted.length = 0;

    const move = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId,
        routePointId: routePointIds[1],
        assetIds: [asset.id],
      }),
    });
    expect(move.status).toBe(200);

    const after = await readAsset(asset.id);
    expect(after.routePointId).toBe(routePointIds[1]);
    // Same asset id, same derived object, still ready: reassignment is not a
    // re-derivation, and it strands nothing.
    expect(after.previewStorageKey).toBe(before.previewStorageKey);
    expect(after.previewState).toBe("ready");
    expect(backend.deleted).toHaveLength(0);
    const read = await signPrivateMediaRead(after, 900, backend.resolve);
    expect(read.preview!.url)
      .toContain(encodeURIComponent(after.previewStorageKey!));
  });

  it("omits an unsignable preview rather than failing the original read", async () => {
    const asset = await insertAsset();
    const ready = recordingStorage();
    await deriveReadyPreview(asset.id, ready);
    const stored = await readAsset(asset.id);

    const brokenPreview = recordingStorage({
      async createPrivateReadUrl(input) {
        if (input.key === stored.previewStorageKey) {
          throw new Error("derived object unreachable");
        }
        return {
          url: `https://storage.test/${encodeURIComponent(input.key)}`,
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        };
      },
    });
    const read = await signPrivateMediaRead(stored, 900, brokenPreview.resolve);

    expect(read.preview).toBeUndefined();
    expect(read.url).toContain(encodeURIComponent(stored.storageKey));
  });
});
