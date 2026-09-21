import { createHash, randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  journeyRecordedTrackSamples,
  journeyRecordedTrackSegments,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  MAX_RECORDED_TRACK_SAMPLES,
  MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT,
  MAX_RECORDED_TRACK_SEGMENTS,
} from "../journey/recorded-track";
import {
  readGpxRecordedTrack,
  readRecordedTrackImport,
  recordedTrackImportOperationKey,
  RECORDED_TRACK_IMPORT_FORMATS,
  type RecordedTrackImportLimits,
} from "../journey/recorded-track-import";
import { createJourneyForAtlas } from "../repositories/journey-repository";

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
 * Two recorded segments with an explicit break between them, plus an empty
 * `<trkseg>` that is not a break at all. The third point carries no time and
 * the file carries no accuracy anywhere, so the absences have to survive.
 */
const TWO_SEGMENT_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="startrips-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Day one</name>
    <trkseg>
      <trkpt lat="22.543096" lon="114.057865"><ele>12.4</ele><time>2026-09-01T00:00:00Z</time></trkpt>
      <trkpt lat="22.540100" lon="114.061200"><time>2026-09-01T00:01:00Z</time><hdop>3.1</hdop></trkpt>
      <trkpt lat="22.538000" lon="114.065000"/>
    </trkseg>
    <trkseg></trkseg>
    <trkseg>
      <trkpt lat="22.319300" lon="114.169400"><time>2026-09-02T03:04:05Z</time></trkpt>
      <trkpt lat="22.320000" lon="114.170000"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** The segment boundaries the file states, which storage must reproduce. */
const TWO_SEGMENT_SAMPLE_COUNTS = [3, 2];

const WAYPOINTS_ONLY_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="startrips-test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="22.543096" lon="114.057865"><name>Shenzhen</name></wpt>
  <wpt lat="22.319300" lon="114.169400"><name>Hong Kong</name></wpt>
  <rte>
    <rtept lat="22.543096" lon="114.057865"/>
    <rtept lat="22.319300" lon="114.169400"/>
  </rte>
</gpx>`;

const SINGLE_POINT_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="startrips-test">
  <trk><trkseg>
    <trkpt lat="22.543096" lon="114.057865"><time>2026-09-01T00:00:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

const EXTERNAL_ENTITY_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE gpx [
  <!ENTITY stolen SYSTEM "file:///etc/passwd">
  <!ENTITY remote SYSTEM "http://127.0.0.1:9/exfiltrate">
]>
<gpx version="1.1" creator="startrips-test">
  <trk><trkseg>
    <trkpt lat="22.543096" lon="114.057865"><name>&stolen;</name></trkpt>
    <trkpt lat="22.540100" lon="114.061200"><name>&remote;</name></trkpt>
  </trkseg></trk>
</gpx>`;

/**
 * Every URL a real GPX file carries — the namespace, the schema location and
 * a link. A reader that resolved any of them would reach the network for a
 * file it was only asked to read.
 */
const URL_BEARING_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="startrips-test"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata><link href="http://127.0.0.1:9/metadata"><text>source</text></link></metadata>
  <trk><trkseg>
    <trkpt lat="22.543096" lon="114.057865"><time>2026-09-01T00:00:00Z</time></trkpt>
    <trkpt lat="22.540100" lon="114.061200"><time>2026-09-01T00:01:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

function gpxWithPoints(segmentPointCounts: number[]) {
  const segments = segmentPointCounts.map((count) => {
    const points = Array.from(
      { length: count },
      (_value, index) =>
        `<trkpt lat="${(1 + index / 100_000).toFixed(6)}" lon="${(2 + index / 100_000).toFixed(6)}"/>`,
    ).join("");
    return `<trkseg>${points}</trkseg>`;
  }).join("");
  return `<gpx version="1.1"><trk>${segments}</trk></gpx>`;
}

let owner: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let stranger: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let ownerJourneyId = "";
let strangerJourneyId = "";

async function importRequest(
  cookie: string | undefined,
  journeyId: string,
  body: unknown,
) {
  return app.request(
    `${TEST_ORIGIN}/api/journey-recorded-tracks/${journeyId}/imports`,
    { method: "POST", headers: authHeaders(cookie), body: JSON.stringify(body) },
  );
}

async function importErrorCode(journeyId: string, body: unknown) {
  const response = await importRequest(owner.cookie, journeyId, body);
  const payload = await response.json() as { error?: string };
  return { status: response.status, error: payload.error };
}

