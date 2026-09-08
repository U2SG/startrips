import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, mediaAssets, mediaPreviewWrites } from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { PREVIEW_MIME_TYPE } from "../media/preview-derivation";
import { readJpegPixelSize } from "../media/preview-image";
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
import { signSharedMediaRead } from "../routes/shares";
import { signPrivateMediaRead } from "../routes/uploads";
import { deleteMediaAssetForAtlas } from "../services/delete-media";
import { reconcileJourneyDeletionCandidates } from "../services/delete-journey";
import {
  beginAssetPreview,
  completeAssetPreview,
  PREVIEW_KEY_PREFIX,
  reconcilePreviewNamespace,
  reconcilePreviewWrites,
  type PreviewSourceValues,
} from "../services/media-preview";
import { disabledStorage } from "../storage/disabled-storage";
import type { MultipartStorage } from "../storage/multipart-storage";

const TEST_ORIGIN = "http://127.0.0.1:5173";
const UPLOAD_TTL_SECONDS = serverConfig.mediaPreviewUploadExpiresInSeconds;
const CEILINGS = {
  maxEdgePixels: serverConfig.mediaPreviewMaxEdgePixels,
  maxBytes: serverConfig.mediaPreviewMaxBytes,
};

/**
 * The pinned inputs for the ceiling checks: two real JPEGs, one inside the
 * shipped 640 px / 512 KiB ceilings and one over the pixel ceiling while
 * staying under the byte ceiling, so each ceiling can be failed on its own.
 *
 * A produced preview is written by a producer this deployment does not
 * contain, so a test cannot rasterise one. What it can do — and what #260
 * asks for — is put real bytes under the key a producer was handed and assert
 * the ceilings against the object that is then read back out of storage.
 */
const PRODUCED_PREVIEW = new Uint8Array(readFileSync(
  new URL("./fixtures/derived-preview-600x467.jpg", import.meta.url),
));
const OVERSIZED_STILL = new Uint8Array(readFileSync(
  new URL("./fixtures/oversized-still-2048x1024.jpg", import.meta.url),
));

/**
 * #265: the source whose plan IS the pinned still, so a successful completion
 * models a producer that did what it was asked.
 *
 * Orientation 6 is a quarter turn, so a 467x600 source displays as 600x467,
 * which is inside the 640 px ceiling and is therefore planned at its own size
 * — exactly the frame `derived-preview-600x467.jpg` encodes. Every case below
 * that expects `ready` derives from this, because completion now checks the
 * produced frame against the plan and not only against the ceiling: a fixture
 * unrelated to the plan would be refused, and rightly.
 */
