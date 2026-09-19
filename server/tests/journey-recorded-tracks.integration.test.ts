import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  journeyRecordedTrackSamples,
  journeyRecordedTrackSegments,
  journeyRoutePoints,
  journeys,
  mediaAssets,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  MAX_OPERATION_KEY_LENGTH,
  MAX_RECORDED_TRACK_SAMPLES,
  MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT,
  MAX_RECORDED_TRACK_SEGMENTS,
  normalizeRecordedTrackWrite,
  type RecordedTrackWrite,
} from "../journey/recorded-track";
import {
  createJourneyForAtlas,
  deleteJourneyForAtlas,
  markJourneyForDeletionForAtlas,
  updateJourneyForAtlas,
} from "../repositories/journey-repository";
import {
  deleteRecordedTrackForAtlas,
  listRecordedTracksForAtlas,
  writeRecordedTrackForAtlas,
} from "../repositories/journey-recorded-track-repository";

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
 * Two segments with an explicit break between them, one sample without a
 * time and one without an accuracy. The absences are the point: they must
 * survive a round trip instead of being filled in.
 */
const TWO_SEGMENT_BODY = {
  operationKey: "recording-2026-09-01",
  source: "device-recording",
  provenance: "test recorder",
  segments: [
    {
      samples: [
        {
          latitude: 22.543096,
          longitude: 114.057865,
          recordedAt: "2026-09-01T00:00:00.000Z",
          accuracyMeters: 8.5,
        },
        {
          latitude: 22.5401,
          longitude: 114.0612,
          recordedAt: "2026-09-01T00:01:00.000Z",
          accuracyMeters: null,
        },
      ],
    },
    {
      samples: [
        {
          latitude: 22.3193,
          longitude: 114.1694,
          recordedAt: null,
          accuracyMeters: 42,
        },
      ],
    },
  ],
} as const;

function normalized(body: unknown): RecordedTrackWrite {
  const result = normalizeRecordedTrackWrite(body);
  if (!result.ok) throw new Error(`Expected a normalized write: ${result.reason}`);
  return result.write;
}

function rejection(body: unknown) {
  const result = normalizeRecordedTrackWrite(body);
  return result.ok ? null : result.reason;
}

function manySamples(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    latitude: 1 + index / 100_000,
    longitude: 2 + index / 100_000,
    recordedAt: null,
    accuracyMeters: null,
  }));
}

async function readStoredRows(journeyId: string) {
  const segments = await db
    .select()
    .from(journeyRecordedTrackSegments)
    .where(eq(journeyRecordedTrackSegments.journeyId, journeyId))
    .orderBy(
      asc(journeyRecordedTrackSegments.operationKey),
      asc(journeyRecordedTrackSegments.segmentOrder),
    );
  const samples = segments.length === 0
    ? []
    : await db
        .select()
        .from(journeyRecordedTrackSamples)
        .where(inArray(
          journeyRecordedTrackSamples.segmentId,
          segments.map((segment) => segment.id),
        ))
        .orderBy(
          asc(journeyRecordedTrackSamples.segmentId),
          asc(journeyRecordedTrackSamples.sampleOrder),
        );
  return { segments, samples };
}

let owner: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let stranger: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let ownerJourneyId = "";
let ownerJourneyRevision = 1;
let strangerJourneyId = "";
let ownerAssetId = "";

beforeAll(async () => {
  owner = await createAuthenticatedAtlas("TrackOwner");
  stranger = await createAuthenticatedAtlas("TrackStranger");

  const journey = await createJourneyForAtlas(owner.atlasId, owner.userId, {
    ...baseJourney,
    title: "Recorded journey",
  });
  if (!journey) throw new Error("Journey fixture was not created");
  ownerJourneyId = journey.id;
  ownerJourneyRevision = journey.revision;

  const [asset] = await db.insert(mediaAssets).values({
    journeyId: ownerJourneyId,
    routePointId: journey.routePoints[0].id,
    storageDriver: "disabled",
    storageKey: `recorded-track/${randomUUID()}/photo.jpg`,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    bytes: 2048,
    contentHash: "b".repeat(64),
    contentHashVerified: true,
    uploadedByUserId: owner.userId,
  }).returning({ id: mediaAssets.id });
  ownerAssetId = asset.id;

  const foreign = await createJourneyForAtlas(stranger.atlasId, stranger.userId, {
    ...baseJourney,
    title: "Stranger journey",
  });
  if (!foreign) throw new Error("Foreign journey fixture was not created");
  strangerJourneyId = foreign.id;
});

