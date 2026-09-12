import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, homeBaseDismissals, homeBasePeriods } from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { hasAtlasPermission } from "../authorization/permissions";
import { db, pool } from "../db/client";
import { parseHomeBaseDismissalInput, parseHomeBaseInput, parseHomeBasePatch } from "./home-bases";

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
  const DIGEST = "hbv1:22.5431:114.0579:4:2026-01-01:2026-04-01:j1=11,j2=11,j3=11,j4=11:1a2b3c4d";

  it("accepts only the two answers the product defines", () => {
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    })).toEqual({ kind: "soft", digest: DIGEST, dismissedOn: "2026-04-02" });
    expect(parseHomeBaseDismissalInput({
      kind: "rejected",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    })).toMatchObject({ kind: "rejected" });
    expect(parseHomeBaseDismissalInput({
      kind: "snoozed",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    })).toBeNull();
  });

  it("keeps the evidence digest byte-exact instead of trimming or capping it", () => {
    // The inference core parses the region anchor and the supporting Journey
    // ids back out of this string. Normalising it here would silently disarm
    // the 90-day / 2-new-Journey re-prompt rule.
    const padded = ` ${DIGEST} `;
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: padded,
      dismissedOn: "2026-04-02",
    })?.digest).toBe(padded);
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: "",
      dismissedOn: "2026-04-02",
    })).toBeNull();
  });

  it("refuses a dismissal date that is not a fixed-width calendar date", () => {
    expect(parseHomeBaseDismissalInput({
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-4-2",
    })).toBeNull();
  });
});

describe("GET and POST /api/home-bases/dismissal", () => {
  const DIGEST = "hbv1:22.5431:114.0579:4:2026-01-01:2026-04-01:r1=11,r2=11,r3=11,r4=11:deadbeef";

  async function postDismissal(cookie: string, body: unknown) {
    return await app.request(`${TEST_ORIGIN}/api/home-bases/dismissal`, {
      method: "POST",
      headers: authHeaders(cookie),
      body: JSON.stringify(body),
    });
  }

  it("derives the atlas from the session and ignores an atlas or organization id in the body", async () => {
    const response = await postDismissal(resident.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
      atlasId: neighbour.atlasId,
      organizationId: neighbour.organizationId,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      dismissal: { kind: "soft", digest: DIGEST, dismissedAt: "2026-04-02" },
    });

    // The row landed in the session's own atlas, not the one the body named.
    const rows = await db
      .select({ atlasId: homeBaseDismissals.atlasId })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.evidenceDigest, DIGEST));
    expect(rows.map((row) => row.atlasId)).toEqual([resident.atlasId]);

    // And the named atlas still has no answer on record.
    const neighbourRead = await app.request(
      `${TEST_ORIGIN}/api/home-bases/dismissal`,
      { headers: authHeaders(neighbour.cookie) },
    );
    expect(neighbourRead.status).toBe(200);
    expect(await neighbourRead.json()).toEqual({ dismissals: [] });
  });

  it("preserves answers for different evidence regions instead of replacing the Atlas row", async () => {
    const second = "hbi-v2:35.6895:139.6917:4:2026-05-01:2026-08-01:t1=11,t2=11,t3=11,t4=11:feedbeef";
    expect((await postDismissal(resident.cookie, {
      kind: "rejected",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    })).status).toBe(201);
    expect((await postDismissal(resident.cookie, {
      kind: "soft",
      evidenceDigest: second,
      dismissedOn: "2026-07-01",
    })).status).toBe(201);

    const read = await app.request(`${TEST_ORIGIN}/api/home-bases/dismissal`, {
      headers: authHeaders(resident.cookie),
    });
    expect(await read.json()).toEqual({
      dismissals: [
        { kind: "rejected", digest: DIGEST, dismissedAt: "2026-04-02" },
        { kind: "soft", digest: second, dismissedAt: "2026-07-01" },
      ],
    });
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(homeBaseDismissals)
      .where(eq(homeBaseDismissals.atlasId, resident.atlasId));
    expect(row.total).toBe(2);
  });

  it("never downgrades an explicit rejection for the same evidence to a later soft dismissal", async () => {
    expect((await postDismissal(resident.cookie, {
      kind: "rejected",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-04-02",
    })).status).toBe(201);
    const retry = await postDismissal(resident.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
      dismissedOn: "2026-05-02",
    });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({
      dismissal: { kind: "rejected", digest: DIGEST, dismissedAt: "2026-04-02" },
    });
  });

  it("refuses an unusable body and a request with no session", async () => {
    const invalid = await postDismissal(resident.cookie, {
      kind: "soft",
      evidenceDigest: DIGEST,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "INVALID_HOME_BASE_DISMISSAL" });
    expect((await postDismissal("", { kind: "soft", evidenceDigest: DIGEST, dismissedOn: "2026-04-02" })).status)
      .toBe(401);
    const anonymous = await app.request(`${TEST_ORIGIN}/api/home-bases/dismissal`, {
      headers: authHeaders(),
    });
    expect(anonymous.status).toBe(401);
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
