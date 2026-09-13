import { createHash, randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  homeBaseDismissals,
  homeBasePeriods,
  journeyRoutePoints,
  journeys,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { hasAtlasPermission } from "../authorization/permissions";
import { db, pool } from "../db/client";
import {
  MAX_HOME_BASE_DISMISSAL_BYTES_PER_ATLAS,
  MAX_HOME_BASE_DISMISSALS_PER_ATLAS,
  recordHomeBaseDismissalForAtlas,
} from "../repositories/home-base-repository";
import {
  parseHomeBaseDismissalInput,
  parseHomeBaseInput,
  parseHomeBasePatch,
  parseHomeBaseSuggestionConfirmationProof,
} from "./home-bases";
import {
  HOME_BASE_EVIDENCE_DIGEST_MAX_LENGTH,
  homeBaseEvidenceDigest,
} from "../../src/journey/homeBaseInference";

/**
 * #231: the HTTP surface, through the real `app` so the Atlas really is
 * derived from the session and the `onError` envelope really is the one a
 * client sees. Everything below the request is the same PostgreSQL the `core`
 * CI lane provisions.
 */

const TEST_ORIGIN = "http://127.0.0.1:5173";
const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];

const SHENZHEN = {
  label: "Shenzhen",
  latitude: 22.543096,
  longitude: 114.057865,
  startedOn: "2022-06-01",
};

function validDismissalDigest(
  latitude = 22.5431,
  longitude = 114.0579,
  evidenceStartedOn = "2026-01-01",
  evidenceEndedOn = "2026-04-01",
) {
  return homeBaseEvidenceDigest({
    anchor: { latitude, longitude },
    supports: Array.from({ length: 4 }, () => ({
      journeyId: randomUUID(),
      supportsStart: true,
      supportsEnd: true,
    })),
    evidenceStartedOn,
    evidenceEndedOn,
  });
}

async function seedDismissalSuggestion(
  atlasId: string,
  latitude = 22.5431,
  longitude = 114.0579,
) {
  const dates = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-15"] as const;
  const created = await db.insert(journeys).values(dates.map((date, index) => ({
    atlasId,
    title: `Home evidence ${index + 1}`,
    startedOn: date,
    endedOn: date,
    createdByUserId: "home-base-route-test",
  }))).returning({ id: journeys.id });
  await db.insert(journeyRoutePoints).values(created.flatMap((journey) => ([
    { journeyId: journey.id, sortOrder: 0, latitude, longitude, label: "Home", isStop: true },
    { journeyId: journey.id, sortOrder: 1, latitude, longitude, label: "Home", isStop: true },
  ])));
  return homeBaseEvidenceDigest({
    anchor: { latitude, longitude },
    supports: created.map((journey) => ({
      journeyId: journey.id,
      supportsStart: true,
      supportsEnd: true,
    })),
    evidenceStartedOn: dates[0],
    evidenceEndedOn: dates[dates.length - 1],
  });
}

const UTC_TEST_NOW = new Date("2026-04-02T12:00:00.000Z");

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

// The same lifecycle `share-grants.integration.test.ts` uses: Better Auth
// rate-limits sign-ups independently of the anonymous limiter, so each
// identity is created once for the whole file.
async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  // `/sign-up/email` allows five attempts per ten minutes with the counters in
  // the database, so they are shared with every other integration file in the
  // run and are mostly spent by the time this one starts. The same clear
  // `media-preview.integration.test.ts` performs: counters a previous FILE
  // left behind go, the product limit itself is untouched, the key format is
  // not assumed, and this file still creates exactly two identities.
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
  return {
    cookie: cookie!,
    organizationId: organization.id,
    atlasId: payload.atlas.id,
  };
}

async function post(cookie: string, body: unknown) {
  return await app.request(`${TEST_ORIGIN}/api/home-bases`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(body),
  });
}

let resident: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let neighbour: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;