afterAll(async () => {
  if (atlasIds.length > 0) {
    await db.delete(atlases).where(inArray(atlases.id, atlasIds));
  }
  if (authOrganizationIds.length > 0) {
    await db
      .delete(authOrganizations)
      .where(inArray(authOrganizations.id, authOrganizationIds));
  }
  if (authUserEmails.length > 0) {
    await db.delete(authUsers).where(inArray(authUsers.email, authUserEmails));
  }
  await pool.end();
});

describe("recorded-track normalization", () => {
  it("keeps explicit segment breaks and absent time or accuracy", () => {
    const write = normalized(TWO_SEGMENT_BODY);
    expect(write.segments).toHaveLength(2);
    expect(write.segments[0].samples).toHaveLength(2);
    expect(write.segments[1].samples).toHaveLength(1);
    expect(write.segments[0].samples[1].accuracyMeters).toBeNull();
    expect(write.segments[1].samples[0].recordedAt).toBeNull();
    // Nothing was invented to bridge the break.
    const total = write.segments.reduce(
      (sum, segment) => sum + segment.samples.length,
      0,
    );
    expect(total).toBe(3);
  });

  it("rejects non-finite and out-of-range coordinates", () => {
    const withCoordinate = (latitude: unknown, longitude: unknown) => ({
      ...TWO_SEGMENT_BODY,
      segments: [{ samples: [{ latitude, longitude }] }],
    });
    expect(rejection(withCoordinate(Number.NaN, 0))).toBe("INVALID_COORDINATE");
    expect(rejection(withCoordinate(Number.POSITIVE_INFINITY, 0)))
      .toBe("INVALID_COORDINATE");
    expect(rejection(withCoordinate(0, Number.NEGATIVE_INFINITY)))
      .toBe("INVALID_COORDINATE");
    expect(rejection(withCoordinate(91, 0))).toBe("INVALID_COORDINATE");
    expect(rejection(withCoordinate(0, 181))).toBe("INVALID_COORDINATE");
    expect(rejection(withCoordinate("1.5", 0))).toBe("INVALID_COORDINATE");
  });

  it("rejects an unreadable sample time or accuracy", () => {
    expect(rejection({
      ...TWO_SEGMENT_BODY,
      segments: [{ samples: [{ latitude: 1, longitude: 2, recordedAt: "later" }] }],
    })).toBe("INVALID_SAMPLE_TIME");
    expect(rejection({
      ...TWO_SEGMENT_BODY,
      segments: [{
        samples: [{ latitude: 1, longitude: 2, accuracyMeters: Number.NaN }],
      }],
    })).toBe("INVALID_ACCURACY");
    expect(rejection({
      ...TWO_SEGMENT_BODY,
      segments: [{ samples: [{ latitude: 1, longitude: 2, accuracyMeters: -1 }] }],
    })).toBe("INVALID_ACCURACY");
  });

  it("refuses a sample time that Date would silently rewrite", () => {
    const withTime = (recordedAt: unknown) => ({
      ...TWO_SEGMENT_BODY,
      segments: [{ samples: [{ latitude: 1, longitude: 2, recordedAt }] }],
    });
    // A calendar date that does not exist; `new Date` rolls it into March.
    expect(rejection(withTime("2026-02-30T00:00:00Z"))).toBe("INVALID_SAMPLE_TIME");
    expect(rejection(withTime("2026-02-29T00:00:00Z"))).toBe("INVALID_SAMPLE_TIME");
    // No offset: the instant would depend on the server's timezone.
    expect(rejection(withTime("2026-09-01T12:00:00"))).toBe("INVALID_SAMPLE_TIME");
    expect(rejection(withTime("2026-09-01"))).toBe("INVALID_SAMPLE_TIME");
    // Wall-clock fields out of range that `new Date` would carry forward.
    expect(rejection(withTime("2026-09-01T24:00:00Z"))).toBe("INVALID_SAMPLE_TIME");
    expect(rejection(withTime("2026-09-01T12:60:00Z"))).toBe("INVALID_SAMPLE_TIME");
    expect(rejection(withTime("2026-13-01T00:00:00Z"))).toBe("INVALID_SAMPLE_TIME");
    // Finer than a millisecond: Date would keep only three digits and two
    // readings a microsecond apart would fingerprint as the same replay.
    expect(rejection(withTime("2026-09-01T12:00:00.123456Z")))
      .toBe("INVALID_SAMPLE_TIME");
    // An offset no calendar has.
    expect(rejection(withTime("2026-09-01T12:00:00+99:00"))).toBe("INVALID_SAMPLE_TIME");

    const accepted = normalizeRecordedTrackWrite(withTime("2024-02-29T23:59:59+02:00"));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("expected an accepted sample time");
    expect(accepted.write.segments[0].samples[0].recordedAt?.toISOString())
      .toBe("2024-02-29T21:59:59.000Z");
  });

  it("refuses an empty segment rather than closing the gap", () => {
    expect(rejection({ ...TWO_SEGMENT_BODY, segments: [] }))
      .toBe("INVALID_SEGMENTS");
    expect(rejection({ ...TWO_SEGMENT_BODY, segments: [{ samples: [] }] }))
      .toBe("INVALID_SEGMENTS");
  });

  it("bounds the segment and sample counts", () => {
    expect(rejection({
      ...TWO_SEGMENT_BODY,
      segments: Array.from(
        { length: MAX_RECORDED_TRACK_SEGMENTS + 1 },
        () => ({ samples: manySamples(1) }),
      ),
    })).toBe("TOO_MANY_SEGMENTS");
    expect(rejection({
      ...TWO_SEGMENT_BODY,
      segments: [{ samples: manySamples(MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT + 1) }],
    })).toBe("TOO_MANY_SAMPLES");
  });

  it("refuses a body that carries its own atlas or organization identity", () => {
    expect(rejection({ ...TWO_SEGMENT_BODY, atlasId: randomUUID() }))
      .toBe("AUTHORITY_IN_BODY");
    expect(rejection({ ...TWO_SEGMENT_BODY, organizationId: randomUUID() }))
      .toBe("AUTHORITY_IN_BODY");
    expect(rejection({ ...TWO_SEGMENT_BODY, journeyId: randomUUID() }))
      .toBe("AUTHORITY_IN_BODY");
  });

  it("requires a usable operation key and a known source", () => {
    expect(rejection({ ...TWO_SEGMENT_BODY, operationKey: "" }))
      .toBe("INVALID_OPERATION_KEY");
    expect(rejection({ ...TWO_SEGMENT_BODY, operationKey: 7 }))
      .toBe("INVALID_OPERATION_KEY");
    expect(rejection({ ...TWO_SEGMENT_BODY, source: "gpx" }))
      .toBe("INVALID_SOURCE");
  });
});