async function readStoredSegments(journeyId: string) {
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

beforeAll(async () => {
  owner = await createAuthenticatedAtlas("ImportOwner");
  stranger = await createAuthenticatedAtlas("ImportStranger");

  const journey = await createJourneyForAtlas(owner.atlasId, owner.userId, {
    ...baseJourney,
    title: "Imported journey",
  });
  if (!journey) throw new Error("Journey fixture was not created");
  ownerJourneyId = journey.id;

  const foreign = await createJourneyForAtlas(
    stranger.atlasId,
    stranger.userId,
    { ...baseJourney, title: "Stranger journey" },
  );
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

describe("recorded-track import format registration", () => {
  it("keeps every declared ceiling at or under what the store accepts", () => {
    const { limits } = RECORDED_TRACK_IMPORT_FORMATS.gpx;
    expect(limits.maxSegments).toBeLessThanOrEqual(MAX_RECORDED_TRACK_SEGMENTS);
    expect(limits.maxPoints).toBeLessThanOrEqual(MAX_RECORDED_TRACK_SAMPLES);
    expect(limits.maxPointsPerSegment)
      .toBeLessThanOrEqual(MAX_RECORDED_TRACK_SAMPLES_PER_SEGMENT);
    // Under the 512 KB request body limit, so the format's own ceiling is the
    // one an over-sized upload meets.
    expect(limits.maxBytes).toBeLessThan(512 * 1024);
  });

  it("enforces the ceilings the registration hands the reader, not its own", () => {
    const narrow: RecordedTrackImportLimits = {
      maxBytes: 64 * 1024,
      maxSegments: 2,
      maxPoints: 10,
      maxPointsPerSegment: 3,
    };
    // The same documents the registered ceilings accept, refused purely
    // because a different registration declared smaller limits.
    expect(readGpxRecordedTrack(gpxWithPoints([4]), narrow)).toEqual({
      ok: false,
      reason: "TOO_MANY_POINTS",
    });
    expect(readGpxRecordedTrack(gpxWithPoints([2, 2, 2]), narrow)).toEqual({
      ok: false,
      reason: "TOO_MANY_SEGMENTS",
    });
    expect(readGpxRecordedTrack(gpxWithPoints([3, 3, 3]), narrow).ok).toBe(false);
    expect(readGpxRecordedTrack(gpxWithPoints([3, 3]), narrow).ok).toBe(true);
  });

  it("refuses a document past the registered point ceiling", () => {
    const { limits } = RECORDED_TRACK_IMPORT_FORMATS.gpx;
    const overPerSegment = gpxWithPoints([limits.maxPointsPerSegment + 1]);
    expect(readGpxRecordedTrack(overPerSegment, limits)).toEqual({
      ok: false,
      reason: "TOO_MANY_POINTS",
    });
    const overSegments = gpxWithPoints(
      Array.from({ length: limits.maxSegments + 1 }, () => 2),
    );
    expect(readGpxRecordedTrack(overSegments, limits)).toEqual({
      ok: false,
      reason: "TOO_MANY_SEGMENTS",
    });
  });

  it("refuses an over-sized upload by the declared byte ceiling", async () => {
    const { limits } = RECORDED_TRACK_IMPORT_FORMATS.gpx;
    const padding = "x".repeat(limits.maxBytes);
    const oversized = TWO_SEGMENT_GPX.replace(
      "<name>Day one</name>",
      `<name>${padding}</name>`,
    );
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(limits.maxBytes);
    const refusal = await importErrorCode(ownerJourneyId, {
      format: "gpx",
      document: oversized,
    });
    // 413 from this route, not the transport's REQUEST_TOO_LARGE: the format's
    // ceiling is what the file met.
    expect(refusal).toEqual({ status: 413, error: "FILE_TOO_LARGE" });
  });
});

describe("recorded-track import reading", () => {
  it("separates an unsupported format from a malformed file", async () => {
    expect(
      await importErrorCode(ownerJourneyId, {
        format: "gpx",
        document: WAYPOINTS_ONLY_GPX,
      }),
    ).toEqual({ status: 400, error: "UNSUPPORTED_FORMAT" });
    expect(
      await importErrorCode(ownerJourneyId, {
        format: "kml",
        document: TWO_SEGMENT_GPX,
      }),
    ).toEqual({ status: 400, error: "UNSUPPORTED_FORMAT" });

    // A track document with too little recorded movement is broken, and says
    // so with a different code.
    expect(
      await importErrorCode(ownerJourneyId, {
        format: "gpx",
        document: SINGLE_POINT_GPX,
      }),
    ).toEqual({ status: 400, error: "MALFORMED_FILE" });
    expect(
      await importErrorCode(ownerJourneyId, {
        format: "gpx",
        document: "<gpx version=\"1.1\"><trk><trkseg><trkpt lat=\"north\" lon=\"x\"/></trkseg></trk></gpx>",
      }),
    ).toEqual({ status: 400, error: "MALFORMED_FILE" });
  });

  it("refuses a declared entity or DTD and fetches no URL it reads", async () => {
    expect(
      await importErrorCode(ownerJourneyId, {
        format: "gpx",
        document: EXTERNAL_ENTITY_GPX,
      }),
    ).toEqual({ status: 400, error: "UNSAFE_DOCUMENT" });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const read = readRecordedTrackImport(
        "gpx",
        Buffer.from(URL_BEARING_GPX, "utf8"),
      );
      expect(read.ok).toBe(true);
      expect(readRecordedTrackImport(
        "gpx",
        Buffer.from(EXTERNAL_ENTITY_GPX, "utf8"),
      )).toEqual({ ok: false, reason: "UNSAFE_DOCUMENT" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keys the replay identity on the uploaded bytes alone", () => {
    const bytes = Buffer.from(TWO_SEGMENT_GPX, "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(recordedTrackImportOperationKey(bytes)).toBe(`import:sha256:${digest}`);
    expect(recordedTrackImportOperationKey(bytes))
      .toBe(recordedTrackImportOperationKey(Buffer.from(TWO_SEGMENT_GPX, "utf8")));
    expect(recordedTrackImportOperationKey(bytes))
      .not.toBe(recordedTrackImportOperationKey(Buffer.from(URL_BEARING_GPX, "utf8")));
    expect(recordedTrackImportOperationKey(bytes)).not.toMatch(/gpx/i);
  });
});

describe("recorded-track import over HTTP", () => {
  let importedKey = "";

  it("stores the file's own segment boundaries through the existing write path", async () => {
    const response = await importRequest(owner.cookie, ownerJourneyId, {
      format: "gpx",
      document: TWO_SEGMENT_GPX,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const payload = await response.json() as {
      imported: {
        format: string;
        replayed: boolean;
        recordedTrack: {
          operationKey: string;
          source: string;
          provenance: string;
          segments: Array<{
            sampleCount: number;
            samples: Array<{
              latitude: number;
              longitude: number;
              recordedAt: string | null;
              accuracyMeters: number | null;
            }>;
          }>;
        };
      };
    };
    const track = payload.imported.recordedTrack;
    importedKey = track.operationKey;
    expect(payload.imported.format).toBe("gpx");
    expect(payload.imported.replayed).toBe(false);
    expect(importedKey).toBe(
      recordedTrackImportOperationKey(Buffer.from(TWO_SEGMENT_GPX, "utf8")),
    );

    // The empty <trkseg> was not a break; the two real ones survived intact
    // and nothing was interpolated across the gap between them.
    expect(track.segments.map((segment) => segment.sampleCount))
      .toEqual(TWO_SEGMENT_SAMPLE_COUNTS);
    expect(track.segments[0].samples.map((sample) => [
      sample.latitude,
      sample.longitude,
      sample.recordedAt,
      sample.accuracyMeters,
    ])).toEqual([
      [22.543096, 114.057865, "2026-09-01T00:00:00.000Z", null],
      [22.5401, 114.0612, "2026-09-01T00:01:00.000Z", null],
      [22.538, 114.065, null, null],
    ]);
    expect(track.segments[1].samples.map((sample) => sample.latitude))
      .toEqual([22.3193, 22.32]);

    // The store names the format that produced the segments, in a column that
    // names no format itself.
    const stored = await readStoredSegments(ownerJourneyId);
    expect(stored.segments).toHaveLength(2);
    expect(stored.segments.map((segment) => segment.source))
      .toEqual(["imported-file", "imported-file"]);
    expect(stored.segments.map((segment) => segment.provenance))
      .toEqual(["gpx", "gpx"]);
    expect(stored.segments.map((segment) => segment.sampleCount))
      .toEqual(TWO_SEGMENT_SAMPLE_COUNTS);
    expect(stored.samples).toHaveLength(5);
    expect(Object.keys(stored.segments[0]).join(" ")).not.toMatch(/gpx/i);
  });

  it("replays an identical re-submission instead of duplicating segments", async () => {
    const before = await readStoredSegments(ownerJourneyId);
    const response = await importRequest(owner.cookie, ownerJourneyId, {
      format: "gpx",
      document: TWO_SEGMENT_GPX,
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      imported: { replayed: boolean; recordedTrack: { operationKey: string } };
    };
    expect(payload.imported.replayed).toBe(true);
    expect(payload.imported.recordedTrack.operationKey).toBe(importedKey);

    const after = await readStoredSegments(ownerJourneyId);
    expect(after.segments.map((segment) => segment.id))
      .toEqual(before.segments.map((segment) => segment.id));
    expect(after.samples).toHaveLength(before.samples.length);
  });

  it("answers the generic Journey 404 for an import outside the caller's Atlas", async () => {
    const refusal = await importErrorCode(strangerJourneyId, {
      format: "gpx",
      document: TWO_SEGMENT_GPX,
    });
    expect(refusal).toEqual({ status: 404, error: "JOURNEY_NOT_FOUND" });
    const stranded = await readStoredSegments(strangerJourneyId);
    expect(stranded.segments).toHaveLength(0);

    const unknown = await importErrorCode(randomUUID(), {
      format: "gpx",
      document: TWO_SEGMENT_GPX,
    });
    expect(unknown).toEqual(refusal);
  });

  it("requires a session and a usable body", async () => {
    const anonymous = await importRequest(undefined, ownerJourneyId, {
      format: "gpx",
      document: TWO_SEGMENT_GPX,
    });
    expect(anonymous.status).toBe(401);

    expect(await importErrorCode(ownerJourneyId, { format: "gpx" }))
      .toEqual({ status: 400, error: "INVALID_IMPORT_REQUEST" });
    expect(await importErrorCode(ownerJourneyId, { document: TWO_SEGMENT_GPX }))
      .toEqual({ status: 400, error: "UNSUPPORTED_FORMAT" });
  });
});