beforeAll(async () => {
  resident = await createAuthenticatedAtlas("Resident");
  neighbour = await createAuthenticatedAtlas("Neighbour");
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

describe("home base period input", () => {
  it("defaults the source and reads an omitted end as the current period", () => {
    expect(parseHomeBaseInput({ ...SHENZHEN })).toEqual({
      ...SHENZHEN,
      endedOn: null,
      source: "manual",
    });
  });

  it("refuses a date that is not a fixed-width calendar date", () => {
    // Ordering and resolution compare these as strings, so a short month
    // would sort wrong forever rather than fail loudly later.
    expect(parseHomeBaseInput({ ...SHENZHEN, startedOn: "2022-6-1" })).toBeNull();
    expect(parseHomeBaseInput({ ...SHENZHEN, startedOn: "2022-02-30" })).toBeNull();
    expect(parseHomeBaseInput({ ...SHENZHEN, endedOn: "not-a-date" })).toBeNull();
  });

  it("refuses coordinates outside the world and an unknown source", () => {
    expect(parseHomeBaseInput({ ...SHENZHEN, latitude: 91 })).toBeNull();
    expect(parseHomeBaseInput({ ...SHENZHEN, longitude: -181 })).toBeNull();
    expect(parseHomeBaseInput({ ...SHENZHEN, latitude: "" })).toBeNull();
    expect(parseHomeBaseInput({ ...SHENZHEN, source: "inferred" })).toBeNull();
  });

  it("keeps a coherent-looking but impossible interval for the repository", () => {
    // End before start parses: it is a statement about the recorded timeline,
    // answered by a 409, not a malformed document answered by a 400.
    expect(parseHomeBaseInput({
      ...SHENZHEN,
      startedOn: "2026-09-01",
      endedOn: "2026-08-01",
    })).toMatchObject({ endedOn: "2026-08-01" });
  });

  it("reads an empty correction as no correction at all", () => {
    expect(parseHomeBasePatch({})).toBeNull();
    expect(parseHomeBasePatch({ endedOn: null })).toEqual({ endedOn: null });
    expect(parseHomeBasePatch({ label: "  Tokyo  " })).toEqual({ label: "Tokyo" });
    expect(parseHomeBasePatch({ startedOn: "2026-9-1" })).toBeNull();
  });
});

describe("suggested Home confirmation proof", () => {
  it("accepts one canonical current-day proof and keeps the rendered Home context exact", () => {
    const digest = validDismissalDigest();
    expect(parseHomeBaseSuggestionConfirmationProof({
      evidenceDigest: digest,
      evaluationDate: "2026-04-02",
      expectedState: "move_suggested",
      expectedCurrentHome: {
        id: "00000000-0000-4000-8000-000000000001",
        latitude: 22.543096,
        longitude: 114.057865,
        startedOn: "2022-06-01",
        endedOn: null,
      },
    }, UTC_TEST_NOW)).toEqual({
      evidenceDigest: digest,
      evaluationDate: "2026-04-02",
      expectedState: "move_suggested",
      expectedCurrentHome: {
        id: "00000000-0000-4000-8000-000000000001",
        latitude: 22.543096,
        longitude: 114.057865,
        startedOn: "2022-06-01",
        endedOn: null,
      },
    });
  });

  it("refuses forged evidence, remote policy dates and a non-current expected Home", () => {
    expect(parseHomeBaseSuggestionConfirmationProof({
      evidenceDigest: "not-a-digest",
      evaluationDate: "2026-04-02",
      expectedState: "suggested",
      expectedCurrentHome: null,
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseSuggestionConfirmationProof({
      evidenceDigest: validDismissalDigest(),
      evaluationDate: "2026-04-05",
      expectedState: "suggested",
      expectedCurrentHome: null,
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseSuggestionConfirmationProof({
      evidenceDigest: validDismissalDigest(),
      evaluationDate: "2026-04-02",
      expectedState: "move_suggested",
      expectedCurrentHome: {
        id: "00000000-0000-4000-8000-000000000001",
        latitude: 22.543096,
        longitude: 114.057865,
        startedOn: "2022-06-01",
        endedOn: "2026-01-01",
      },
    }, UTC_TEST_NOW)).toBeNull();
  });
});

describe("the authorization level each verb asks for", () => {
  it("keeps removal reachable by the member who can record and correct", () => {
    // #231 makes Home Base member-confirmed and its manual editing include
    // removing a period, so DELETE asks for `update`. The owner-only `delete`
    // action would leave a member able to record a mistaken period and
    // correct every field of it while unable to withdraw it.
    expect(hasAtlasPermission("member", "create")).toBe(true);
    expect(hasAtlasPermission("member", "update")).toBe(true);
    expect(hasAtlasPermission("member", "delete")).toBe(false);
    expect(hasAtlasPermission("owner", "update")).toBe(true);
  });
});

describe("POST /api/home-bases", () => {
  it("requires startedOn", async () => {
    const response = await post(resident.cookie, {
      label: "Shenzhen",
      latitude: 22.543096,
      longitude: 114.057865,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE" });
  });

  it("ignores an atlas or organization id supplied in the body", async () => {
    const response = await post(resident.cookie, {
      ...SHENZHEN,
      startedOn: "2010-01-01",
      endedOn: "2011-01-01",
      atlasId: neighbour.atlasId,
      organizationId: neighbour.organizationId,
    });
    expect(response.status).toBe(201);
    const { period } = await response.json() as { period: { id: string } };

    // The row landed in the session's own atlas, not the one the body named.
    const [row] = await db
      .select({ atlasId: homeBasePeriods.atlasId })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.id, period.id));
    expect(row.atlasId).toBe(resident.atlasId);
    expect(row.atlasId).not.toBe(neighbour.atlasId);

    // And the named atlas sees nothing of it.
    const neighbourList = await app.request(`${TEST_ORIGIN}/api/home-bases`, {
      headers: authHeaders(neighbour.cookie),
    });
    expect(neighbourList.status).toBe(200);
    const { periods } = await neighbourList.json() as {
      periods: Array<{ id: string }>;
    };
    expect(periods.map((entry) => entry.id)).not.toContain(period.id);
  });

  it("answers an impossible history with a 409 envelope", async () => {
    // The typed repository error, as `server/app.ts` onError renders it.
    const reversed = await post(resident.cookie, {
      ...SHENZHEN,
      startedOn: "2016-09-01",
      endedOn: "2016-08-01",
    });
    expect(reversed.status).toBe(409);
    expect(await reversed.json()).toEqual({
      error: "HOME_BASE_PERIOD_INVALID_INTERVAL",
      message: expect.any(String),
    });

    const current = await post(resident.cookie, {
      ...SHENZHEN,
      label: "Tokyo",
      startedOn: "2022-06-01",
    });
    expect(current.status).toBe(201);
    const overlapping = await post(resident.cookie, {
      ...SHENZHEN,
      startedOn: "2023-01-01",
      endedOn: "2024-01-01",
    });
    expect(overlapping.status).toBe(409);
    expect(await overlapping.json()).toMatchObject({
      error: "HOME_BASE_PERIOD_OVERLAP",
    });

    const secondCurrent = await post(resident.cookie, {
      ...SHENZHEN,
      startedOn: "2022-06-01",
    });
    expect(secondCurrent.status).toBe(409);
    expect(await secondCurrent.json()).toMatchObject({
      error: "HOME_BASE_PERIOD_ALREADY_OPEN",
    });
  });

  it("refuses an unusable body with the route's own 400", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/home-bases`, {
      method: "POST",
      headers: authHeaders(resident.cookie),
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE" });
  });

  it("refuses a request with no session at all", async () => {
    const response = await post("", { ...SHENZHEN });
    expect(response.status).toBe(401);
  });
});

describe("the Home Base dismissal body", () => {
  const DIGEST = validDismissalDigest();

  it("accepts only the two answers, keeps a one-day timezone date for evidence, and uses server policy time", () => {
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)).toEqual({
      kind: "soft",
      digest: DIGEST,
      dismissedOn: "2026-04-02",
      evaluationDate: "2026-04-02",
    });
    expect(parseHomeBaseDismissalInput({
      kind: "rejected",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-03",
    }, UTC_TEST_NOW)).toEqual({
      kind: "rejected",
      digest: DIGEST,
      dismissedOn: "2026-04-02",
      evaluationDate: "2026-04-03",
    });
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2099-12-31",
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseDismissalInput({
      kind: "rejected",
      evidenceDigest: DIGEST,
      dismissedOn: "2000-01-01",
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseDismissalInput({
      kind: "snoozed",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-4-2",
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
    }, UTC_TEST_NOW)).toBeNull();
  });

  it("keeps a valid evidence digest byte-exact but rejects noncanonical or oversized input", () => {
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)?.digest).toBe(DIGEST);
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: ` ${DIGEST} `,
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: `${DIGEST}${"x".repeat(HOME_BASE_EVIDENCE_DIGEST_MAX_LENGTH)}`,
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)).toBeNull();
  });

  it("rejects malformed or forged evidence digests", () => {
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: "hbi-v2:22.5431:114.0579:4:2026-01-01:2026-04-01:not-a-real-support:deadbeef",
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)).toBeNull();
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: `${DIGEST.slice(0, -8)}deadbeef`,
      dismissedOn: "2026-04-02",
    }, UTC_TEST_NOW)).toBeNull();
  });
});

describe("GET and POST /api/home-bases/dismissal", () => {
  let DIGEST = "";

  async function postDismissal(cookie: string, body: unknown) {
    return await app.request(`${TEST_ORIGIN}/api/home-bases/dismissal`, {
      method: "POST",
      headers: authHeaders(cookie),
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    await db.delete(homeBaseDismissals).where(inArray(homeBaseDismissals.atlasId, [
      resident.atlasId,
      neighbour.atlasId,
    ]));
    await db.delete(journeys).where(inArray(journeys.atlasId, [
      resident.atlasId,
      neighbour.atlasId,
    ]));
    DIGEST = await seedDismissalSuggestion(neighbour.atlasId);
  });

  it("derives the atlas from the session, uses server policy time, and persists only the current authoritative suggestion", async () => {
    const serverDateBefore = new Date().toISOString().slice(0, 10);
    const response = await postDismissal(neighbour.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: serverDateBefore,
      atlasId: resident.atlasId,
      organizationId: resident.organizationId,
    });
    const serverDateAfter = new Date().toISOString().slice(0, 10);
    expect(response.status).toBe(201);
    const responseBody = await response.json() as { dismissal: { kind: string; digest: string; dismissedAt: string } };
    expect(responseBody.dismissal).toMatchObject({ kind: "soft", digest: DIGEST });
    expect([serverDateBefore, serverDateAfter]).toContain(responseBody.dismissal.dismissedAt);

    const rows = await db
      .select({ atlasId: homeBaseDismissals.atlasId })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.evidenceDigest, DIGEST));
    expect(rows.map((row) => row.atlasId)).toEqual([neighbour.atlasId]);

    const residentRead = await app.request(
      `${TEST_ORIGIN}/api/home-bases/dismissal`,
      { headers: authHeaders(resident.cookie) },
    );
    expect(residentRead.status).toBe(200);
    expect(await residentRead.json()).toEqual({ dismissals: [] });
  });

  it("accepts an exact retry after the same dismissal already committed", async () => {
    const dismissedOn = new Date().toISOString().slice(0, 10);
    const first = await postDismissal(neighbour.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as {
      dismissal: { kind: string; digest: string; dismissedAt: string };
    };

    const retry = await postDismissal(neighbour.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn,
    });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(firstBody);

    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(row.total).toBe(1);
  });

  it("refuses a canonical digest that was not inferred from this Atlas", async () => {
    const forged = validDismissalDigest();
    const response = await postDismissal(neighbour.cookie, {
      kind: "rejected",
      evidenceDigest: forged,
      dismissedOn: new Date().toISOString().slice(0, 10),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE_DISMISSAL" });
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(row.total).toBe(0);
  });

  it("refuses real evidence that belongs to a different Atlas", async () => {
    const otherAtlasDigest = await seedDismissalSuggestion(resident.atlasId, 35.6895, 139.6917);
    const response = await postDismissal(neighbour.cookie, {
      kind: "rejected",
      evidenceDigest: otherAtlasDigest,
      dismissedOn: new Date().toISOString().slice(0, 10),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE_DISMISSAL" });
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(row.total).toBe(0);
  });

  it("refuses a once-valid digest after authoritative Atlas evidence changes", async () => {
    const [newJourney] = await db.insert(journeys).values({
      atlasId: neighbour.atlasId,
      title: "New Home evidence",
      startedOn: "2026-05-15",
      endedOn: "2026-05-15",
      createdByUserId: "home-base-route-test",
    }).returning({ id: journeys.id });
    await db.insert(journeyRoutePoints).values([
      { journeyId: newJourney.id, sortOrder: 0, latitude: 22.5431, longitude: 114.0579, label: "Home", isStop: true },
      { journeyId: newJourney.id, sortOrder: 1, latitude: 22.5431, longitude: 114.0579, label: "Home", isStop: true },
    ]);

    const response = await postDismissal(neighbour.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: new Date().toISOString().slice(0, 10),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE_DISMISSAL" });
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(row.total).toBe(0);
  });

  it("consolidates evidence churn by region without weakening an explicit rejection", async () => {
    const first = validDismissalDigest(22.5431, 114.0579, "2026-01-01", "2026-04-01");
    const sameRegionRevision = validDismissalDigest(22.55, 114.06, "2026-02-01", "2026-05-01");
    const tokyo = validDismissalDigest(35.6895, 139.6917, "2026-05-01", "2026-08-01");

    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "rejected",
      digest: first,
      dismissedOn: "2026-04-02",
    });
    const sameRegion = await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft",
      digest: sameRegionRevision,
      dismissedOn: "2026-05-02",
    });
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft",
      digest: tokyo,
      dismissedOn: "2026-08-02",
    });

    expect(sameRegion).toEqual({
      kind: "rejected",
      digest: first,
      dismissedAt: "2026-04-02",
    });
    const rows = await db
      .select({ kind: homeBaseDismissals.kind, digest: homeBaseDismissals.evidenceDigest })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ kind: "rejected", digest: first });
    expect(rows).toContainEqual({ kind: "soft", digest: tokyo });
    expect(rows).not.toContainEqual({ kind: "soft", digest: sameRegionRevision });
  });

  it("fails closed instead of overwriting a different digest on hash collision", async () => {
    const incoming = validDismissalDigest(35.6895, 139.6917, "2026-01-01", "2026-04-15");
    const stored = validDismissalDigest(48.8566, 2.3522, "2026-01-01", "2026-04-15");
    const incomingHash = createHash("md5").update(incoming, "utf8").digest("hex");
    await db.insert(homeBaseDismissals).values({
      atlasId: neighbour.atlasId,
      kind: "soft",
      evidenceDigest: stored,
      evidenceDigestHash: incomingHash,
      dismissedOn: "2026-04-16",
    });

    await expect(recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft",
      digest: incoming,
      dismissedOn: "2026-05-16",
    })).rejects.toThrow("HOME_BASE_DISMISSAL_DIGEST_HASH_COLLISION");
    const rows = await db
      .select({ digest: homeBaseDismissals.evidenceDigest })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(rows).toEqual([{ digest: stored }]);
  });

  it("does not merge two historical regions more than 25 km apart through a midpoint candidate", async () => {
    const west = validDismissalDigest(0, 0, "2026-01-01", "2026-04-15");
    const east = validDismissalDigest(0, 0.4, "2026-01-01", "2026-04-15");
    const midpoint = validDismissalDigest(0, 0.2, "2026-02-01", "2026-05-15");
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft", digest: west, dismissedOn: "2026-04-16",
    });
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft", digest: east, dismissedOn: "2026-04-16",
    });
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft", digest: midpoint, dismissedOn: "2026-05-16",
    });

    const rows = await db
      .select({ digest: homeBaseDismissals.evidenceDigest })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(rows).toHaveLength(2);
    const digests = rows.map((row) => row.digest);
    expect(digests).toContain(midpoint);
    expect(Number(digests.includes(west)) + Number(digests.includes(east))).toBe(1);
  });

  it("bounds distinct regions and aggregate digest payload without evicting a rejection while soft rows remain", async () => {
    expect(MAX_HOME_BASE_DISMISSAL_BYTES_PER_ATLAS)
      .toBe(MAX_HOME_BASE_DISMISSALS_PER_ATLAS * HOME_BASE_EVIDENCE_DIGEST_MAX_LENGTH);

    const protectedRejection = validDismissalDigest(-70, 19, "2025-01-01", "2025-04-15");
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "rejected",
      digest: protectedRejection,
      dismissedOn: "2025-04-16",
    });

    for (let index = 0; index < MAX_HOME_BASE_DISMISSALS_PER_ATLAS - 1; index += 1) {
      await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
        kind: "soft",
        digest: validDismissalDigest(
          -60 + index * 2,
          20,
          "2026-01-01",
          "2026-04-15",
        ),
        dismissedOn: "2026-04-16",
      });
    }

    const newestDigest = validDismissalDigest(70, 80, "2026-01-01", "2026-04-15");
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft",
      digest: newestDigest,
      dismissedOn: "2026-04-17",
    });

    const rows = await db
      .select({ kind: homeBaseDismissals.kind, digest: homeBaseDismissals.evidenceDigest })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    expect(rows).toHaveLength(MAX_HOME_BASE_DISMISSALS_PER_ATLAS);
    expect(rows).toContainEqual({ kind: "rejected", digest: protectedRejection });
    expect(rows).toContainEqual({ kind: "soft", digest: newestDigest });
    expect(rows.reduce((total, row) => total + row.digest.length, 0))
      .toBeLessThanOrEqual(MAX_HOME_BASE_DISMISSAL_BYTES_PER_ATLAS);
  });

  it("never downgrades an explicit rejection for the same evidence to a later soft dismissal", async () => {
    const first = await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "rejected",
      digest: DIGEST,
      dismissedOn: "2026-04-02",
    });
    expect(first).toEqual({ kind: "rejected", digest: DIGEST, dismissedAt: "2026-04-02" });
    const retry = await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "soft",
      digest: DIGEST,
      dismissedOn: "2026-05-02",
    });
    expect(retry).toEqual({ kind: "rejected", digest: DIGEST, dismissedAt: "2026-04-02" });
  });

  it("refuses an unusable body and a request with no session", async () => {
    const invalid = await postDismissal(neighbour.cookie, {
      kind: "soft",
      evidenceDigest: "not-a-digest",
      dismissedOn: "2026-04-02",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "INVALID_HOME_BASE_DISMISSAL" });
    expect((await postDismissal("", {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    })).status).toBe(401);
    const anonymousRead = await app.request(
      TEST_ORIGIN + "/api/home-bases/dismissal",
      { headers: authHeaders() },
    );
    expect(anonymousRead.status).toBe(401);
  });
});

describe("suggested confirmation revalidates one authoritative Atlas snapshot", () => {
  let digest = "";
  let evaluationDate = "";

  async function clearNeighbourHomeState() {
    await db.delete(homeBaseDismissals).where(eq(homeBaseDismissals.atlasId, neighbour.atlasId));
    await db.delete(homeBasePeriods).where(eq(homeBasePeriods.atlasId, neighbour.atlasId));
    await db.delete(journeys).where(eq(journeys.atlasId, neighbour.atlasId));
  }

  function confirmationBody() {
    return {
      label: "Home",
      latitude: 22.5431,
      longitude: 114.0579,
      startedOn: "2026-01-01",
      endedOn: null,
      source: "suggested-confirmed",
      suggestionProof: {
        evidenceDigest: digest,
        evaluationDate,
        expectedState: "suggested",
        expectedCurrentHome: null,
      },
    };
  }

  beforeEach(async () => {
    await clearNeighbourHomeState();
    evaluationDate = new Date().toISOString().slice(0, 10);
    digest = await seedDismissalSuggestion(neighbour.atlasId);
  });

  afterEach(async () => {
    await clearNeighbourHomeState();
  });

  it("writes the period only while the same rendered suggestion is still authoritative", async () => {
    const response = await post(neighbour.cookie, confirmationBody());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      period: {
        label: "Home",
        latitude: 22.5431,
        longitude: 114.0579,
        startedOn: "2026-01-01",
        endedOn: null,
        source: "suggested-confirmed",
      },
    });
  });

  it("rejects the stale confirm when supporting Journey evidence changed after render", async () => {
    const [support] = await db
      .select({ id: journeys.id })
      .from(journeys)
      .where(eq(journeys.atlasId, neighbour.atlasId))
      .limit(1);
    expect(support).toBeTruthy();
    if (!support) throw new Error("expected seeded Home evidence");
    await db.delete(journeys).where(eq(journeys.id, support.id));

    const response = await post(neighbour.cookie, confirmationBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "STALE_HOME_BASE_SUGGESTION" });
    const periods = await db
      .select({ id: homeBasePeriods.id })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.atlasId, neighbour.atlasId));
    expect(periods).toEqual([]);
  });

  it("rejects a stale confirmation when only the supporting Place Label changed", async () => {
    const supports = await db
      .select({ id: journeys.id })
      .from(journeys)
      .where(eq(journeys.atlasId, neighbour.atlasId));
    await db
      .update(journeyRoutePoints)
      .set({ label: "Renamed Home" })
      .where(inArray(journeyRoutePoints.journeyId, supports.map((journey) => journey.id)));

    const response = await post(neighbour.cookie, confirmationBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "STALE_HOME_BASE_SUGGESTION" });
    const periods = await db
      .select({ id: homeBasePeriods.id })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.atlasId, neighbour.atlasId));
    expect(periods).toEqual([]);
  });

  it("does not reinterpret a stale initial confirm as a move after Home context changed", async () => {
    const current = await post(neighbour.cookie, {
      ...SHENZHEN,
      label: "Current Home",
      startedOn: "2020-01-01",
    });
    expect(current.status).toBe(201);

    const response = await post(neighbour.cookie, confirmationBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "STALE_HOME_BASE_SUGGESTION" });
    const periods = await db
      .select({ label: homeBasePeriods.label, endedOn: homeBasePeriods.endedOn })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.atlasId, neighbour.atlasId));
    expect(periods).toEqual([{ label: "Current Home", endedOn: null }]);
  });

  it("lets a newer same-region rejection win over the stale confirm", async () => {
    await recordHomeBaseDismissalForAtlas(neighbour.atlasId, {
      kind: "rejected",
      digest,
      dismissedOn: evaluationDate,
    });

    const response = await post(neighbour.cookie, confirmationBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "STALE_HOME_BASE_SUGGESTION" });
    const periods = await db
      .select({ id: homeBasePeriods.id })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.atlasId, neighbour.atlasId));
    expect(periods).toEqual([]);
  });
});

describe("PATCH and DELETE /api/home-bases/:periodId", () => {
  it("answers 404 for a period belonging to another atlas", async () => {
    const created = await post(neighbour.cookie, {
      ...SHENZHEN,
      label: "Lisbon",
      startedOn: "2019-01-01",
      endedOn: "2020-01-01",
    });
    expect(created.status).toBe(201);
    const { period } = await created.json() as { period: { id: string } };

    const patch = await app.request(
      `${TEST_ORIGIN}/api/home-bases/${period.id}`,
      {
        method: "PATCH",
        headers: authHeaders(resident.cookie),
        body: JSON.stringify({ label: "Stolen" }),
      },
    );
    expect(patch.status).toBe(404);
    expect(await patch.json()).toMatchObject({
      error: "HOME_BASE_PERIOD_NOT_FOUND",
    });

    const remove = await app.request(
      `${TEST_ORIGIN}/api/home-bases/${period.id}`,
      { method: "DELETE", headers: authHeaders(resident.cookie) },
    );
    expect(remove.status).toBe(404);

    // Untouched in the atlas that owns it.
    const [row] = await db
      .select({ label: homeBasePeriods.label })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.id, period.id));
    expect(row.label).toBe("Lisbon");
  });

  it("answers 404 for an id that is not a period id at all", async () => {
    const response = await app.request(
      `${TEST_ORIGIN}/api/home-bases/not-a-uuid`,
      {
        method: "PATCH",
        headers: authHeaders(resident.cookie),
        body: JSON.stringify({ label: "Nowhere" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("corrects and then removes a period the atlas owns", async () => {
    const created = await post(neighbour.cookie, {
      ...SHENZHEN,
      label: "Porto",
      startedOn: "2014-01-01",
      endedOn: "2015-01-01",
    });
    const { period } = await created.json() as { period: { id: string } };

    const patch = await app.request(
      `${TEST_ORIGIN}/api/home-bases/${period.id}`,
      {
        method: "PATCH",
        headers: authHeaders(neighbour.cookie),
        body: JSON.stringify({ label: "Porto Metro", endedOn: "2015-06-01" }),
      },
    );
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      period: { id: period.id, label: "Porto Metro", endedOn: "2015-06-01" },
    });

    const remove = await app.request(
      `${TEST_ORIGIN}/api/home-bases/${period.id}`,
      { method: "DELETE", headers: authHeaders(neighbour.cookie) },
    );
    expect(remove.status).toBe(204);
    expect(await db
      .select({ id: homeBasePeriods.id })
      .from(homeBasePeriods)
      .where(eq(homeBasePeriods.id, period.id))).toEqual([]);
  });
});

describe("GET /api/home-bases", () => {
  it("serves the atlas history oldest first and never caches it", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/home-bases`, {
      headers: authHeaders(resident.cookie),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const { periods } = await response.json() as {
      periods: Array<{ startedOn: string }>;
    };
    const starts = periods.map((period) => period.startedOn);
    expect([...starts].sort()).toEqual(starts);
  });
});