describe("recorded-track persistence", () => {
  it("stores ordered segments and samples under the journey", async () => {
    const result = await writeRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      normalized(TWO_SEGMENT_BODY),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.replayed).toBe(false);
    expect(result.operation.segments.map((segment) => segment.segmentOrder))
      .toEqual([0, 1]);
    expect(result.operation.segments[0].samples.map((s) => s.sampleOrder))
      .toEqual([0, 1]);
    expect(result.operation.segments[0].samples[0].accuracyMeters).toBe(8.5);
    expect(result.operation.segments[0].samples[1].accuracyMeters).toBeNull();
    expect(result.operation.segments[1].samples[0].recordedAt).toBeNull();
    expect(result.operation.segments[1].sampleCount).toBe(1);
    expect(result.operation.source).toBe("device-recording");
    expect(result.operation.provenance).toBe("test recorder");
  });

  it("persists a write at the accepted sample ceiling", async () => {
    // The normalizer accepts MAX_RECORDED_TRACK_SAMPLES, so persistence has to
    // store them: one statement per sample row would bind six parameters each
    // and exceed PostgreSQL's 65,535-parameter limit.
    const segmentCount =
      MAX_RECORDED_TRACK_SAMPLES / MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT;
    const result = await writeRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      normalized({
        ...TWO_SEGMENT_BODY,
        operationKey: "ceiling-key",
        segments: Array.from({ length: segmentCount }, () => ({
          samples: manySamples(MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT),
        })),
      }),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.operation.segments).toHaveLength(segmentCount);
    const stored = result.operation.segments.reduce(
      (total, segment) => total + segment.samples.length,
      0,
    );
    expect(stored).toBe(MAX_RECORDED_TRACK_SAMPLES);
    // Order survives the chunk boundaries, which fall inside every segment.
    for (const segment of result.operation.segments) {
      expect(segment.samples[0].sampleOrder).toBe(0);
      expect(segment.samples[segment.samples.length - 1].sampleOrder)
        .toBe(MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT - 1);
    }
  });

  it("replays the same operation identity and rejects a conflicting payload", async () => {
    const first = await writeRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: "replay-key" }),
    );
    expect(first.outcome).toBe("ok");
    if (first.outcome !== "ok") return;

    const replay = await writeRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: "replay-key" }),
    );
    expect(replay.outcome).toBe("ok");
    if (replay.outcome !== "ok") return;
    expect(replay.replayed).toBe(true);
    expect(replay.operation.segments.map((segment) => segment.id))
      .toEqual(first.operation.segments.map((segment) => segment.id));
    expect(replay.operation.segments[0].samples.map((sample) => sample.id))
      .toEqual(first.operation.segments[0].samples.map((sample) => sample.id));

    const conflicting = await writeRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      normalized({
        ...TWO_SEGMENT_BODY,
        operationKey: "replay-key",
        segments: [{ samples: [{ latitude: 0, longitude: 0 }] }],
      }),
    );
    expect(conflicting.outcome).toBe("operation-conflict");

    // The refused write changed nothing.
    const stored = await readStoredRows(ownerJourneyId);
    const replayed = stored.segments
      .filter((segment) => segment.operationKey === "replay-key");
    expect(replayed).toHaveLength(2);
  });

  it("scopes the operation identity to one journey, not to a user or atlas", async () => {
    const sharedKey = "shared-operation-key";
    const mine = await writeRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: sharedKey }),
    );
    expect(mine.outcome).toBe("ok");

    const theirs = await writeRecordedTrackForAtlas(
      stranger.atlasId,
      strangerJourneyId,
      normalized({
        ...TWO_SEGMENT_BODY,
        operationKey: sharedKey,
        segments: [{ samples: [{ latitude: 10, longitude: 20 }] }],
      }),
    );
    // A different Journey in a different Atlas: the same key is a different
    // operation, so it is neither deduplicated against nor refused.
    expect(theirs.outcome).toBe("ok");
    if (mine.outcome !== "ok" || theirs.outcome !== "ok") return;
    expect(theirs.operation.segments[0].id)
      .not.toBe(mine.operation.segments[0].id);
    expect(theirs.operation.segments[0].samples[0].latitude).toBe(10);
  });
});

