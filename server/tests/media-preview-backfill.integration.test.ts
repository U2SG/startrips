import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, mediaAssets, mediaPreviewWrites } from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { readJpegPixelSize } from "../media/preview-image";
import {
  createJourneyForAtlas,
  markJourneyForDeletionForAtlas,
} from "../repositories/journey-repository";
import { PREVIEW_KEY_PREFIX } from "../services/media-preview";
import {
  backfillAssetPreview,
  listPreviewBackfillCandidates,
  PREVIEW_BACKFILL_MIN_AGE_MS,
  PREVIEW_BACKFILL_SOURCE_MAX_BYTES,
  runPreviewBackfillPass,
  type PreviewBackfillDependencies,
} from "../services/media-preview-backfill";
import { disabledStorage } from "../storage/disabled-storage";
import type { MultipartStorage } from "../storage/multipart-storage";

const TEST_ORIGIN = "http://127.0.0.1:5173";
const CEILINGS = {
  maxEdgePixels: serverConfig.mediaPreviewMaxEdgePixels,
  maxBytes: serverConfig.mediaPreviewMaxBytes,
};

/** A real 2048x1024 JPEG: wider than the 640 px ceiling, so the still must shrink. */
const ORIGINAL = new Uint8Array(readFileSync(
  new URL("./fixtures/oversized-still-2048x1024.jpg", import.meta.url),
));

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
  const verificationToken = await createEmailVerificationToken(serverConfig.authSecret, email);
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
  const organizationResponse = await app.request(`${TEST_ORIGIN}/api/auth/organization/create`, {
    method: "POST",
    headers: authHeaders(cookie!),
    body: JSON.stringify({ name: `${label} Atlas`, slug: `${label.toLowerCase()}-${randomUUID()}` }),
  });
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
 * An in-memory backend plus the PUT the sweep performs against it. The signed
 * URL carries the key, and the injected `fetch` lands the body under that key,
 * so completion inspects exactly what the sweep rendered.
 */