const SOURCE_OF_PRODUCED_PREVIEW = {
  sourceWidth: 467,
  sourceHeight: 600,
  exifOrientation: 6,
} as const;

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
  // `/sign-up/email` allows five attempts per address per ten minutes, and the
  // other integration files have already spent most of that budget by the time
  // this one runs, so a fresh identity here would answer 429 rather than 200.
  // The counters a previous FILE left behind are cleared; the product limit
  // itself is untouched, the key format is not assumed, and this file still
  // creates exactly one identity.
  await db.delete(rateLimit);
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
function recordingStorage(
  overrides: Partial<MultipartStorage> = {},
  producedBody: Uint8Array = PRODUCED_PREVIEW,
) {
  const signedReads: Array<{ key: string; expiresInSeconds: number }> = [];
  const deleted: string[] = [];
  /**
   * What is actually stored, keyed by key. Real bytes, because the completion
   * path reads the object back to establish its pixel size: a stub that
   * answered a fixed size, or answered the same body whatever it was asked
   * for, would assert nothing about the object that landed.
   */
  const objects = new Map<string, Uint8Array>();
  const storage: MultipartStorage = {
    ...disabledStorage,
    driver: "s3",
    async signObjectUpload(input) {
      // The producer writing to the URL it was just handed, modelled as the
      // one thing a producer does. A case that needs a write NOT to land, or
      // to land late, overrides this or writes to `objects` itself.
      objects.set(input.key, producedBody);
      return {
        url: `https://storage.test/put/${encodeURIComponent(input.key)}`,
        headers: { "content-type": input.mimeType },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
    async inspectObject(input) {
      const stored = objects.get(input.key);
      return stored
        ? { exists: true as const, bytes: stored.byteLength }
        : { exists: false as const };
    },
    async readObjectHead(input) {
      const stored = objects.get(input.key);
      // The window is honoured, so a case cannot pass by being handed bytes
      // the real adapter would have left on the provider.
      return stored
        ? { exists: true as const, bytes: stored.subarray(0, input.maxBytes) }
        : { exists: false as const };
    },
    async listObjects(input) {
      return {
        keys: [...objects.keys()].filter((key) => key.startsWith(input.prefix)),
      };
    },
    async deleteObject(input) {
      deleted.push(input.key);
      objects.delete(input.key);
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
    objects,
    resolve: () => storage,
    storage,
    /** Both seams the preview service takes, pointed at this one backend. */
    dependencies: {
      storageForBackend: () => storage,
      configuredStorage: () => storage,
    },
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
    source: PreviewSourceValues = SOURCE_OF_PRODUCED_PREVIEW,
  ) {
    const begun = await beginAssetPreview(
      await readAsset(assetId),
      source,
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    expect(begun.ok).toBe(true);
    const completed = await completeAssetPreview(
      await readAsset(assetId),
      CEILINGS,
      backend.dependencies,
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
    // Nothing ties a preview write record to the Atlas — that is the point of
    // the table — so the fixture retires its own rather than waiting for a
    // cascade that will never reach them. This file is the only one that
    // derives previews, so the whole namespace is its own.
    await db
      .delete(mediaPreviewWrites)
      .where(like(mediaPreviewWrites.storageKey, `${PREVIEW_KEY_PREFIX}%`));
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
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 6 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
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
    expect(stored.previewBytes).toBe(PRODUCED_PREVIEW.byteLength);

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
    expect(read.preview!.width).toBe(600);
    expect(read.preview!.height).toBe(467);
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
      { sourceWidth: 4000, sourceHeight: 3000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
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
      { sourceWidth: 1, sourceHeight: 1, exifOrientation: null },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
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

  it("verifies the produced object against both configured ceilings", async () => {
    // Acceptance item 6, against the object rather than against the plan: a
    // pinned real JPEG is written to the key the producer was handed, the
    // asset is completed, and the ceilings are then asserted on the bytes
    // read back out of storage. Neither ceiling is a literal here — both come
    // from the config this deployment loads.
    const asset = await insertAsset();
    const backend = recordingStorage();
    await deriveReadyPreview(asset.id, backend);
    const stored = await readAsset(asset.id);

    const landed = await backend.storage.readObjectHead({
      key: stored.previewStorageKey!,
      maxBytes: serverConfig.mediaPreviewMaxBytes,
    });
    expect(landed.exists).toBe(true);
    if (!landed.exists) return;

    expect(landed.bytes.byteLength)
      .toBeLessThanOrEqual(serverConfig.mediaPreviewMaxBytes);
    const pixels = readJpegPixelSize(landed.bytes);
    expect(pixels).not.toBeNull();
    expect(Math.max(pixels!.width, pixels!.height))
      .toBeLessThanOrEqual(serverConfig.mediaPreviewMaxEdgePixels);
    // The recorded size is the measured one, so a reader is told what is
    // actually stored.
    expect(stored.previewBytes).toBe(landed.bytes.byteLength);
    expect(stored.previewState).toBe("ready");
  });

  it("refuses a produced still over the pixel ceiling and serves no preview", async () => {
    // A real 2048x1024 JPEG that is comfortably under the byte ceiling, so
    // the only thing it breaks is the pixel one. Before the object could be
    // read back this was unreachable: the size the plan asked for was the
    // only number anything had.
    const asset = await insertAsset();
    const backend = recordingStorage({}, OVERSIZED_STILL);
    expect(OVERSIZED_STILL.byteLength)
      .toBeLessThan(serverConfig.mediaPreviewMaxBytes);

    const begun = await beginAssetPreview(
      await readAsset(asset.id),
      { sourceWidth: 6000, sourceHeight: 3000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    expect(begun.ok).toBe(true);
    const pending = await readAsset(asset.id);
    const oversizedKey = pending.previewStorageKey!;

    const completed = await completeAssetPreview(
      pending,
      CEILINGS,
      backend.dependencies,
    );

    expect(completed).toMatchObject({
      ok: false,
      error: "PREVIEW_PIXELS_TOO_LARGE",
    });
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(stored.previewStorageKey).toBeNull();
    // The oversized object is gone rather than left unreferenced.
    expect(backend.deleted).toContain(oversizedKey);
    expect(backend.objects.has(oversizedKey)).toBe(false);
    // The original is untouched and still reads.
    const read = await signPrivateMediaRead(stored, 900, backend.resolve);
    expect(read.preview).toBeUndefined();
    expect(read.url).toContain(encodeURIComponent(stored.storageKey));
  });

  it("refuses a still larger than the planned frame and serves no preview", async () => {
    // #265, acceptance item 6. The pinned 600x467 still against a plan for a
    // 400x300 one: inside the 640 px ceiling, inside the byte ceiling, and
    // still not what this asset was asked for. A presigned PUT binds only the
    // content type, so this is exactly the frame a producer holding the URL
    // could write, and before the plan was checked it would have been served.
    const asset = await insertAsset();
    const backend = recordingStorage();
    expect(PRODUCED_PREVIEW.byteLength)
      .toBeLessThan(serverConfig.mediaPreviewMaxBytes);

    const begun = await beginAssetPreview(
      await readAsset(asset.id),
      { sourceWidth: 400, sourceHeight: 300, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // The plan is smaller than the still in both directions, and both are
    // under the ceiling — so the ceiling cannot be what refuses this.
    expect(begun.preview).toMatchObject({ width: 400, height: 300 });
    expect(Math.max(600, 467))
      .toBeLessThanOrEqual(serverConfig.mediaPreviewMaxEdgePixels);
    const pending = await readAsset(asset.id);
    const unplannedKey = pending.previewStorageKey!;

    const completed = await completeAssetPreview(
      pending,
      CEILINGS,
      backend.dependencies,
    );

    expect(completed).toMatchObject({
      ok: false,
      error: "PREVIEW_PIXELS_MISMATCH",
      status: 409,
    });
    // The same clearing the byte and pixel ceilings do: the generation is
    // cleared under its own key and the object is dropped, not orphaned.
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(stored.previewStorageKey).toBeNull();
    expect(stored.previewBytes).toBeNull();
    expect(backend.deleted).toContain(unplannedKey);
    expect(backend.objects.has(unplannedKey)).toBe(false);

    // Neither read path offers a preview afterwards, and the original is
    // untouched in both.
    const ownerRead = await signPrivateMediaRead(stored, 900, backend.resolve);
    expect(ownerRead.preview).toBeUndefined();
    expect(ownerRead.url).toContain(encodeURIComponent(stored.storageKey));
    const guestRead = await signSharedMediaRead(
      {
        storageDriver: stored.storageDriver,
        storageKey: stored.storageKey,
        preview: stored,
        grantExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        shareTtlSeconds: serverConfig.shareMediaReadUrlExpiresInSeconds,
        ownerTtlSeconds: serverConfig.mediaReadUrlExpiresInSeconds,
      },
      new Date(),
      backend.resolve,
    );
    expect(guestRead.preview).toBeUndefined();
    expect(guestRead.url).toContain(encodeURIComponent(stored.storageKey));
  });

  it("promotes a still that matches the planned frame, at its measured size", async () => {
    // The other half of acceptance item 6: a producer that wrote exactly the
    // frame it was handed a spec for is promoted, and the size recorded is the
    // one measured from storage rather than any number it claimed.
    const asset = await insertAsset();
    const backend = recordingStorage();
    const begun = await beginAssetPreview(
      await readAsset(asset.id),
      SOURCE_OF_PRODUCED_PREVIEW,
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.preview).toMatchObject({ width: 600, height: 467 });

    const completed = await completeAssetPreview(
      await readAsset(asset.id),
      CEILINGS,
      backend.dependencies,
    );

    expect(completed).toMatchObject({ ok: true });
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("ready");
    expect(stored.previewBytes).toBe(PRODUCED_PREVIEW.byteLength);
    // The frame that was promoted is the frame that was planned.
    expect(readJpegPixelSize(backend.objects.get(stored.previewStorageKey!)!))
      .toEqual({ width: 600, height: 467 });
  });

  it("refuses a produced still whose row cannot state what was planned", async () => {
    // A `pending` row always carries the display size `POST .../preview` wrote,
    // so this is a contradiction rather than an expected state. It is asserted
    // because the answer to a contradiction has to be fail-closed: nothing can
    // be verified against a plan that cannot be recovered, and an unverified
    // object must not become servable to a guest.
    const asset = await insertAsset();
    const backend = recordingStorage();
    await beginAssetPreview(
      await readAsset(asset.id),
      SOURCE_OF_PRODUCED_PREVIEW,
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    await db
      .update(mediaAssets)
      .set({ displayWidth: null, displayHeight: null })
      .where(eq(mediaAssets.id, asset.id));

    const completed = await completeAssetPreview(
      await readAsset(asset.id),
      CEILINGS,
      backend.dependencies,
    );

    expect(completed).toMatchObject({
      ok: false,
      error: "PREVIEW_PIXELS_MISMATCH",
    });
    expect((await readAsset(asset.id)).previewState).toBe("failed");
  });

  it("refuses bytes that are not a readable still", async () => {
    // A producer that wrote something, but not the still it was asked for.
    // Unreadable is a decided outcome, not a retry: nothing can establish a
    // frame size for it, so it can never be shown to a reader.
    const asset = await insertAsset();
    const backend = recordingStorage({}, new Uint8Array([1, 2, 3, 4, 5]));

    await beginAssetPreview(
      await readAsset(asset.id),
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    const pending = await readAsset(asset.id);
    const unreadableKey = pending.previewStorageKey!;

    const completed = await completeAssetPreview(
      pending,
      CEILINGS,
      backend.dependencies,
    );

    expect(completed).toMatchObject({
      ok: false,
      error: "PREVIEW_UNREADABLE",
    });
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(backend.deleted).toContain(unreadableKey);
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
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    const pending = await readAsset(asset.id);
    const oversizedKey = pending.previewStorageKey!;

    const completed = await completeAssetPreview(pending, CEILINGS, backend.dependencies);

    expect(completed).toMatchObject({ ok: false, error: "PREVIEW_TOO_LARGE" });
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(stored.previewStorageKey).toBeNull();
    // The object that broke the ceiling is not left behind either.
    expect(backend.deleted).toContain(oversizedKey);
    const read = await signPrivateMediaRead(stored, 900, backend.resolve);
    expect(read.preview).toBeUndefined();
  });

  it("lets exactly one of two concurrent derivations own the row", async () => {
    const asset = await insertAsset();
    const backend = recordingStorage();
    // Both begins read the same snapshot, which is the whole race: each one
    // believes the key it read is the one it is replacing.
    const snapshot = await readAsset(asset.id);

    const winner = await beginAssetPreview(
      snapshot,
      SOURCE_OF_PRODUCED_PREVIEW,
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    const loser = await beginAssetPreview(
      snapshot,
      { sourceWidth: 4000, sourceHeight: 3000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );

    expect(winner.ok).toBe(true);
    // The loser is told it lost rather than overwriting the newer intent, so
    // the URL it signed is never handed back and nothing can be written to it.
    expect(loser).toMatchObject({ ok: false, error: "PREVIEW_SUPERSEDED" });
    const row = await readAsset(asset.id);
    expect(row.previewState).toBe("pending");
    // The winner's source, transposed by its orientation, not the loser's.
    expect(row.displayWidth).toBe(600);
    expect(row.displayHeight).toBe(467);
    // Exactly one live key, and completion promotes that one.
    const completed = await completeAssetPreview(row, CEILINGS, backend.dependencies);
    expect(completed.ok).toBe(true);
    expect((await readAsset(asset.id)).previewStorageKey)
      .toBe(row.previewStorageKey);
  });

  it("signs the preview write for its own short lifetime, not the part window", async () => {
    const asset = await insertAsset();
    let requested = 0;
    const backend = recordingStorage({
      async signObjectUpload(input) {
        requested = input.expiresInSeconds;
        return {
          url: "https://storage.test/put",
          headers: { "content-type": input.mimeType },
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        };
      },
    });
    const response = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/${asset.id}/preview`,
      {
        method: "POST",
        headers: authHeaders(identity.cookie),
        body: JSON.stringify({ sourceWidth: 800, sourceHeight: 600 }),
      },
    );

    // Storage is disabled in this lane, so the route degrades truthfully
    // rather than signing anything.
    expect(response.status).toBe(503);
    // The lifetime the service asks for is the preview knob, which is far
    // shorter than the multipart part window: an issued single-object write
    // cannot be aborted, so the clock is the only thing that retires it.
    await beginAssetPreview(
      await readAsset(asset.id),
      { sourceWidth: 800, sourceHeight: 600, exifOrientation: 1 },
      CEILINGS,
      serverConfig.mediaPreviewUploadExpiresInSeconds,
      backend.dependencies,
    );
    expect(requested).toBe(serverConfig.mediaPreviewUploadExpiresInSeconds);
    expect(requested)
      .toBeLessThan(serverConfig.s3UploadPartExpiresInSeconds);
  });

  it("clears only the generation it inspected when a re-derivation raced it", async () => {
    const asset = await insertAsset();
    const oversized = recordingStorage({
      async inspectObject() {
        return { exists: true, bytes: serverConfig.mediaPreviewMaxBytes + 1 };
      },
    });
    await beginAssetPreview(
      asset,
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      oversized.dependencies,
    );
    // Generation A, read by a completion that is about to stall.
    const stale = await readAsset(asset.id);

    // Generation B replaces it while that completion is in flight.
    const fresh = recordingStorage();
    await beginAssetPreview(
      stale,
      { sourceWidth: 4000, sourceHeight: 3000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      fresh.dependencies,
    );
    const current = await readAsset(asset.id);
    expect(current.previewStorageKey).not.toBe(stale.previewStorageKey);

    // A's completion now finds its object oversized. It must not clear B: B's
    // producer still holds a valid upload URL for a key this call never saw.
    const completed = await completeAssetPreview(stale, CEILINGS, oversized.dependencies);

    expect(completed).toMatchObject({
      ok: false,
      error: "PREVIEW_NOT_PENDING",
    });
    const after = await readAsset(asset.id);
    expect(after.previewStorageKey).toBe(current.previewStorageKey);
    expect(after.previewState).toBe("pending");
    expect(oversized.deleted).not.toContain(current.previewStorageKey);
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
      { sourceWidth: 2000, sourceHeight: 1000, exifOrientation: 1 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );

    const completed = await completeAssetPreview(
      await readAsset(asset.id),
      CEILINGS,
      backend.dependencies,
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

    // The derived key is opaque and says nothing about anyone: not the file it
    // came from, and — since the namespace became flat so a sweep can
    // enumerate it — not the Journey or the Atlas either. Ownership is the
    // database's answer, not the key's.
    expect(stored.previewStorageKey).not.toContain(stored.fileName);
    expect(stored.previewStorageKey).not.toContain("route-point-media");
    expect(stored.previewStorageKey!.startsWith(PREVIEW_KEY_PREFIX)).toBe(true);
    expect(stored.previewStorageKey).not.toContain(identity.atlasId);
    expect(stored.previewStorageKey).not.toContain(journeyId);
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

  /**
   * Begin a derivation and delete the media out from under its signed write.
   *
   * The write is signed but nothing is written: the producer is holding a URL
   * it has not used yet, which is the state every late-write ordering below
   * starts from. `signObjectUpload` is overridden so the fixture, not the
   * stub, decides when bytes appear.
   */
  async function signThenDeleteMedia(
    backend: ReturnType<typeof recordingStorage>,
  ) {
    const asset = await insertAsset();
    const begun = await beginAssetPreview(
      asset,
      { sourceWidth: 6000, sourceHeight: 4000, exifOrientation: 6 },
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    expect(begun.ok).toBe(true);
    const pendingKey = (await readAsset(asset.id)).previewStorageKey!;

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
    expect(await readAsset(asset.id)).toBeUndefined();
    // Every row that could name the key is gone; only the write record is left.
    expect(
      await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(eq(mediaAssets.previewStorageKey, pendingKey)),
    ).toEqual([]);
    backend.deleted.length = 0;
    return { assetId: asset.id, pendingKey };
  }

  /** A backend whose signed write lands only when a case says so. */
  function unwrittenBackend() {
    return recordingStorage({
      async signObjectUpload(input) {
        return {
          url: `https://storage.test/put/${encodeURIComponent(input.key)}`,
          headers: { "content-type": input.mimeType },
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        };
      },
    });
  }

  async function writeRecordFor(storageKey: string) {
    const [record] = await db
      .select()
      .from(mediaPreviewWrites)
      .where(eq(mediaPreviewWrites.storageKey, storageKey));
    return record;
  }

  it("retires a preview write that landed after its media was deleted", async () => {
    // The interleaving the single-object write makes possible and the
    // multipart pipeline does not: begin signs a PUT, the media is deleted
    // while that signature is still valid, and the PUT lands afterwards.
    const backend = unwrittenBackend();
    const { assetId, pendingKey } = await signThenDeleteMedia(backend);

    // The late PUT: the producer still holds a valid URL and writes to it
    // after every row that referenced the key has cascaded away.
    backend.objects.set(pendingKey, PRODUCED_PREVIEW);

    // The write record outlives the cascade, so the prompt pass can still name
    // the object once the signature can no longer be used.
    const record = await writeRecordFor(pendingKey);
    expect(record).toBeTruthy();
    expect(record.mediaAssetId).toBe(assetId);

    const swept = await reconcilePreviewWrites(
      new Date(record.expiresAt.getTime() + 60 * 60 * 1_000),
      backend.dependencies,
    );
    expect(swept.retired).toBeGreaterThanOrEqual(1);
    expect(backend.deleted).toContain(pendingKey);
    expect(backend.objects.has(pendingKey)).toBe(false);
    // Nothing references the key and no object is under it, so there is
    // nothing left for a record to own.
    expect(await writeRecordFor(pendingKey)).toBeUndefined();
  });

  it("forgets an abandoned write without waiting out a clock", async () => {
    // A producer that begins a derivation and never writes. The record is
    // released on the first pass past its signature, so an authorized caller
    // cannot accumulate one durable row per abandoned generation — and
    // releasing it costs nothing, because the namespace sweep below can still
    // find an object that arrives afterwards.
    const backend = unwrittenBackend();
    const { pendingKey } = await signThenDeleteMedia(backend);
    const record = await writeRecordFor(pendingKey);
    expect(record).toBeTruthy();

    const swept = await reconcilePreviewWrites(
      new Date(record.expiresAt.getTime() + 6 * 60 * 1_000),
      backend.dependencies,
    );

    expect(swept.examined).toBeGreaterThanOrEqual(1);
    expect(await writeRecordFor(pendingKey)).toBeUndefined();
    // Nothing was there to delete, and nothing was concluded from that.
    expect(backend.objects.has(pendingKey)).toBe(false);
  });

  it("retires an object that landed after its write record was forgotten", async () => {
    // The ordering no clock settles, and the reason the record may be
    // forgotten: begin signs a PUT, the media is deleted, the request is still
    // streaming when the record is released, and the object appears long
    // afterwards. A presigned PUT has no provider-enforced request lifetime,
    // so "the signature expired" never proves the write is over — only asking
    // storage what it actually holds does.
    const backend = unwrittenBackend();
    const { pendingKey } = await signThenDeleteMedia(backend);
    const record = await writeRecordFor(pendingKey);
    await reconcilePreviewWrites(
      new Date(record.expiresAt.getTime() + 6 * 60 * 1_000),
      backend.dependencies,
    );
    expect(await writeRecordFor(pendingKey)).toBeUndefined();

    // The in-flight PUT finishes here, with no row and no record left that
    // could name its key.
    backend.objects.set(pendingKey, PRODUCED_PREVIEW);

    const swept = await reconcilePreviewNamespace(
      undefined,
      backend.dependencies,
    );

    expect(swept.examined).toBeGreaterThanOrEqual(1);
    expect(backend.deleted).toContain(pendingKey);
    expect(backend.objects.has(pendingKey)).toBe(false);
    // Nothing is left to enumerate, so the next pass starts over rather than
    // resuming a cursor.
    expect(swept.continuationToken).toBeUndefined();
  });

  it("keeps every object the namespace sweep finds a row for", async () => {
    // The other half of the same authority: an object is deleted because no
    // `media_assets` row references it, never because of its age. A ready
    // preview is referenced, so a sweep that runs a moment after it was
    // derived must leave it exactly where it is.
    const backend = recordingStorage();
    const asset = await insertAsset();
    await deriveReadyPreview(asset.id, backend);
    const stored = await readAsset(asset.id);
    backend.deleted.length = 0;
    // An object under the same prefix that nothing has ever referenced.
    const orphanKey = `${PREVIEW_KEY_PREFIX}${randomUUID()}`;
    backend.objects.set(orphanKey, PRODUCED_PREVIEW);

    const swept = await reconcilePreviewNamespace(
      undefined,
      backend.dependencies,
    );

    expect(swept.retired).toBe(1);
    expect(backend.deleted).toEqual([orphanKey]);
    expect(backend.objects.has(stored.previewStorageKey!)).toBe(true);
    expect((await readAsset(asset.id)).previewState).toBe("ready");
  });

  it("resumes the namespace sweep from the provider's own cursor", async () => {
    // A namespace bigger than one pass. The pages come back with a
    // continuation token, the pass stops at its page budget and hands the
    // token back, and nothing outside the pages it actually read is touched.
    const requested: Array<string | undefined> = [];
    // A provider that never runs out of pages, so the pass has to stop itself.
    const backend = recordingStorage({
      async listObjects(input) {
        requested.push(input.continuationToken);
        const page = Number(input.continuationToken ?? "0");
        return {
          keys: [`${PREVIEW_KEY_PREFIX}page-${page}`],
          continuationToken: String(page + 1),
        };
      },
    });

    const first = await reconcilePreviewNamespace(
      undefined,
      backend.dependencies,
    );
    expect(requested[0]).toBeUndefined();
    // Bounded: it did not read a bucket's worth of pages in one pass, and it
    // stopped while the provider still had more to give.
    expect(requested.length).toBeGreaterThan(1);
    expect(requested.length).toBeLessThan(50);
    expect(first.examined).toBe(requested.length);
    expect(first.continuationToken).toBeDefined();
    // Everything it did read was unreferenced, so all of it is retired.
    expect(backend.deleted.length).toBe(first.examined);
    expect(first.retired).toBe(first.examined);

    const pagesRead = requested.length;
    await reconcilePreviewNamespace(
      first.continuationToken,
      backend.dependencies,
    );
    // The next pass carries on from the cursor rather than re-reading the
    // pages this one already swept.
    expect(requested[pagesRead]).toBe(first.continuationToken);
  });

  it("leaves a served preview in place when its write record expires", async () => {
    // The other half of the same sweep: an expired write window says nothing
    // about the object, only about the permission to write it. A key an asset
    // still references is a live generation, so the record is retired and the
    // object is not.
    const backend = recordingStorage();
    const asset = await insertAsset();
    await deriveReadyPreview(asset.id, backend);
    const stored = await readAsset(asset.id);
    backend.deleted.length = 0;

    const [record] = await db
      .select()
      .from(mediaPreviewWrites)
      .where(eq(mediaPreviewWrites.storageKey, stored.previewStorageKey!));
    expect(record).toBeTruthy();

    await reconcilePreviewWrites(
      new Date(record.expiresAt.getTime() + 60 * 60 * 1_000),
      backend.dependencies,
    );

    expect(backend.deleted).not.toContain(stored.previewStorageKey);
    expect((await readAsset(asset.id)).previewState).toBe("ready");
    expect(
      await db
        .select()
        .from(mediaPreviewWrites)
        .where(eq(mediaPreviewWrites.storageKey, stored.previewStorageKey!)),
    ).toEqual([]);
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
      SOURCE_OF_PRODUCED_PREVIEW,
      CEILINGS,
      UPLOAD_TTL_SECONDS,
      backend.dependencies,
    );
    expect(begun.ok).toBe(true);
    await completeAssetPreview(await readAsset(asset.id), CEILINGS, backend.dependencies);
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