describe("recorded-track authorization", () => {
  it("refuses a write against another atlas's journey without disclosing it", async () => {
    const result = await writeRecordedTrackForAtlas(
      owner.atlasId,
      strangerJourneyId,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: "cross-atlas-write" }),
    );
    expect(result.outcome).toBe("journey-missing");

    const strangerRows = await readStoredRows(strangerJourneyId);
    expect(strangerRows.segments.some(
      (segment) => segment.operationKey === "cross-atlas-write",
    )).toBe(false);
  });

  it("answers the generic journey 404 for a cross-atlas read", async () => {
    const response = await app.request(
      `${TEST_ORIGIN}/api/journey-recorded-tracks/${ownerJourneyId}`,
      { headers: authHeaders(stranger.cookie) },
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "JOURNEY_NOT_FOUND" });
    // Nothing about the owner's recording reached the stranger.
    expect(body).not.toContain("114.057865");
    expect(body).not.toContain("device-recording");

    const missing = await app.request(
      `${TEST_ORIGIN}/api/journey-recorded-tracks/${randomUUID()}`,
      { headers: authHeaders(stranger.cookie) },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "JOURNEY_NOT_FOUND" });
  });

  it("reads the owner's own recorded tracks", async () => {
    const response = await app.request(
      `${TEST_ORIGIN}/api/journey-recorded-tracks/${ownerJourneyId}`,
      { headers: authHeaders(owner.cookie) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const payload = await response.json() as {
      recordedTracks: Array<{ operationKey: string; journeyId: string }>;
    };
    expect(payload.recordedTracks.length).toBeGreaterThan(0);
    expect(payload.recordedTracks.every(
      (track) => track.journeyId === ownerJourneyId,
    )).toBe(true);
  });

  it("requires a session", async () => {
    const response = await app.request(
      `${TEST_ORIGIN}/api/journey-recorded-tracks/${ownerJourneyId}`,
      { headers: authHeaders() },
    );
    expect(response.status).toBe(401);
  });

  it("takes the atlas from the session even when the read is cross-atlas", async () => {
    // `listRecordedTracksForAtlas` is only ever reached with the
    // session-derived Atlas; handed a foreign pair it finds nothing.
    expect(await listRecordedTracksForAtlas(stranger.atlasId, ownerJourneyId))
      .toBeNull();
  });
});

