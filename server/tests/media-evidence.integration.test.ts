import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  everydayFragments,
  journeys,
  mediaAssetEvidence,
  mediaAssets,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { createJourneyForAtlas } from "../repositories/journey-repository";
import { writeRecordedMediaEvidenceForAtlas } from "../repositories/media-evidence-repository";

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

const RECORDED_BODY = {
  expectedRevision: 0,
  spatial: {
    source: "exif",
    granularity: "coordinate",
    latitude: 47.620501,
    longitude: -122.349277,
    accuracyMeters: null,
    label: null,
  },
  captureTime: {
    source: "exif-original",
    timezone: "offset-known",
    local: "2026-09-18T08:30:00",
    instant: "2026-09-18T00:30:00.000Z",
    offsetMinutes: 480,
  },
} as const;

function evidenceRequest(cookie: string, assetId: string, suffix = "", init: RequestInit = {}) {
  return app.request(`${TEST_ORIGIN}/api/media-evidence/${assetId}${suffix}`, {
    ...init,
    headers: { ...authHeaders(cookie), ...(init.headers ?? {}) },
  });
}

let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let journeyId = "";
let routePointIds: string[] = [];
let assetId = "";
let movingAssetId = "";
let foreignAssetId = "";

beforeAll(async () => {
  identity = await createAuthenticatedAtlas("MediaEvidence");
  const journey = await createJourneyForAtlas(identity.atlasId, identity.userId, {
    ...baseJourney,
    title: "Evidence journey",
  });
  if (!journey) throw new Error("Journey fixture was not created");
  journeyId = journey.id;
  routePointIds = journey.routePoints.map((point) => point.id);

  const assets = await db.insert(mediaAssets).values([
    {
      journeyId,
      routePointId: routePointIds[0],
      storageDriver: "disabled",
      storageKey: `evidence/${randomUUID()}/historical.jpg`,
      fileName: "historical.jpg",
      mimeType: "image/jpeg",
      bytes: 1024,
      contentHash: "a".repeat(64),
      contentHashVerified: true,
      uploadedByUserId: identity.userId,
    },
    {
      journeyId,
      routePointId: routePointIds[0],
      storageDriver: "disabled",
      storageKey: `evidence/${randomUUID()}/moving.jpg`,
      fileName: "moving.jpg",
      mimeType: "image/jpeg",
      bytes: 2048,
      uploadedByUserId: identity.userId,
    },
  ]).returning({ id: mediaAssets.id });
  [assetId, movingAssetId] = assets.map((asset) => asset.id);

  const [foreignAtlas] = await db.insert(atlases).values({
    organizationId: `foreign-media-evidence-${randomUUID()}`,
    title: "Foreign Atlas",
  }).returning({ id: atlases.id });
  atlasIds.push(foreignAtlas.id);
  const foreignJourney = await createJourneyForAtlas(
    foreignAtlas.id,
    "foreign-user",
    { ...baseJourney, title: "Foreign journey" },
  );
  if (!foreignJourney) throw new Error("Foreign Journey fixture was not created");
  const [foreignAsset] = await db.insert(mediaAssets).values({
    journeyId: foreignJourney.id,
    routePointId: foreignJourney.routePoints[0].id,
    storageDriver: "disabled",
    storageKey: `evidence/${randomUUID()}/foreign.jpg`,
    fileName: "foreign.jpg",
    mimeType: "image/jpeg",
    bytes: 512,
    uploadedByUserId: "foreign-user",
  }).returning({ id: mediaAssets.id });
  foreignAssetId = foreignAsset.id;
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

describe("media evidence owner API", () => {
  it("reads historical assets as explicit unknown without backfilling Route Point coordinates", async () => {
    const response = await evidenceRequest(identity.cookie, assetId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const payload = await response.json() as any;
    expect(payload.evidence).toMatchObject({
      mediaAssetId: assetId,
      revision: 0,
      recorded: {
        spatial: {
          source: "unknown",
          granularity: "unknown",
          latitude: null,
          longitude: null,
          accuracyMeters: null,
          label: null,
        },
        captureTime: { source: "unknown", timezone: "unknown" },
      },
      effective: null,
      updatedAt: null,
    });
    const rows = await db.select().from(mediaAssetEvidence)
      .where(eq(mediaAssetEvidence.mediaAssetId, assetId));
    expect(rows).toHaveLength(0);
  });

  it("reads absent Fragment evidence as unknown and refuses another Atlas's Fragment", async () => {
    const [foreignAtlas] = await db.insert(atlases).values({
      organizationId: `fragment-evidence-${randomUUID()}`,
      title: "Foreign Fragment Atlas",
    }).returning({ id: atlases.id });
    atlasIds.push(foreignAtlas.id);
    const fragments = await db.insert(everydayFragments).values([
      identity.atlasId, foreignAtlas.id,
    ].map((atlasId) => ({
      atlasId,
      occurredOn: "2026-09-03",
      latitude: 1.3521,
      longitude: 103.8198,
      placeLabel: "Singapore",
      createdByUserId: identity.userId,
    }))).returning({ id: everydayFragments.id });
    const assets = await db.insert(mediaAssets).values(fragments.map((fragment) => ({
      everydayFragmentId: fragment.id,
      storageDriver: "disabled",
      storageKey: `evidence/${randomUUID()}/fragment.jpg`,
      fileName: "fragment.jpg",
      mimeType: "image/jpeg",
      bytes: 512,
      uploadedByUserId: identity.userId,
    }))).returning({ id: mediaAssets.id });

    const response = await evidenceRequest(identity.cookie, assets[0].id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      evidence: {
        mediaAssetId: assets[0].id,
        revision: 0,
        recorded: {
          spatial: { source: "unknown", latitude: null, longitude: null },
          captureTime: { source: "unknown", timezone: "unknown" },
        },
        display: { hidden: false, correction: null },
        effective: null,
        updatedAt: null,
      },
    });
    expect((await evidenceRequest(identity.cookie, assets[1].id)).status).toBe(404);
    expect(await db.select().from(mediaAssetEvidence)
      .where(inArray(mediaAssetEvidence.mediaAssetId, assets.map((asset) => asset.id))))
      .toEqual([]);
  });

  it("persists normalized evidence idempotently and revision-guards display changes", async () => {
    const first = await evidenceRequest(identity.cookie, assetId, "/recorded", {
      method: "PUT",
      body: JSON.stringify(RECORDED_BODY),
    });
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as any;
    expect(firstPayload.evidence).toMatchObject({
      revision: 1,
      effective: {
        source: "recorded",
        provenance: "exif",
        latitude: 47.620501,
        longitude: -122.349277,
        accuracyMeters: null,
      },
    });
    expect(JSON.stringify(firstPayload)).not.toContain("contentHashVerified");

    const retry = await evidenceRequest(identity.cookie, assetId, "/recorded", {
      method: "PUT",
      body: JSON.stringify(RECORDED_BODY),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).evidence.revision).toBe(1);

    const corrected = await evidenceRequest(identity.cookie, assetId, "/display", {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 1,
        hidden: false,
        correction: {
          granularity: "city",
          latitude: null,
          longitude: null,
          label: "Seattle",
        },
      }),
    });
    expect(corrected.status).toBe(200);
    const correctedPayload = await corrected.json() as any;
    expect(correctedPayload.evidence).toMatchObject({
      revision: 2,
      recorded: { spatial: { latitude: 47.620501, longitude: -122.349277 } },
      effective: {
        source: "user-correction",
        provenance: null,
        granularity: "city",
        latitude: null,
        longitude: null,
        accuracyMeters: null,
        label: "Seattle",
      },
    });

    const hidden = await evidenceRequest(identity.cookie, assetId, "/display", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 2, hidden: true, correction: null }),
    });
    expect(hidden.status).toBe(200);
    expect((await hidden.json() as any).evidence)
      .toMatchObject({ revision: 3, effective: null });

    const sameHiddenRetry = await evidenceRequest(identity.cookie, assetId, "/display", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 2, hidden: true, correction: null }),
    });
    expect(sameHiddenRetry.status).toBe(200);
    expect((await sameHiddenRetry.json() as any).evidence.revision).toBe(3);

    const staleDifferent = await evidenceRequest(identity.cookie, assetId, "/display", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, hidden: false, correction: null }),
    });
    expect(staleDifferent.status).toBe(409);
    const conflict = await staleDifferent.json() as any;
    expect(conflict).toMatchObject({
      error: "MEDIA_EVIDENCE_REVISION_CONFLICT",
      evidence: { revision: 3 },
    });
  });

  it("rejects invalid evidence and denies foreign Atlas assets without echoing private coordinates", async () => {
    const invalidBody = {
      ...RECORDED_BODY,
      spatial: { ...RECORDED_BODY.spatial, latitude: 91.123456 },
    };
    const invalid = await evidenceRequest(identity.cookie, movingAssetId, "/recorded", {
      method: "PUT",
      body: JSON.stringify(invalidBody),
    });
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toContain("INVALID_MEDIA_RECORDED_EVIDENCE");
    expect(invalidText).not.toContain("91.123456");

    expect((await evidenceRequest(identity.cookie, foreignAssetId)).status).toBe(404);
    const foreignWrite = await evidenceRequest(
      identity.cookie,
      foreignAssetId,
      "/recorded",
      { method: "PUT", body: JSON.stringify(RECORDED_BODY) },
    );
    expect(foreignWrite.status).toBe(404);
    expect((await evidenceRequest(identity.cookie, "not-a-uuid")).status).toBe(404);
  });

  it("rejects evidence access once a Journey enters its deletion grace period", async () => {
    const deletingJourney = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Deleting evidence journey",
    });
    if (!deletingJourney) throw new Error("Deleting Journey fixture was not created");
    const [asset] = await db.insert(mediaAssets).values({
      journeyId: deletingJourney.id,
      routePointId: deletingJourney.routePoints[0].id,
      storageDriver: "disabled",
      storageKey: `evidence/${randomUUID()}/deleting.jpg`,
      fileName: "deleting.jpg",
      mimeType: "image/jpeg",
      bytes: 256,
      uploadedByUserId: identity.userId,
    }).returning({ id: mediaAssets.id });

    await db.update(journeys)
      .set({ deletionStartedAt: new Date() })
      .where(eq(journeys.id, deletingJourney.id));
    try {
      expect((await evidenceRequest(identity.cookie, asset.id)).status).toBe(404);
      const write = await evidenceRequest(identity.cookie, asset.id, "/recorded", {
        method: "PUT",
        body: JSON.stringify(RECORDED_BODY),
      });
      expect(write.status).toBe(404);
    } finally {
      await db.update(journeys)
        .set({ deletionStartedAt: null })
        .where(eq(journeys.id, deletingJourney.id));
    }
  });

  it("refuses repository writes after Atlas deletion starts", async () => {
    const [deletingAtlas] = await db.insert(atlases).values({
      organizationId: `deleting-media-evidence-${randomUUID()}`,
      title: "Deleting Atlas",
    }).returning({ id: atlases.id });
    atlasIds.push(deletingAtlas.id);
    const journey = await createJourneyForAtlas(
      deletingAtlas.id,
      "deleting-user",
      { ...baseJourney, title: "Atlas deletion race fixture" },
    );
    if (!journey) throw new Error("Atlas deletion Journey fixture was not created");
    const [asset] = await db.insert(mediaAssets).values({
      journeyId: journey.id,
      routePointId: journey.routePoints[0].id,
      storageDriver: "disabled",
      storageKey: `evidence/${randomUUID()}/atlas-deleting.jpg`,
      fileName: "atlas-deleting.jpg",
      mimeType: "image/jpeg",
      bytes: 384,
      uploadedByUserId: "deleting-user",
    }).returning({ id: mediaAssets.id });

    await db.update(atlases)
      .set({ deletionStartedAt: new Date() })
      .where(eq(atlases.id, deletingAtlas.id));
    const result = await writeRecordedMediaEvidenceForAtlas(
      deletingAtlas.id,
      asset.id,
      {
        expectedRevision: 0,
        recorded: {
          spatial: { ...RECORDED_BODY.spatial },
          captureTime: {
            source: "exif-original",
            timezone: "offset-known",
            local: "2026-09-18T08:30:00",
            instant: new Date("2026-09-18T00:30:00.000Z"),
            offsetMinutes: 480,
          },
        },
      },
    );
    expect(result).toEqual({ outcome: "asset-missing" });
    expect(await db.select().from(mediaAssetEvidence)
      .where(eq(mediaAssetEvidence.mediaAssetId, asset.id))).toHaveLength(0);
  });

  it("enforces non-null database fields for conditional coordinate and offset shapes", async () => {
    await expect(db.insert(mediaAssetEvidence).values({
      mediaAssetId: foreignAssetId,
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      latitude: null,
      longitude: -122.349277,
    })).rejects.toThrow();

    await expect(db.insert(mediaAssetEvidence).values({
      mediaAssetId: foreignAssetId,
      captureTimeSource: "exif-original",
      timezoneState: "offset-known",
      capturedLocal: "2026-09-18T08:30:00",
      capturedAtUtc: new Date("2026-09-18T00:30:00.000Z"),
      capturedOffsetMinutes: null,
    })).rejects.toThrow();

    await expect(db.insert(mediaAssetEvidence).values({
      mediaAssetId: foreignAssetId,
      correctionGranularity: "coordinate",
      correctionLatitude: null,
      correctionLongitude: -122.349277,
    })).rejects.toThrow();
  });

  it("keeps one evidence row with the asset through Route Point moves and Everyday Fragment reclassification", async () => {
    const written = await evidenceRequest(identity.cookie, movingAssetId, "/recorded", {
      method: "PUT",
      body: JSON.stringify(RECORDED_BODY),
    });
    expect(written.status).toBe(200);

    await db.update(mediaAssets)
      .set({ routePointId: routePointIds[1] })
      .where(eq(mediaAssets.id, movingAssetId));
    const afterRouteMove = await evidenceRequest(identity.cookie, movingAssetId);
    expect(afterRouteMove.status).toBe(200);
    expect((await afterRouteMove.json() as any).evidence.recorded.spatial)
      .toMatchObject({ latitude: 47.620501, longitude: -122.349277 });

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
    }).where(eq(mediaAssets.id, movingAssetId));

    const afterReclassification = await evidenceRequest(identity.cookie, movingAssetId);
    expect(afterReclassification.status).toBe(200);
    const payload = await afterReclassification.json() as any;
    expect(payload.evidence).toMatchObject({
      mediaAssetId: movingAssetId,
      revision: 1,
      recorded: { spatial: { latitude: 47.620501, longitude: -122.349277 } },
    });
    const evidenceRows = await db.select().from(mediaAssetEvidence)
      .where(eq(mediaAssetEvidence.mediaAssetId, movingAssetId));
    expect(evidenceRows).toHaveLength(1);
  });
});