function backfillBackend(originals: Record<string, Uint8Array>) {
  const objects = new Map<string, Uint8Array>(Object.entries(originals));
  const puts: Array<{ key: string; bytes: number; contentType: string | undefined }> = [];
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
    async inspectObject(input) {
      const stored = objects.get(input.key);
      return stored ? { exists: true as const, bytes: stored.byteLength } : { exists: false as const };
    },
    async readObjectHead(input) {
      const stored = objects.get(input.key);
      return stored
        ? { exists: true as const, bytes: stored.subarray(0, input.maxBytes) }
        : { exists: false as const };
    },
    async listObjects(input) {
      return { keys: [...objects.keys()].filter((key) => key.startsWith(input.prefix)) };
    },
    async deleteObject(input) {
      objects.delete(input.key);
    },
    async hashObject() {
      return { exists: true as const, sha256: "0".repeat(64) };
    },
    async createPrivateReadUrl(input) {
      return {
        url: `https://storage.test/${encodeURIComponent(input.key)}`,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
  };
  const dependencies: PreviewBackfillDependencies = {
    storageForBackend: () => storage,
    configuredStorage: () => storage,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = decodeURIComponent(url.pathname.replace(/^\/put\//, ""));
      const body = init?.body;
      if (!(body instanceof Uint8Array)) throw new Error("PUT body must be bytes");
      objects.set(key, new Uint8Array(body));
      const headers = new Headers(init?.headers);
      puts.push({ key, bytes: body.byteLength, contentType: headers.get("content-type") ?? undefined });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    now: () => new Date(),
  };
  return { objects, puts, dependencies };
}

describe("server-side preview backfill", () => {
  let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
  let journeyId = "";

  async function insertAsset(input: {
    key: string;
    ageMs?: number;
    previewState?: "none" | "pending";
    mimeType?: string;
    journey?: string;
  }) {
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId: input.journey ?? journeyId,
        storageDriver: "s3",
        storageKey: input.key,
        fileName: "legacy-original.jpg",
        mimeType: input.mimeType ?? "image/jpeg",
        bytes: ORIGINAL.byteLength,
        uploadedByUserId: identity.userId,
        previewState: input.previewState ?? "none",
        createdAt: new Date(Date.now() - (input.ageMs ?? PREVIEW_BACKFILL_MIN_AGE_MS + 60_000)),
      })
      .returning();
    return asset;
  }

  async function readAsset(assetId: string) {
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    return asset;
  }

  beforeAll(async () => {
    identity = await createAuthenticatedAtlas("backfill");
    const journey = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      title: "Journey with legacy originals",
      startedOn: "2026-09-22",
      endedOn: "2026-09-23",
      note: "private",
      lightColor: "#f4ce73",
      routePoints: [
        { latitude: 37.593, longitude: -112.187, label: "Bryce Canyon", isStop: true, occurredAt: new Date("2026-09-22T00:00:00Z") },
      ],
    });
    if (!journey) throw new Error("Journey fixture was not created");
    journeyId = journey.id;
  });

  afterAll(async () => {
    await db.delete(mediaPreviewWrites).where(like(mediaPreviewWrites.storageKey, `${PREVIEW_KEY_PREFIX}%`));
    if (atlasIds.length) await db.delete(atlases).where(inArray(atlases.id, atlasIds));
    if (authOrganizationIds.length) {
      await db.delete(authOrganizations).where(inArray(authOrganizations.id, authOrganizationIds));
    }
    if (authUserEmails.length) await db.delete(authUsers).where(inArray(authUsers.email, authUserEmails));
    await pool.end();
  });

  it("derives a ready preview for a legacy original through the browser protocol", async () => {
    const key = `backfill/${randomUUID()}/original`;
    const asset = await insertAsset({ key, previewState: "pending" });
    const backend = backfillBackend({ [key]: ORIGINAL });

    await expect(backfillAssetPreview(asset, CEILINGS, backend.dependencies)).resolves.toBe("ready");

    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("ready");
    expect(stored.displayWidth).toBe(2048);
    expect(stored.displayHeight).toBe(1024);
    expect(stored.previewStorageKey?.startsWith(PREVIEW_KEY_PREFIX)).toBe(true);
    expect(stored.previewBytes).toBeGreaterThan(0);
    expect(stored.previewBytes!).toBeLessThanOrEqual(CEILINGS.maxBytes);

    expect(backend.puts).toHaveLength(1);
    expect(backend.puts[0].key).toBe(stored.previewStorageKey);
    expect(backend.puts[0].contentType).toBe("image/jpeg");
    const landed = backend.objects.get(stored.previewStorageKey!);
    const pixels = readJpegPixelSize(landed!);
    expect(pixels).toEqual({ width: 640, height: 320 });
  });

  it("records a decided failure for an original that is not a decodable image", async () => {
    const key = `backfill/${randomUUID()}/original`;
    const asset = await insertAsset({ key, previewState: "none" });
    const backend = backfillBackend({ [key]: new TextEncoder().encode("not a jpeg at all") });

    await expect(backfillAssetPreview(asset, CEILINGS, backend.dependencies)).resolves.toBe("failed");
    const stored = await readAsset(asset.id);
    expect(stored.previewState).toBe("failed");
    expect(stored.previewStorageKey).toBeNull();
    expect(backend.puts).toHaveLength(0);
  });

  it("refuses to decode an original that fills the source window", async () => {
    const key = `backfill/${randomUUID()}/original`;
    const asset = await insertAsset({ key, previewState: "none" });
    const backend = backfillBackend({});
    backend.dependencies.storageForBackend = () => ({
      ...backend.dependencies.configuredStorage(),
      async readObjectHead() {
        return { exists: true as const, bytes: new Uint8Array(PREVIEW_BACKFILL_SOURCE_MAX_BYTES) };
      },
    });

    await expect(backfillAssetPreview(asset, CEILINGS, backend.dependencies)).resolves.toBe("failed");
    expect((await readAsset(asset.id)).previewState).toBe("failed");
  });

  it("leaves fresh uploads, non-images, ready rows and deleted Journeys to their owners", async () => {
    const fresh = await insertAsset({ key: `backfill/${randomUUID()}/fresh`, ageMs: 1_000 });
    const video = await insertAsset({ key: `backfill/${randomUUID()}/video`, mimeType: "video/mp4" });
    const legacy = await insertAsset({ key: `backfill/${randomUUID()}/legacy`, previewState: "none" });
    const stuck = await insertAsset({ key: `backfill/${randomUUID()}/stuck`, previewState: "pending" });
    const doomed = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      title: "Journey on its way out",
      startedOn: "2026-09-01",
      endedOn: null,
      note: "",
      lightColor: "#f4ce73",
      routePoints: [
        { latitude: 1, longitude: 1, label: "", isStop: false, occurredAt: null },
      ],
    });
    if (!doomed) throw new Error("Doomed journey fixture was not created");
    const deleted = await insertAsset({ key: `backfill/${randomUUID()}/deleted`, journey: doomed.id });
    await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId);

    const candidates = (await listPreviewBackfillCandidates(new Date(), 100)).map((asset) => asset.id);
    expect(candidates).toContain(legacy.id);
    expect(candidates).toContain(stuck.id);
    expect(candidates).not.toContain(fresh.id);
    expect(candidates).not.toContain(video.id);
    expect(candidates).not.toContain(deleted.id);
  });

  it("runs a pass over its candidates and reports the outcomes", async () => {
    const readyKey = `backfill/${randomUUID()}/pass-ready`;
    const brokenKey = `backfill/${randomUUID()}/pass-broken`;
    const ready = await insertAsset({ key: readyKey, previewState: "pending" });
    const broken = await insertAsset({ key: brokenKey, previewState: "none" });
    const backend = backfillBackend({
      [readyKey]: ORIGINAL,
      [brokenKey]: new TextEncoder().encode("still not a jpeg"),
    });

    const summary = await runPreviewBackfillPass(backend.dependencies, CEILINGS);
    expect(summary.candidates).toBeGreaterThanOrEqual(2);
    expect((await readAsset(ready.id)).previewState).toBe("ready");
    expect((await readAsset(broken.id)).previewState).toBe("failed");
  });
});