describe("recorded-track isolation from route points and media", () => {
  it("leaves stored track rows byte-identical across a route edit and reorder", async () => {
    const before = await readStoredRows(ownerJourneyId);
    expect(before.segments.length).toBeGreaterThan(0);
    expect(before.samples.length).toBeGreaterThan(0);

    const journeyRow = await db
      .select({ revision: journeys.revision })
      .from(journeys)
      .where(eq(journeys.id, ownerJourneyId))
      .limit(1);
    ownerJourneyRevision = journeyRow[0].revision;

    const updated = await updateJourneyForAtlas(ownerJourneyId, owner.atlasId, {
      ...baseJourney,
      title: "Recorded journey",
      revision: ownerJourneyRevision,
      routePoints: [
        { ...baseJourney.routePoints[1] },
        { ...baseJourney.routePoints[0] },
        {
          latitude: 22.2,
          longitude: 114.2,
          label: "Lantau",
          isStop: false,
          occurredAt: new Date("2026-09-02T04:00:00Z"),
        },
      ],
    });
    expect(updated).toBeTruthy();

    const routePoints = await db
      .select({ label: journeyRoutePoints.label })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, ownerJourneyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    expect(routePoints.map((point) => point.label))
      .toEqual(["Hong Kong", "Shenzhen", "Lantau"]);

    const after = await readStoredRows(ownerJourneyId);
    expect(after.segments).toEqual(before.segments);
    expect(after.samples).toEqual(before.samples);
  });

  it("deletes one operation without touching route points or media", async () => {
    const routePointsBefore = await db
      .select()
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, ownerJourneyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    const mediaBefore = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, ownerAssetId));

    expect(await deleteRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      "replay-key",
    )).toBe("deleted");
    expect(await deleteRecordedTrackForAtlas(
      owner.atlasId,
      ownerJourneyId,
      "replay-key",
    )).toBe("operation-missing");

    const stored = await readStoredRows(ownerJourneyId);
    expect(stored.segments.some(
      (segment) => segment.operationKey === "replay-key",
    )).toBe(false);
    // The samples of the removed segments went with them, and no others did.
    expect(stored.samples.every((sample) => stored.segments.some(
      (segment) => segment.id === sample.segmentId,
    ))).toBe(true);

    const routePointsAfter = await db
      .select()
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, ownerJourneyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    const mediaAfter = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, ownerAssetId));
    expect(routePointsAfter).toEqual(routePointsBefore);
    expect(mediaAfter).toEqual(mediaBefore);
  });

  it("refuses a cross-atlas delete", async () => {
    expect(await deleteRecordedTrackForAtlas(
      stranger.atlasId,
      ownerJourneyId,
      TWO_SEGMENT_BODY.operationKey,
    )).toBe("journey-missing");
    const stored = await readStoredRows(ownerJourneyId);
    expect(stored.segments.some(
      (segment) => segment.operationKey === TWO_SEGMENT_BODY.operationKey,
    )).toBe(true);
  });

  it("removes the track evidence when the owning journey is deleted", async () => {
    const doomed = await createJourneyForAtlas(owner.atlasId, owner.userId, {
      ...baseJourney,
      title: "Doomed journey",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    const written = await writeRecordedTrackForAtlas(
      owner.atlasId,
      doomed.id,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: "doomed-operation" }),
    );
    expect(written.outcome).toBe("ok");
    if (written.outcome !== "ok") return;
    const segmentIds = written.operation.segments.map((segment) => segment.id);

    // The soft mark is not a deletion: the evidence is still there during the
    // grace window, exactly like the Journey it belongs to.
    expect(await markJourneyForDeletionForAtlas(doomed.id, owner.atlasId))
      .toBeTruthy();
    expect((await readStoredRows(doomed.id)).segments).toHaveLength(2);

    expect(await deleteJourneyForAtlas(doomed.id, owner.atlasId)).toBeTruthy();
    const remainingSegments = await db
      .select()
      .from(journeyRecordedTrackSegments)
      .where(inArray(journeyRecordedTrackSegments.id, segmentIds));
    expect(remainingSegments).toHaveLength(0);
    const remainingSamples = await db
      .select()
      .from(journeyRecordedTrackSamples)
      .where(inArray(journeyRecordedTrackSamples.segmentId, segmentIds));
    expect(remainingSamples).toHaveLength(0);
  });
});

describe("recorded-track withdrawal over HTTP", () => {
  let journeyId = "";
  let assetId = "";
  const keys = ["withdraw-a", "withdraw-b", "withdraw-c"] as const;

  async function deleteRequest(
    cookie: string | undefined,
    target: string,
    body: string,
  ) {
    return app.request(`${TEST_ORIGIN}/api/journey-recorded-tracks/${target}`, {
      method: "DELETE",
      headers: authHeaders(cookie),
      body,
    });
  }

  async function listedKeys(cookie: string) {
    const response = await app.request(
      `${TEST_ORIGIN}/api/journey-recorded-tracks/${journeyId}`,
      { headers: authHeaders(cookie) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      recordedTracks: Array<{ operationKey: string }>;
    };
    return payload.recordedTracks.map((track) => track.operationKey);
  }

  // A Journey of its own: the sibling-order assertion below would otherwise
  // depend on every operation the earlier tests in this file happened to
  // leave under the shared fixture.
  beforeAll(async () => {
    const journey = await createJourneyForAtlas(owner.atlasId, owner.userId, {
      ...baseJourney,
      title: "Withdrawal journey",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    journeyId = journey.id;
    const [asset] = await db.insert(mediaAssets).values({
      journeyId,
      routePointId: journey.routePoints[0].id,
      storageDriver: "disabled",
      storageKey: `recorded-track/${randomUUID()}/withdrawal.jpg`,
      fileName: "withdrawal.jpg",
      mimeType: "image/jpeg",
      bytes: 1024,
      contentHash: "c".repeat(64),
      contentHashVerified: true,
      uploadedByUserId: owner.userId,
    }).returning({ id: mediaAssets.id });
    assetId = asset.id;
    for (const operationKey of keys) {
      const written = await writeRecordedTrackForAtlas(
        owner.atlasId,
        journeyId,
        normalized({ ...TWO_SEGMENT_BODY, operationKey }),
      );
      expect(written.outcome).toBe("ok");
    }
    expect(await listedKeys(owner.cookie)).toEqual([...keys]);
  });

  it("withdraws one operation and leaves siblings, route and media intact", async () => {
    const routePointsBefore = await db
      .select()
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    const mediaBefore = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));

    const response = await deleteRequest(
      owner.cookie,
      journeyId,
      JSON.stringify({ operationKey: "withdraw-b" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );

    // Only the requested operation went, and the survivors kept their order.
    expect(await listedKeys(owner.cookie)).toEqual(["withdraw-a", "withdraw-c"]);
    const stored = await readStoredRows(journeyId);
    expect(stored.samples.every((sample) => stored.segments.some(
      (segment) => segment.id === sample.segmentId,
    ))).toBe(true);

    const routePointsAfter = await db
      .select()
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId))
      .orderBy(asc(journeyRoutePoints.sortOrder));
    const mediaAfter = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    expect(routePointsAfter).toEqual(routePointsBefore);
    expect(mediaAfter).toEqual(mediaBefore);
  });

  it("answers one indistinguishable 404 for every withdrawal it refuses", async () => {
    const before = await readStoredRows(journeyId);

    // A repeat of the withdrawal that already happened.
    const repeated = await deleteRequest(
      owner.cookie,
      journeyId,
      JSON.stringify({ operationKey: "withdraw-b" }),
    );
    // A key this owner never stored anywhere.
    const unknown = await deleteRequest(
      owner.cookie,
      journeyId,
      JSON.stringify({ operationKey: `unknown-${randomUUID()}` }),
    );
    // A key that exists, but only under the stranger's Journey.
    const strangerKey = `stranger-only-${randomUUID()}`;
    const planted = await writeRecordedTrackForAtlas(
      stranger.atlasId,
      strangerJourneyId,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: strangerKey }),
    );
    expect(planted.outcome).toBe("ok");
    const foreignKey = await deleteRequest(
      owner.cookie,
      journeyId,
      JSON.stringify({ operationKey: strangerKey }),
    );
    // The stranger reaching into the owner's Journey with a real owner key.
    const crossAtlas = await deleteRequest(
      stranger.cookie,
      journeyId,
      JSON.stringify({ operationKey: "withdraw-a" }),
    );
    // A Journey that does not exist at all, and something that is not a
    // Journey id in the first place.
    const missingJourney = await deleteRequest(
      owner.cookie,
      randomUUID(),
      JSON.stringify({ operationKey: "withdraw-a" }),
    );
    const unusableJourney = await deleteRequest(
      owner.cookie,
      "not-a-journey-id",
      JSON.stringify({ operationKey: "withdraw-a" }),
    );

    const responses = [
      repeated,
      unknown,
      foreignKey,
      crossAtlas,
      missingJourney,
      unusableJourney,
    ];
    const bodies = await Promise.all(responses.map((one) => one.text()));
    for (const one of responses) expect(one.status).toBe(404);
    // Raw text rather than a parsed object: the refusals have to be
    // byte-identical, or the answer says which of the six situations held.
    for (const body of bodies) expect(body).toBe(bodies[0]);
    expect(JSON.parse(bodies[0])).toEqual({ error: "RECORDED_TRACK_NOT_FOUND" });

    expect(await readStoredRows(journeyId)).toEqual(before);
    const strangerRows = await readStoredRows(strangerJourneyId);
    expect(strangerRows.segments.some(
      (segment) => segment.operationKey === strangerKey,
    )).toBe(true);
  });

  it("refuses an unusable body with one code and deletes nothing", async () => {
    const before = await readStoredRows(journeyId);
    const unusable = [
      "{",
      "null",
      '"withdraw-a"',
      '["withdraw-a"]',
      "{}",
      JSON.stringify({ operationKey: "" }),
      JSON.stringify({ operationKey: "   " }),
      JSON.stringify({ operationKey: " withdraw-a" }),
      JSON.stringify({ operationKey: 42 }),
      JSON.stringify({ operationKey: "x".repeat(MAX_OPERATION_KEY_LENGTH + 1) }),
      // A zero byte is valid JSON but not a value PostgreSQL will hold in a
      // `text` column, so it has to be refused here rather than by the driver.
      JSON.stringify({ operationKey: "withdraw\u0000a" }),
      JSON.stringify({ operationKey: "\u0000" }),
      // An atlas or organization in the body buys nothing: authority is only
      // ever the session's, and the operation key is still missing.
      JSON.stringify({ atlasId: owner.atlasId, organizationId: owner.atlasId }),
    ];
    for (const body of unusable) {
      const response = await deleteRequest(owner.cookie, journeyId, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_OPERATION_KEY" });
    }
    expect(await readStoredRows(journeyId)).toEqual(before);
  });

  it("requires a session", async () => {
    const before = await readStoredRows(journeyId);
    const response = await deleteRequest(
      undefined,
      journeyId,
      JSON.stringify({ operationKey: "withdraw-a" }),
    );
    expect(response.status).toBe(401);
    expect(await readStoredRows(journeyId)).toEqual(before);
  });

  it("refuses a withdrawal from a Journey inside its deletion grace window", async () => {
    const doomed = await createJourneyForAtlas(owner.atlasId, owner.userId, {
      ...baseJourney,
      title: "Withdrawal grace journey",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    const written = await writeRecordedTrackForAtlas(
      owner.atlasId,
      doomed.id,
      normalized({ ...TWO_SEGMENT_BODY, operationKey: "grace-window" }),
    );
    expect(written.outcome).toBe("ok");
    expect(await markJourneyForDeletionForAtlas(doomed.id, owner.atlasId))
      .toBeTruthy();

    const response = await deleteRequest(
      owner.cookie,
      doomed.id,
      JSON.stringify({ operationKey: "grace-window" }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "RECORDED_TRACK_NOT_FOUND" });
    // A Journey awaiting restore keeps its evidence, exactly as the Journey
    // itself survives the grace window.
    expect((await readStoredRows(doomed.id)).segments).toHaveLength(2);
  });
});
