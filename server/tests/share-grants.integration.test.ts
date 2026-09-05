import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import {
  generateShareToken,
  hashShareToken,
  MAX_SHARE_LIFETIME_MS,
  ShareAccessError,
} from "../authorization/share-access";
import { serverConfig } from "../config";
import {
  atlases,
  journeyRoutePoints,
  journeys,
  mediaAssets,
  shareGrantJourneys,
  shareGrants,
} from "../db/app-schema";
import {
  organization as authOrganizations,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  createJourneyForAtlas,
  markJourneyForDeletionForAtlas,
} from "../repositories/journey-repository";
import { loadSharedJourneyView } from "../repositories/shared-journey-repository";
import {
  capShareMediaTtlSeconds,
  resolveSharedMediaRead,
} from "../repositories/shared-media-repository";
import { signSharedMediaRead } from "../routes/shares";
import { disabledStorage } from "../storage/disabled-storage";

const TEST_ORIGIN = "http://127.0.0.1:5173";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
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
  ],
};

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// One verified identity for the whole file: Better Auth rate-limits sign-ups
// independently of the anonymous limiter that exempts `/api/auth`.
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

/** A grant row written straight to the database, for states no API can create. */
async function insertGrant(atlasId: string, journeyId: string, expiresAt: Date) {
  const rawToken = generateShareToken();
  const [grant] = await db
    .insert(shareGrants)
    .values({
      atlasId,
      createdByUserId: "fixture-user",
      tokenHash: hashShareToken(rawToken),
      expiresAt,
    })
    .returning({ id: shareGrants.id });
  await db
    .insert(shareGrantJourneys)
    .values({ shareGrantId: grant.id, journeyId, sortOrder: 0 });
  return { id: grant.id, token: rawToken };
}

/** A grant created the way the product creates one, returning its raw token. */
async function createShare(journeyIds: string[]): Promise<string> {
  const response = await app.request(`${TEST_ORIGIN}/api/shares`, {
    method: "POST",
    headers: authHeaders(identity.cookie),
    body: JSON.stringify({ journeyIds, expiresAt: inDays(7) }),
  });
  expect(response.status).toBe(201);
  const { token } = await response.json() as { token: string };
  return token;
}

let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
let journeyA = "";
let journeyB = "";
let foreignAtlasId = "";
let foreignJourneyId = "";

beforeAll(async () => {
  identity = await createAuthenticatedAtlas("Sharer");
  const [first, second] = await Promise.all([
    createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Shared north",
    }),
    createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      startedOn: "2026-08-20",
      endedOn: "2026-08-21",
      title: "Shared south",
    }),
  ]);
  if (!first || !second) throw new Error("Journey fixtures were not created");
  journeyA = first.id;
  journeyB = second.id;

  const [foreignAtlas] = await db
    .insert(atlases)
    .values({
      organizationId: `test-org-share-foreign-${randomUUID()}`,
      title: "Foreign Atlas",
    })
    .returning({ id: atlases.id });
  foreignAtlasId = foreignAtlas.id;
  atlasIds.push(foreignAtlasId);
  const foreign = await createJourneyForAtlas(foreignAtlasId, "user-foreign", {
    ...baseJourney,
    title: "Never shared",
  });
  if (!foreign) throw new Error("Foreign journey fixture was not created");
  foreignJourneyId = foreign.id;
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

describe("share grant creation", () => {
  it("stores only the hash and hands the raw token back exactly once", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyIds: [journeyB, journeyA], expiresAt: inDays(7) }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const created = await response.json() as {
      share: { id: string; journeyCount: number; expiresAt: string; createdAt: string };
      token: string;
    };
    expect(created.share.journeyCount).toBe(2);
    expect(created.token).toMatch(TOKEN_SHAPE);

    const [stored] = await db
      .select()
      .from(shareGrants)
      .where(eq(shareGrants.id, created.share.id));
    expect(stored.tokenHash).toBe(hashShareToken(created.token));
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(stored.atlasId).toBe(identity.atlasId);
    expect(stored.createdByUserId).toBe(identity.userId);
    expect(stored.revokedAt).toBeNull();
    expect(stored.lastAccessedAt).toBeNull();

    // Canonical journey chronology, not the order the client submitted.
    const selected = await db
      .select({ journeyId: shareGrantJourneys.journeyId })
      .from(shareGrantJourneys)
      .where(eq(shareGrantJourneys.shareGrantId, created.share.id))
      .orderBy(shareGrantJourneys.sortOrder);
    expect(selected.map((row) => row.journeyId)).toEqual([journeyA, journeyB]);

    // The owner list never returns a token, and reports the active status.
    const listResponse = await app.request(`${TEST_ORIGIN}/api/shares`, {
      headers: authHeaders(identity.cookie),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.text();
    expect(listBody).not.toContain(created.token);
    expect(listBody).not.toContain(stored.tokenHash);
    const { shares } = JSON.parse(listBody) as {
      shares: Array<{
        id: string;
        status: string;
        journeyCount: number;
        journeys: Array<{ id: string; title: string }>;
      }>;
    };
    const listed = shares.find((share) => share.id === created.share.id);
    expect(listed).toMatchObject({ status: "active", journeyCount: 2 });
    expect(listed?.journeys.map((journey) => journey.title)).toEqual([
      "Shared north",
      "Shared south",
    ]);
  });

  it("rejects an empty, duplicated, expired or over-long selection", async () => {
    const invalidBodies = [
      { journeyIds: [], expiresAt: inDays(7) },
      { journeyIds: [journeyA, journeyA], expiresAt: inDays(7) },
      { journeyIds: [journeyA], expiresAt: inDays(-1) },
      { journeyIds: [journeyA], expiresAt: "not a date" },
      { journeyIds: ["not-a-uuid"], expiresAt: inDays(7) },
      {
        journeyIds: [journeyA],
        expiresAt: new Date(Date.now() + MAX_SHARE_LIFETIME_MS + 60_000).toISOString(),
      },
    ];
    for (const body of invalidBodies) {
      const response = await app.request(`${TEST_ORIGIN}/api/shares`, {
        method: "POST",
        headers: authHeaders(identity.cookie),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_SHARE",
      });
    }
  });

  it("refuses a journey from another atlas or one that started deleting", async () => {
    const foreign = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyIds: [journeyA, foreignJourneyId],
        expiresAt: inDays(7),
      }),
    });
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({
      error: "JOURNEY_NOT_FOUND",
    });

    const doomed = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Deleting journey",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId);
    const grantsBefore = await db
      .select({ id: shareGrants.id })
      .from(shareGrants)
      .where(eq(shareGrants.atlasId, identity.atlasId));
    const deleting = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyIds: [doomed.id], expiresAt: inDays(7) }),
    });
    expect(deleting.status).toBe(404);
    await expect(deleting.json()).resolves.toMatchObject({
      error: "JOURNEY_NOT_FOUND",
    });

    // The selection and the `deletion_started_at` checks run inside the
    // insert transaction under the Atlas row lock, so a refusal leaves
    // nothing behind: no grant row, and therefore no token that
    // `requireActiveShareGrant` would have to reject on sight. A genuine
    // concurrent race cannot be driven deterministically from this suite
    // without a second connection and lock choreography, so this asserts the
    // in-transaction check itself.
    const grantsAfter = await db
      .select({ id: shareGrants.id })
      .from(shareGrants)
      .where(eq(shareGrants.atlasId, identity.atlasId));
    expect(grantsAfter).toHaveLength(grantsBefore.length);
  });

  it("rejects a well-formed JSON body that is not an object", async () => {
    for (const body of ["null", "42", '"journeyIds"', "[]"]) {
      const response = await app.request(`${TEST_ORIGIN}/api/shares`, {
        method: "POST",
        headers: authHeaders(identity.cookie),
        body,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_SHARE",
      });
    }
  });

  it("rejects a body that is not valid JSON", async () => {
    const grantsBefore = await db
      .select({ id: shareGrants.id })
      .from(shareGrants)
      .where(eq(shareGrants.atlasId, identity.atlasId));
    const response = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: '{"journeyIds": [',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_SHARE",
    });

    // The route answers a `SyntaxError` with its own envelope rather than the
    // global `INVALID_JSON`, and never reaches the insert.
    const grantsAfter = await db
      .select({ id: shareGrants.id })
      .from(shareGrants)
      .where(eq(shareGrants.atlasId, identity.atlasId));
    expect(grantsAfter).toHaveLength(grantsBefore.length);
  });

  it("requires atlas membership", async () => {
    const anonymous = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ journeyIds: [journeyA], expiresAt: inDays(7) }),
    });
    expect(anonymous.status).toBe(401);
    const anonymousList = await app.request(`${TEST_ORIGIN}/api/shares`, {
      headers: authHeaders(),
    });
    expect(anonymousList.status).toBe(401);
  });
});

describe("guest bearer resolution", () => {
  it("resolves an active grant and records the access", async () => {
    const created = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyIds: [journeyA], expiresAt: inDays(7) }),
    });
    expect(created.status).toBe(201);
    const { share, token } = await created.json() as {
      share: { id: string; expiresAt: string };
      token: string;
    };

    const guest = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(guest.status).toBe(200);
    expect(guest.headers.get("cache-control")).toBe("private, no-store");
    expect(guest.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(guest.json()).resolves.toEqual({
      expiresAt: share.expiresAt,
      journeyCount: 1,
    });

    const [accessed] = await db
      .select({ lastAccessedAt: shareGrants.lastAccessedAt })
      .from(shareGrants)
      .where(eq(shareGrants.id, share.id));
    expect(accessed.lastAccessedAt).not.toBeNull();
  });

  it("answers one generic 404 for a missing, malformed or unknown token", async () => {
    const headerSets = [
      undefined,
      { authorization: "Basic abc" },
      { authorization: "Bearer" },
      { authorization: `Bearer ${generateShareToken()}` },
      { authorization: "Bearer 00000000000000000000000000000000000000000" },
    ];
    for (const headers of headerSets) {
      const response = await app.request(
        `${TEST_ORIGIN}/api/shared/grant`,
        headers ? { headers } : undefined,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "SHARE_UNAVAILABLE",
        message: "Share link unavailable",
      });
    }
  });

  it("exposes no mutation route under the guest prefix", async () => {
    const created = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyIds: [journeyA], expiresAt: inDays(7) }),
    });
    const { token } = await created.json() as { token: string };
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(response.status).toBe(404);
    }

    // A share token is not a session: owner routes stay closed to it.
    const owner = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: { authorization: `Bearer ${token}`, origin: TEST_ORIGIN },
    });
    expect(owner.status).toBe(401);
  });

  it("stops resolving at the expiry instant", async () => {
    const expired = await insertGrant(
      identity.atlasId,
      journeyA,
      new Date(Date.now() - 1_000),
    );
    const guest = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${expired.token}` },
    });
    expect(guest.status).toBe(404);

    const list = await app.request(`${TEST_ORIGIN}/api/shares`, {
      headers: authHeaders(identity.cookie),
    });
    const { shares } = await list.json() as {
      shares: Array<{ id: string; status: string }>;
    };
    expect(shares.find((share) => share.id === expired.id)?.status).toBe("expired");
  });

  it("stops resolving once its atlas starts deleting", async () => {
    // An isolated atlas so marking it for deletion cannot disturb the
    // authenticated fixture the rest of the file shares.
    const [doomedAtlas] = await db
      .insert(atlases)
      .values({
        organizationId: `test-org-share-doomed-${randomUUID()}`,
        title: "Doomed Atlas",
      })
      .returning({ id: atlases.id });
    atlasIds.push(doomedAtlas.id);
    const journey = await createJourneyForAtlas(doomedAtlas.id, "user-doomed", {
      ...baseJourney,
      title: "Doomed journey",
    });
    if (!journey) throw new Error("Doomed journey fixture was not created");
    const grant = await insertGrant(
      doomedAtlas.id,
      journey.id,
      new Date(Date.now() + 60_000),
    );

    const before = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${grant.token}` },
    });
    expect(before.status).toBe(200);

    await db
      .update(atlases)
      .set({ deletionStartedAt: new Date() })
      .where(eq(atlases.id, doomedAtlas.id));

    const after = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${grant.token}` },
    });
    expect(after.status).toBe(404);
    await expect(after.json()).resolves.toMatchObject({
      error: "SHARE_UNAVAILABLE",
    });
  });
});

describe("share grant revocation", () => {
  it("is idempotent and stops guest access immediately", async () => {
    const created = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyIds: [journeyA], expiresAt: inDays(7) }),
    });
    const { share, token } = await created.json() as {
      share: { id: string };
      token: string;
    };

    const revoked = await app.request(
      `${TEST_ORIGIN}/api/shares/${share.id}/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(revoked.status).toBe(200);
    const firstRevoke = await revoked.json() as {
      share: { revokedAt: string; status: string };
    };
    expect(firstRevoke.share.status).toBe("revoked");

    const guest = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(guest.status).toBe(404);

    const again = await app.request(
      `${TEST_ORIGIN}/api/shares/${share.id}/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(again.status).toBe(200);
    const secondRevoke = await again.json() as {
      share: { revokedAt: string };
    };
    expect(secondRevoke.share.revokedAt).toBe(firstRevoke.share.revokedAt);
  });

  it("cannot revoke a grant outside the caller's atlas", async () => {
    const journey = await createJourneyForAtlas(foreignAtlasId, "user-foreign", {
      ...baseJourney,
      title: "Foreign shared",
    });
    if (!journey) throw new Error("Foreign journey fixture was not created");
    const foreignGrant = await insertGrant(
      foreignAtlasId,
      journey.id,
      new Date(Date.now() + 60_000),
    );

    const response = await app.request(
      `${TEST_ORIGIN}/api/shares/${foreignGrant.id}/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "SHARE_NOT_FOUND",
    });

    // Still resolvable for its own recipients: the failed revoke changed nothing.
    const guest = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${foreignGrant.token}` },
    });
    expect(guest.status).toBe(200);
  });

  it("returns 404 rather than a database error for a malformed id", async () => {
    const response = await app.request(
      `${TEST_ORIGIN}/api/shares/not-a-uuid/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "SHARE_NOT_FOUND",
    });
  });
});

describe("share grant lifecycle", () => {
  it("cascades grants away when the atlas row is hard-deleted", async () => {
    const [temporaryAtlas] = await db
      .insert(atlases)
      .values({
        organizationId: `test-org-share-cascade-${randomUUID()}`,
        title: "Cascade Atlas",
      })
      .returning({ id: atlases.id });
    const journey = await createJourneyForAtlas(temporaryAtlas.id, "user-cascade", {
      ...baseJourney,
      title: "Cascade journey",
    });
    if (!journey) throw new Error("Cascade journey fixture was not created");
    const grant = await insertGrant(
      temporaryAtlas.id,
      journey.id,
      new Date(Date.now() + 60_000),
    );

    await db.delete(atlases).where(eq(atlases.id, temporaryAtlas.id));

    const remaining = await db
      .select({ id: shareGrants.id })
      .from(shareGrants)
      .where(eq(shareGrants.id, grant.id));
    expect(remaining).toHaveLength(0);
    const remainingSelection = await db
      .select({ journeyId: shareGrantJourneys.journeyId })
      .from(shareGrantJourneys)
      .where(eq(shareGrantJourneys.shareGrantId, grant.id));
    expect(remainingSelection).toHaveLength(0);
  });

  it("cascades a hard-deleted journey out of every grant scope", async () => {
    const journey = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Hard deleted journey",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const grant = await insertGrant(
      identity.atlasId,
      journey.id,
      new Date(Date.now() + 60_000),
    );

    await db.delete(journeys).where(eq(journeys.id, journey.id));

    const remaining = await db
      .select({ journeyId: shareGrantJourneys.journeyId })
      .from(shareGrantJourneys)
      .where(eq(shareGrantJourneys.shareGrantId, grant.id));
    expect(remaining).toHaveLength(0);
    // The grant itself survives; Phase B decides what an empty scope shows.
    const guest = await app.request(`${TEST_ORIGIN}/api/shared/grant`, {
      headers: { authorization: `Bearer ${grant.token}` },
    });
    expect(guest.status).toBe(200);
    await expect(guest.json()).resolves.toMatchObject({ journeyCount: 0 });
  });
});

/**
 * #200 phase B. Every assertion here is about `GET /api/shared/journeys`:
 * what one grant may reach, what it may not, and what a guest sees once the
 * grant stops authorizing anything.
 */
describe("guest journey read", () => {
  type GuestPayload = {
    share: { expiresAt: string; journeyCount: number };
    journeys: Array<{
      id: string;
      title: string;
      previousJourneyId: string | null;
      nextJourneyId: string | null;
      routePoints: Array<{ id: string; label: string }>;
      media: Array<{ id: string; fileName: string }>;
    }>;
  };

  const PRIVATE_TITLE = "Private aurora ridge never shared";
  const SHARED_STORAGE_KEY = `share-phase-b/${randomUUID()}/shared.jpg`;
  let privateJourneyId = "";
  let sharedMediaId = "";

  function guestRead(token: string) {
    return app.request(`${TEST_ORIGIN}/api/shared/journeys`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    // An unshared journey in the SAME atlas: the interesting leak is a
    // neighbour of the shared journeys, not a stranger's atlas.
    const privateJourney = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, startedOn: "2026-08-15", title: PRIVATE_TITLE },
    );
    if (!privateJourney) throw new Error("Private journey fixture was not created");
    privateJourneyId = privateJourney.id;

    // Media has no reachable write path without a storage driver, so the row
    // is written straight in. Its storage key is the field that must never
    // reach a guest.
    const [routePoint] = await db
      .select({ id: journeyRoutePoints.id })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyA))
      .limit(1);
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId: journeyA,
        routePointId: routePoint.id,
        storageDriver: "s3",
        storageKey: SHARED_STORAGE_KEY,
        fileName: "shared.jpg",
        mimeType: "image/jpeg",
        bytes: 2048,
        contentHash: "phase-b-content-hash",
        uploadedByUserId: identity.userId,
      })
      .returning({ id: mediaAssets.id });
    sharedMediaId = asset.id;
  });

  it("answers a single-journey grant with exactly that journey", async () => {
    const token = await createShare([journeyA]);
    const response = await guestRead(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const payload = await response.json() as GuestPayload;
    expect(payload.share.journeyCount).toBe(1);
    expect(payload.journeys.map((journey) => journey.id)).toEqual([journeyA]);
    expect(payload.journeys[0].title).toBe("Shared north");
    expect(payload.journeys[0].routePoints.map((point) => point.label))
      .toEqual(["Singapore"]);
    expect(payload.journeys[0].media.map((asset) => asset.id))
      .toEqual([sharedMediaId]);
  });

  it("answers a multi-journey grant with exactly the granted set in its recorded order", async () => {
    const token = await createShare([journeyB, journeyA]);
    const payload = await (await guestRead(token)).json() as GuestPayload;
    expect(payload.share.journeyCount).toBe(2);
    // Canonical chronology recorded at creation, not the client's argument
    // order and not re-derived at read time.
    expect(payload.journeys.map((journey) => journey.id))
      .toEqual([journeyA, journeyB]);
  });

  it("closes previous/next navigation at both edges of the granted set", async () => {
    const token = await createShare([journeyA, journeyB]);
    const payload = await (await guestRead(token)).json() as GuestPayload;
    expect(payload.journeys[0]).toMatchObject({
      previousJourneyId: null,
      nextJourneyId: journeyB,
    });
    expect(payload.journeys[1]).toMatchObject({
      previousJourneyId: journeyA,
      nextJourneyId: null,
    });
    const reachable = payload.journeys.flatMap((journey) =>
      [journey.previousJourneyId, journey.nextJourneyId].filter(
        (id): id is string => id !== null,
      ));
    const granted = new Set(payload.journeys.map((journey) => journey.id));
    expect(reachable.every((id) => granted.has(id))).toBe(true);
  });

  it("leaks no unshared journey, owner field or storage key through the payload", async () => {
    const token = await createShare([journeyA]);
    const body = await (await guestRead(token)).text();

    // Nothing about the same atlas's other journeys, or another atlas's.
    expect(body).not.toContain(privateJourneyId);
    expect(body).not.toContain(PRIVATE_TITLE);
    expect(body).not.toContain(journeyB);
    expect(body).not.toContain("Shared south");
    expect(body).not.toContain(foreignJourneyId);
    expect(body).not.toContain("Never shared");
    // Nor the private plumbing of the journey it does share.
    expect(body).not.toContain(SHARED_STORAGE_KEY);
    expect(body).not.toContain("phase-b-content-hash");
    expect(body).not.toContain(identity.atlasId);
    expect(body).not.toContain(identity.userId);
    expect(body).not.toContain("storageKey");
    expect(body).not.toContain("sortOrder");
    expect(body).not.toContain("createdByUserId");
    expect(body).not.toContain("uploadedByUserId");
    expect(body).not.toContain("atlasId");
    expect(body).not.toContain("deletion");
    // No aggregate or ordering hint that a wider set exists.
    const payload = JSON.parse(body) as GuestPayload;
    expect(Object.keys(payload).sort()).toEqual(["journeys", "share"]);
    expect(Object.keys(payload.share).sort()).toEqual([
      "expiresAt",
      "journeyCount",
    ]);
  });

  it("drops a granted journey once it starts deleting", async () => {
    const doomed = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      startedOn: "2026-08-25",
      title: "Deleting shared journey",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    const token = await createShare([journeyA, doomed.id]);

    const before = await (await guestRead(token)).json() as GuestPayload;
    expect(before.journeys.map((journey) => journey.id))
      .toEqual([journeyA, doomed.id]);

    await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId);

    const response = await guestRead(token);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(doomed.id);
    expect(body).not.toContain("Deleting shared journey");
    const after = JSON.parse(body) as GuestPayload;
    expect(after.share.journeyCount).toBe(1);
    // The survivor's navigation closes over what is left, not over what the
    // grant originally selected.
    expect(after.journeys[0]).toMatchObject({
      id: journeyA,
      previousJourneyId: null,
      nextJourneyId: null,
    });
  });

  it("answers an emptied grant scope with an empty set rather than the unavailable state", async () => {
    const solo = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      startedOn: "2026-08-27",
      title: "Sole shared journey",
    });
    if (!solo) throw new Error("Journey fixture was not created");
    const token = await createShare([solo.id]);
    await markJourneyForDeletionForAtlas(solo.id, identity.atlasId);

    const response = await guestRead(token);
    expect(response.status).toBe(200);
    const payload = await response.json() as GuestPayload;
    expect(payload.journeys).toEqual([]);
    expect(payload.share.journeyCount).toBe(0);
    expect(payload.share.expiresAt).toBeTruthy();
  });

  it("answers one indistinguishable unavailable state for expired, revoked, deleting-atlas and unknown tokens", async () => {
    const expired = await insertGrant(
      identity.atlasId,
      journeyA,
      new Date(Date.now() - 1_000),
    );

    const revokedToken = await createShare([journeyA]);
    const revokedHash = hashShareToken(revokedToken);
    const [toRevoke] = await db
      .select({ id: shareGrants.id })
      .from(shareGrants)
      .where(eq(shareGrants.tokenHash, revokedHash));
    const revokeResponse = await app.request(
      `${TEST_ORIGIN}/api/shares/${toRevoke.id}/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(revokeResponse.status).toBe(200);

    // An atlas of its own, so marking it deleting cannot disturb the shared
    // authenticated fixture.
    const [doomedAtlas] = await db
      .insert(atlases)
      .values({
        organizationId: `test-org-share-guest-${randomUUID()}`,
        title: "Doomed guest atlas",
      })
      .returning({ id: atlases.id });
    atlasIds.push(doomedAtlas.id);
    const doomedJourney = await createJourneyForAtlas(doomedAtlas.id, "user-doomed", {
      ...baseJourney,
      title: "Doomed guest journey",
    });
    if (!doomedJourney) throw new Error("Doomed journey fixture was not created");
    const doomedGrant = await insertGrant(
      doomedAtlas.id,
      doomedJourney.id,
      new Date(Date.now() + 60_000),
    );
    await db
      .update(atlases)
      .set({ deletionStartedAt: new Date() })
      .where(eq(atlases.id, doomedAtlas.id));

    const responses = [
      await guestRead(expired.token),
      await guestRead(revokedToken),
      await guestRead(doomedGrant.token),
      await guestRead(generateShareToken()),
      await guestRead("not-a-token"),
      await app.request(`${TEST_ORIGIN}/api/shared/journeys`),
      await app.request(`${TEST_ORIGIN}/api/shared/journeys`, {
        headers: { authorization: "Basic abc" },
      }),
    ];
    const bodies = new Set<string>();
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      bodies.add(await response.text());
    }
    // One body for every cause: a probe cannot tell an expired grant from a
    // token that never existed.
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(JSON.stringify({
      error: "SHARE_UNAVAILABLE",
      message: "Share link unavailable",
    }));
  });

  it("exposes no mutation method on the guest journey read", async () => {
    const token = await createShare([journeyA]);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await app.request(`${TEST_ORIGIN}/api/shared/journeys`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(response.status).toBe(404);
    }

    // The bearer capability is not a session, so the owner journey routes it
    // would need in order to mutate anything stay closed to it.
    for (const path of ["/api/journeys", `/api/journeys/${journeyA}`]) {
      const response = await app.request(`${TEST_ORIGIN}${path}`, {
        headers: { authorization: `Bearer ${token}`, origin: TEST_ORIGIN },
      });
      expect(response.status).toBe(401);
    }
  });

  it("cannot be widened to another atlas by a request parameter", async () => {
    const token = await createShare([journeyA]);
    // The scope comes from the grant the bearer token resolves to. There is no
    // path, query or body parameter through which a guest could name a journey
    // or an atlas, so an added one changes nothing.
    const probe = await app.request(
      `${TEST_ORIGIN}/api/shared/journeys?journeyId=${foreignJourneyId}&atlasId=${foreignAtlasId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(probe.status).toBe(200);
    const body = await probe.text();
    expect(body).not.toContain(foreignJourneyId);
    expect(body).not.toContain("Never shared");
    const probed = JSON.parse(body) as GuestPayload;
    expect(probed.journeys.map((journey) => journey.id)).toEqual([journeyA]);
  });
  it("refuses a grant withdrawn between authorization and the payload read", async () => {
    const token = await createShare([journeyA]);
    const [row] = await db
      .select({
        id: shareGrants.id,
        atlasId: shareGrants.atlasId,
        expiresAt: shareGrants.expiresAt,
      })
      .from(shareGrants)
      .where(eq(shareGrants.tokenHash, hashShareToken(token)));
    // Exactly the object `requireActiveShareGrant` hands the read once it has
    // authorized the bearer token, so calling the read with it directly is the
    // race: authorization already succeeded, and the withdrawal commits before
    // the payload is assembled.
    const authorized = {
      id: row.id,
      atlasId: row.atlasId,
      expiresAt: row.expiresAt,
    };
    await expect(loadSharedJourneyView(authorized)).resolves.toMatchObject({
      share: { journeyCount: 1 },
    });

    const revoke = await app.request(
      `${TEST_ORIGIN}/api/shares/${row.id}/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(revoke.status).toBe(200);

    // The grant is re-evaluated inside the read's own snapshot, so the stale
    // authorization no longer buys a payload.
    await expect(loadSharedJourneyView(authorized)).rejects.toThrow(
      ShareAccessError,
    );
    const response = await guestRead(token);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "SHARE_UNAVAILABLE",
    });
  });
});

/**
 * #200 phase C. Every assertion here is about
 * `GET /api/shared/assets/:assetId/read-url`: which assets one grant may have
 * signed for it, how long the signature may live, and what a guest is told
 * when the answer is no.
 *
 * Object storage is not configured in this environment, so no test here
 * asserts a signed URL. The route-level cases prove the authorization decision
 * and the two unavailable shapes; the resolver is called directly for the
 * storage key and the capped lifetime, the way the phase B tests call
 * `loadSharedJourneyView`.
 */
describe("guest media read", () => {
  const GRANTED_STORAGE_KEY = `share-phase-c/${randomUUID()}/granted.jpg`;
  const UNSHARED_STORAGE_KEY = `share-phase-c/${randomUUID()}/unshared.jpg`;
  const UNSHARED_TITLE = "Unshared journey holding phase C media";
  const MEDIA_UNAVAILABLE_BODY = JSON.stringify({
    error: "MEDIA_UNAVAILABLE",
    message: "Media unavailable",
  });
  const SHARE_UNAVAILABLE_BODY = JSON.stringify({
    error: "SHARE_UNAVAILABLE",
    message: "Share link unavailable",
  });
  const LIMITS = {
    shareTtlSeconds: serverConfig.shareMediaReadUrlExpiresInSeconds,
    ownerTtlSeconds: serverConfig.mediaReadUrlExpiresInSeconds,
  };

  /**
   * Object storage is unconfigured here, so the signing step is driven through
   * an injected adapter for the cases that are about the lifetime rather than
   * about the bucket. It records the duration it was asked for and honours it
   * exactly, which is the contract a real presign keeps.
   */
  const signedLifetimes: number[] = [];
  const fakeStorage = () => ({
    ...disabledStorage,
    driver: "s3",
    async createPrivateReadUrl(
      input: { key: string; expiresInSeconds: number },
    ) {
      signedLifetimes.push(input.expiresInSeconds);
      return {
        url: "https://storage.test/" + encodeURIComponent(input.key),
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
  });

  let unsharedJourneyId = "";
  let unsharedAssetId = "";
  let foreignAssetId = "";

  /**
   * Media has no reachable write path without a storage driver, so asset rows
   * are written straight in, exactly as the phase B fixtures are. The mime
   * type is one the move endpoint accepts, so the move case below can run
   * through the real product mutation rather than an UPDATE.
   */
  async function insertAsset(journeyId: string, storageKey: string) {
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId,
        storageDriver: "s3",
        storageKey,
        fileName: "granted.jpg",
        mimeType: "image/jpeg",
        bytes: 4096,
        uploadedByUserId: identity.userId,
      })
      .returning({ id: mediaAssets.id });
    return asset.id;
  }

  /** A storage key nobody else in this file can collide with. */
  function uniqueKey(label: string) {
    return "share-phase-c/" + randomUUID() + "/" + label + ".jpg";
  }

  function guestReadUrl(token: string, assetId: string) {
    return app.request(
      `${TEST_ORIGIN}/api/shared/assets/${assetId}/read-url`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  /**
   * The object `requireActiveShareGrant` hands a route once it has authorized
   * the bearer token, so the resolver can be driven with the same input the
   * route gives it.
   */
  async function authorizedGrant(token: string) {
    const [row] = await db
      .select({
        id: shareGrants.id,
        atlasId: shareGrants.atlasId,
        expiresAt: shareGrants.expiresAt,
      })
      .from(shareGrants)
      .where(eq(shareGrants.tokenHash, hashShareToken(token)));
    return { id: row.id, atlasId: row.atlasId, expiresAt: row.expiresAt };
  }

  beforeAll(async () => {
    // An unshared journey in the SAME atlas. The interesting failure is a
    // grant reaching a neighbour of what it shares, not a stranger's atlas.
    const unshared = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, startedOn: "2026-09-01", title: UNSHARED_TITLE },
    );
    if (!unshared) throw new Error("Unshared journey fixture was not created");
    unsharedJourneyId = unshared.id;
    unsharedAssetId = await insertAsset(unsharedJourneyId, UNSHARED_STORAGE_KEY);
    foreignAssetId = await insertAsset(
      foreignJourneyId,
      `share-phase-c/${randomUUID()}/foreign.jpg`,
    );
  });

  it("authorizes an asset in a granted journey and reaches object storage", async () => {
    const assetId = await insertAsset(journeyA, GRANTED_STORAGE_KEY);
    const token = await createShare([journeyA]);
    const response = await guestReadUrl(token, assetId);

    // 503, not 404: authorization passed and the route went on to presign,
    // which is as far as it can get with STORAGE_DRIVER unconfigured here.
    // Truthful degradation, not a fake URL.
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body).error).toBe("STORAGE_UNAVAILABLE");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // Whatever the outcome, no guest response repeats the capability or the
    // private storage key back.
    expect(body).not.toContain(token);
    expect(body).not.toContain(GRANTED_STORAGE_KEY);

    // What the route would have signed: the asset's real key, its grant's
    // deadline, and - through the injected adapter - an actual URL.
    const grant = await authorizedGrant(token);
    const resolved = await resolveSharedMediaRead(grant, assetId);
    expect(resolved).toMatchObject({
      storageDriver: "s3",
      storageKey: GRANTED_STORAGE_KEY,
      grantExpiresAt: grant.expiresAt,
    });

    signedLifetimes.length = 0;
    const issued = await signSharedMediaRead(
      resolved!,
      LIMITS,
      new Date(),
      fakeStorage,
    );
    expect(issued.url).toContain(encodeURIComponent(GRANTED_STORAGE_KEY));
    expect(signedLifetimes).toEqual([
      serverConfig.shareMediaReadUrlExpiresInSeconds,
    ]);
    expect(Date.parse(issued.expiresAt))
      .toBeLessThanOrEqual(grant.expiresAt.valueOf());
  });

  it("applies the TTL cap so no signed URL can outlive the grant", async () => {
    const assetId = await insertAsset(
      journeyA,
      `share-phase-c/${randomUUID()}/ttl.jpg`,
    );
    // A grant with less time left than the share ceiling. Only a row insert
    // can produce it: the create API rejects an expiry this close.
    const shortGrant = await insertGrant(
      identity.atlasId,
      journeyA,
      new Date(Date.now() + 20_000),
    );
    const short = await authorizedGrant(shortGrant.token);
    const resolvedShort = await resolveSharedMediaRead(short, assetId);
    expect(resolvedShort?.grantExpiresAt).toEqual(short.expiresAt);
    // The lifetime is derived at signing time from that deadline, which is the
    // whole point: the clock passed below is the one the signature is stamped
    // with.
    signedLifetimes.length = 0;
    const issued = await signSharedMediaRead(
      resolvedShort!,
      LIMITS,
      new Date(),
      fakeStorage,
    );
    expect(signedLifetimes[0]).toBeLessThanOrEqual(20);
    expect(signedLifetimes[0]).toBeGreaterThan(0);
    // The promise, stated as the arithmetic it is.
    expect(Date.parse(issued.expiresAt))
      .toBeLessThanOrEqual(short.expiresAt.valueOf());

    // A long grant is capped by the share ceiling instead, never by the
    // owner's ~15 minutes.
    const longGrant = await authorizedGrant(await createShare([journeyA]));
    const resolvedLong = await resolveSharedMediaRead(longGrant, assetId);
    signedLifetimes.length = 0;
    await signSharedMediaRead(resolvedLong!, LIMITS, new Date(), fakeStorage);
    expect(signedLifetimes[0])
      .toBe(serverConfig.shareMediaReadUrlExpiresInSeconds);
    expect(signedLifetimes[0])
      .toBeLessThan(serverConfig.mediaReadUrlExpiresInSeconds);
  });

  it("derives the TTL from the signing clock, not from when the request started", async () => {
    const assetId = await insertAsset(journeyA, uniqueKey("slow"));
    const stalled = await insertGrant(
      identity.atlasId,
      journeyA,
      new Date(Date.now() + 30_000),
    );
    const grant = await authorizedGrant(stalled.token);
    const resolved = await resolveSharedMediaRead(grant, assetId);

    // The request is authorized with 30 s left, then stalls - a saturated
    // connection pool, a slow query - and signs only 25 s later. A lifetime
    // computed at entry would still be 30 s, and the URL would outlive the
    // grant by 25 s. Signing-time arithmetic issues 5 s instead.
    signedLifetimes.length = 0;
    const late = new Date(grant.expiresAt.valueOf() - 5_000);
    const issued = await signSharedMediaRead(
      resolved!,
      LIMITS,
      late,
      fakeStorage,
    );
    expect(signedLifetimes[0]).toBe(5);
    expect(late.valueOf() + signedLifetimes[0] * 1000)
      .toBeLessThanOrEqual(grant.expiresAt.valueOf());
    expect(issued.url).toBeTruthy();
  });

  it("refuses a signature that would reach past the grant deadline", async () => {
    const assetId = await insertAsset(journeyA, uniqueKey("overrun"));
    const grant = await authorizedGrant(await createShare([journeyA]));
    const resolved = await resolveSharedMediaRead(grant, assetId);
    // An adapter that honours the duration but stamps it from a later clock,
    // or rounds its own expiry up, must not have its URL reach a guest. The
    // guarantee is enforced against what came back, not argued from the
    // interface.
    const overrunning = () => ({
      ...disabledStorage,
      async createPrivateReadUrl() {
        return {
          url: "https://storage.test/overrun",
          expiresAt: new Date(grant.expiresAt.valueOf() + 1_000),
        };
      },
    });
    await expect(
      signSharedMediaRead(resolved!, LIMITS, new Date(), overrunning),
    ).rejects.toThrow(ShareAccessError);
  });

  it("signs nothing for the final sub-second of a grant", async () => {
    const assetId = await insertAsset(
      journeyA,
      `share-phase-c/${randomUUID()}/edge.jpg`,
    );
    const grant = await authorizedGrant(await createShare([journeyA]));
    const resolved = await resolveSharedMediaRead(grant, assetId);
    // 400 ms before the grant expires it is still active, so the refusal has
    // to come from the TTL cap rather than from the expiry check. The clock is
    // explicit so the case does not depend on wall-clock timing.
    const almostOver = new Date(grant.expiresAt.valueOf() - 400);
    expect(capShareMediaTtlSeconds(LIMITS, grant.expiresAt, almostOver)).toBe(0);
    await expect(
      signSharedMediaRead(resolved!, LIMITS, almostOver, fakeStorage),
    ).rejects.toThrow(ShareAccessError);
  });

  it("stops signing an asset moved out of the shared journey", async () => {
    const assetId = await insertAsset(
      journeyA,
      `share-phase-c/${randomUUID()}/moved.jpg`,
    );
    const token = await createShare([journeyA]);
    const grant = await authorizedGrant(token);
    expect(await resolveSharedMediaRead(grant, assetId)).not.toBeNull();

    // The real owner mutation, not an UPDATE: this is the transition #200
    // describes, an owner moving a photo into a journey the link never shared.
    const move = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId: journeyA,
        targetJourneyId: unsharedJourneyId,
        assetIds: [assetId],
      }),
    });
    expect(move.status).toBe(200);

    // No cache to invalidate: the next call re-derives membership from the
    // asset's current journey and finds nothing.
    expect(await resolveSharedMediaRead(grant, assetId)).toBeNull();
    const response = await guestReadUrl(token, assetId);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(MEDIA_UNAVAILABLE_BODY);
  });

  it("stops signing an asset whose journey starts deleting", async () => {
    const doomed = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      startedOn: "2026-09-02",
      title: "Deleting journey holding phase C media",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    const assetId = await insertAsset(
      doomed.id,
      `share-phase-c/${randomUUID()}/doomed.jpg`,
    );
    const token = await createShare([doomed.id]);
    expect((await guestReadUrl(token, assetId)).status).toBe(503);

    await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId);

    // Soft deletion keeps the row and its grant membership, so this is the
    // journey's deletion mark alone doing the work.
    const response = await guestReadUrl(token, assetId);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(MEDIA_UNAVAILABLE_BODY);
  });

  it("stops signing every asset of an atlas that starts deleting", async () => {
    const [doomedAtlas] = await db
      .insert(atlases)
      .values({
        organizationId: `test-org-share-media-${randomUUID()}`,
        title: "Doomed media atlas",
      })
      .returning({ id: atlases.id });
    atlasIds.push(doomedAtlas.id);
    const journey = await createJourneyForAtlas(doomedAtlas.id, "user-doomed", {
      ...baseJourney,
      title: "Doomed media journey",
    });
    if (!journey) throw new Error("Doomed journey fixture was not created");
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId: journey.id,
        storageDriver: "s3",
        storageKey: `share-phase-c/${randomUUID()}/doomed-atlas.jpg`,
        fileName: "granted.jpg",
        mimeType: "image/jpeg",
        bytes: 4096,
        uploadedByUserId: "user-doomed",
      })
      .returning({ id: mediaAssets.id });
    const grant = await insertGrant(
      doomedAtlas.id,
      journey.id,
      new Date(Date.now() + 60_000),
    );
    expect((await guestReadUrl(grant.token, asset.id)).status).toBe(503);

    await db
      .update(atlases)
      .set({ deletionStartedAt: new Date() })
      .where(eq(atlases.id, doomedAtlas.id));

    // The whole link is gone, not one asset, so this is the grant-side shape.
    const response = await guestReadUrl(grant.token, asset.id);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(SHARE_UNAVAILABLE_BODY);
  });

  it("stops issuing read-urls the moment the grant is revoked", async () => {
    const assetId = await insertAsset(
      journeyA,
      `share-phase-c/${randomUUID()}/revoked.jpg`,
    );
    const token = await createShare([journeyA]);
    expect((await guestReadUrl(token, assetId)).status).toBe(503);

    const grant = await authorizedGrant(token);
    const revoke = await app.request(
      `${TEST_ORIGIN}/api/shares/${grant.id}/revoke`,
      { method: "POST", headers: authHeaders(identity.cookie) },
    );
    expect(revoke.status).toBe(200);

    const response = await guestReadUrl(token, assetId);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(SHARE_UNAVAILABLE_BODY);
    // And a stale authorization already in hand does not buy one either: the
    // resolver re-evaluates the grant inside its own snapshot.
    await expect(resolveSharedMediaRead(grant, assetId))
      .rejects.toThrow(ShareAccessError);
  });

  it("answers one indistinguishable state for every asset outside the grant", async () => {
    const token = await createShare([journeyA]);
    const responses = [
      // An asset that exists, in an unshared journey of the same atlas.
      await guestReadUrl(token, unsharedAssetId),
      // An asset that exists, in another atlas entirely.
      await guestReadUrl(token, foreignAssetId),
      // An asset id that has never existed.
      await guestReadUrl(token, randomUUID()),
      // An id that is not a UUID at all, which must not become a 500.
      await guestReadUrl(token, "not-an-asset-id"),
    ];
    const bodies = new Set<string>();
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      bodies.add(await response.text());
    }
    // One body for all four: nothing here discloses whether an asset exists,
    // and a malformed id is not distinguishable from a well-formed unknown one.
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(MEDIA_UNAVAILABLE_BODY);
  });

  it("leaks no unshared journey, storage key or owner field through the media path", async () => {
    const token = await createShare([journeyA]);
    const bodies = [
      await (await guestReadUrl(token, unsharedAssetId)).text(),
      await (await guestReadUrl(token, foreignAssetId)).text(),
      await (await guestReadUrl(token, await insertAsset(
        journeyA,
        `share-phase-c/${randomUUID()}/leak.jpg`,
      ))).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain(UNSHARED_STORAGE_KEY);
      expect(body).not.toContain(unsharedJourneyId);
      expect(body).not.toContain(UNSHARED_TITLE);
      expect(body).not.toContain(foreignAtlasId);
      expect(body).not.toContain(foreignJourneyId);
      expect(body).not.toContain(identity.atlasId);
      expect(body).not.toContain(identity.userId);
      expect(body).not.toContain(token);
      expect(body).not.toContain("storageKey");
      expect(body).not.toContain("storageDriver");
    }
  });

  it("exposes no mutation method on the guest media read", async () => {
    const assetId = await insertAsset(
      journeyA,
      `share-phase-c/${randomUUID()}/readonly.jpg`,
    );
    const token = await createShare([journeyA]);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await app.request(
        `${TEST_ORIGIN}/api/shared/assets/${assetId}/read-url`,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: method === "DELETE" ? undefined : "{}",
        },
      );
      expect(response.status).toBe(404);
    }

    // The bearer capability is not a session, so the owner read-url route the
    // guest would otherwise reuse stays closed to it, as does deletion.
    const ownerRead = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/${assetId}/read-url`,
      { headers: { authorization: `Bearer ${token}`, origin: TEST_ORIGIN } },
    );
    expect(ownerRead.status).toBe(401);
    const ownerDelete = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/${assetId}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, origin: TEST_ORIGIN },
      },
    );
    expect(ownerDelete.status).toBe(401);
  });
});

/**
 * #200 phase F. Three things this file did not cover before: the guest
 * prefix's own abuse budgets, what a guest may still do with data it read a
 * moment ago, and how a lifecycle change that lands *while* a request is in
 * flight resolves.
 *
 * The race cases are written as one-sided assertions on purpose. Asserting who
 * wins a real race is asserting a schedule, which is how a suite becomes
 * flaky; every assertion here is instead an invariant that holds for every
 * possible interleaving — no payload and no signature is ever produced from a
 * state that had already been withdrawn — plus a deterministic post-condition
 * once the concurrent work has settled.
 */
describe("share hardening", () => {
  const SHARE_UNAVAILABLE_BODY = JSON.stringify({
    error: "SHARE_UNAVAILABLE",
    message: "Share link unavailable",
  });
  const LIMITS = {
    shareTtlSeconds: serverConfig.shareMediaReadUrlExpiresInSeconds,
    ownerTtlSeconds: serverConfig.mediaReadUrlExpiresInSeconds,
  };

  type HardeningPayload = {
    share: { expiresAt: string; journeyCount: number };
    journeys: Array<{
      id: string;
      revision: number;
      media: Array<{ id: string }>;
    }>;
  };

  /** An address no other test in this file uses, so budgets never collide. */
  let addressCounter = 0;
  function uniqueAddress(): string {
    addressCounter += 1;
    return `198.51.100.${addressCounter}`;
  }

  function guestJourneys(token: string, address?: string) {
    return app.request(`${TEST_ORIGIN}/api/shared/journeys`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(address ? { "x-forwarded-for": address } : {}),
      },
    });
  }

  async function authorizedGrant(token: string) {
    const [row] = await db
      .select({
        id: shareGrants.id,
        atlasId: shareGrants.atlasId,
        expiresAt: shareGrants.expiresAt,
      })
      .from(shareGrants)
      .where(eq(shareGrants.tokenHash, hashShareToken(token)));
    return { id: row.id, atlasId: row.atlasId, expiresAt: row.expiresAt };
  }

  async function insertHardeningAsset(journeyId: string, label: string) {
    const [asset] = await db
      .insert(mediaAssets)
      .values({
        journeyId,
        storageDriver: "s3",
        storageKey: `share-phase-f/${randomUUID()}/${label}.jpg`,
        fileName: `${label}.jpg`,
        mimeType: "image/jpeg",
        bytes: 2048,
        uploadedByUserId: identity.userId,
      })
      .returning({ id: mediaAssets.id });
    return asset.id;
  }

  /**
   * A signing adapter that honours the duration it is given exactly, so a
   * lifetime assertion is about `signSharedMediaRead`'s arithmetic rather than
   * about a bucket. Object storage is unconfigured in this environment.
   */
  const exactStorage = () => ({
    ...disabledStorage,
    driver: "s3",
    async createPrivateReadUrl(input: { key: string; expiresInSeconds: number }) {
      return {
        url: `https://storage.test/${encodeURIComponent(input.key)}`,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
  });

  // ---------------------------------------------------------------- budgets

  it("gives the guest prefix its own budget instead of an anonymous one", async () => {
    const token = await createShare([journeyA]);
    const address = uniqueAddress();
    // Every request here holds ONE valid grant, so the ceiling that stops it
    // is the grant's data budget. In real use the addresses differ from
    // request to request — a forwarded link is many recipients — and this
    // asserts the budget does not depend on them.
    for (let index = 0; index < serverConfig.shareDataRateLimit; index += 1) {
      const response = await guestJourneys(token, address);
      expect(response.status).toBe(200);
    }
    const refused = await guestJourneys(token, address);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After"))
      .toBe(String(serverConfig.shareRateLimitWindowSeconds));
    expect(await refused.json()).toEqual({
      error: "RATE_LIMITED",
      message: "Too many requests",
    });

    // A second link is untouched: the budget belongs to the grant.
    const other = await createShare([journeyB]);
    expect((await guestJourneys(other, address)).status).toBe(200);
  });

  it("charges a token-guessing flood to the caller, not to any grant", async () => {
    const address = uniqueAddress();
    for (
      let index = 0;
      index < serverConfig.shareUnknownTokenRateLimit;
      index += 1
    ) {
      const response = await guestJourneys(generateShareToken(), address);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(SHARE_UNAVAILABLE_BODY);
    }
    const refused = await guestJourneys(generateShareToken(), address);
    expect(refused.status).toBe(429);

    // A recipient holding a real link is unaffected: a valid request never
    // spends the probe budget, and the flood above was charged to no grant.
    const token = await createShare([journeyA]);
    expect((await guestJourneys(token)).status).toBe(200);
  });

  it("leaves the owner and product API unthrottled", async () => {
    // #217 removed the blanket `/api/*` bucket and phase F must not restore
    // it: only `/api/shared/*` carries a budget.
    for (let index = 0; index < 80; index += 1) {
      const response = await app.request(`${TEST_ORIGIN}/api/shares`, {
        headers: authHeaders(identity.cookie),
      });
      expect(response.status).toBe(200);
    }
  });

  // ------------------------------------------------------- stale guest data

  it("refuses to keep authorizing media a stale payload still lists", async () => {
    const source = await createJourneyForAtlas(
      identity.atlasId,
      identity.userId,
      { ...baseJourney, startedOn: "2026-09-10", title: "Stale payload source" },
    );
    if (!source) throw new Error("Journey fixture was not created");
    const movedAssetId = await insertHardeningAsset(source.id, "moved");
    const token = await createShare([source.id]);

    const first = await guestJourneys(token);
    expect(first.status).toBe(200);
    const stale = await first.json() as HardeningPayload;
    expect(stale.journeys[0].media.map((asset) => asset.id))
      .toContain(movedAssetId);

    // The owner moves the photo out of the shared Journey. The guest still
    // holds the payload that listed it, and that payload is the ONLY place it
    // could have learned the id.
    const move = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId: source.id,
        targetJourneyId: journeyB,
        assetIds: [movedAssetId],
      }),
    });
    expect(move.status).toBe(200);

    // Replaying the id out of the stale payload buys nothing: membership is
    // re-derived from the asset's current journey on every call, so there is
    // no cached authorization left to expire.
    const replay = await app.request(
      `${TEST_ORIGIN}/api/shared/assets/${movedAssetId}/read-url`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(replay.status).toBe(404);
    expect(await replay.json()).toMatchObject({ error: "MEDIA_UNAVAILABLE" });

    // And the refreshed payload no longer lists it.
    const refreshed = await guestJourneys(token);
    const current = await refreshed.json() as HardeningPayload;
    expect(current.journeys[0].media.map((asset) => asset.id))
      .not.toContain(movedAssetId);
  });

  it("refuses a stale payload's assets once its journey starts deleting", async () => {
    const doomed = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      startedOn: "2026-09-11",
      title: "Stale payload deleted journey",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    const assetId = await insertHardeningAsset(doomed.id, "doomed");
    const token = await createShare([doomed.id]);
    const boot = await guestJourneys(token);
    expect((await boot.json() as HardeningPayload).journeys[0].media)
      .toHaveLength(1);

    await markJourneyForDeletionForAtlas(doomed.id, identity.atlasId);

    const replay = await app.request(
      `${TEST_ORIGIN}/api/shared/assets/${assetId}/read-url`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(replay.status).toBe(404);
    expect(await replay.json()).toMatchObject({ error: "MEDIA_UNAVAILABLE" });
  });

  // ------------------------------------------------------------------ races

  it("resolves a concurrent revoke-and-read to the deny side", async () => {
    const token = await createShare([journeyA]);
    const grant = await authorizedGrant(token);

    // Twelve reads and the revoke are issued together, so the commit lands
    // somewhere inside the batch and no test controls where.
    const [, ...reads] = await Promise.all([
      app.request(`${TEST_ORIGIN}/api/shares/${grant.id}/revoke`, {
        method: "POST",
        headers: authHeaders(identity.cookie),
      }),
      ...Array.from({ length: 12 }, () => guestJourneys(token)),
    ]);

    // The invariant, true for every interleaving: a read either produced a
    // payload from a grant still live in its own snapshot, or the one generic
    // unavailable body. Nothing in between, and no partial payload.
    for (const read of reads) {
      expect([200, 404]).toContain(read.status);
      const body = await read.text();
      if (read.status === 404) expect(body).toBe(SHARE_UNAVAILABLE_BODY);
      else expect(JSON.parse(body).journeys).toHaveLength(1);
    }

    // Deterministic post-condition once the revoke has certainly committed.
    const after = await guestJourneys(token);
    expect(after.status).toBe(404);
    expect(await after.text()).toBe(SHARE_UNAVAILABLE_BODY);
    // A capability authorized before the revoke cannot cash itself in
    // afterwards either: the read re-evaluates the grant in its own snapshot.
    await expect(loadSharedJourneyView(grant)).rejects.toThrow(ShareAccessError);
  });

  it("resolves a concurrent revoke-and-presign to the deny side", async () => {
    const assetId = await insertHardeningAsset(journeyA, "revoke-race");
    const token = await createShare([journeyA]);
    const grant = await authorizedGrant(token);
    expect(await resolveSharedMediaRead(grant, assetId)).not.toBeNull();

    const [, ...resolutions] = await Promise.all([
      app.request(`${TEST_ORIGIN}/api/shares/${grant.id}/revoke`, {
        method: "POST",
        headers: authHeaders(identity.cookie),
      }),
      ...Array.from({ length: 12 }, () =>
        resolveSharedMediaRead(grant, assetId).then(
          (resolved) => resolved as unknown,
          (error: unknown) => error,
        )),
    ]);

    // Either the resolver saw a live grant and returned the asset, or it saw
    // the revoked one and refused. A revoked grant never yields a resolution.
    for (const outcome of resolutions) {
      if (outcome instanceof Error) {
        expect(outcome).toBeInstanceOf(ShareAccessError);
      } else {
        expect(outcome).toMatchObject({ storageDriver: "s3" });
      }
    }
    await expect(resolveSharedMediaRead(grant, assetId))
      .rejects.toThrow(ShareAccessError);
  });

  it("resolves a concurrent expire-and-presign to the deny side", async () => {
    const assetId = await insertHardeningAsset(journeyA, "expiry-race");
    // A grant whose deadline is a moment away, written straight in because no
    // API creates an expiry this close.
    const expiresAt = new Date(Date.now() + 1_500);
    const { token } = await insertGrant(identity.atlasId, journeyA, expiresAt);
    const grant = await authorizedGrant(token);

    const attempts = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) => {
        // Spread the batch across the deadline so attempts land either side.
        await new Promise((resolve) => setTimeout(resolve, index * 200));
        try {
          const resolved = await resolveSharedMediaRead(grant, assetId);
          if (!resolved) return null;
          return await signSharedMediaRead(
            resolved,
            LIMITS,
            new Date(),
            exactStorage,
          ) as unknown;
        } catch (error) {
          return error;
        }
      }),
    );

    // The invariant: not one signature reaches past the grant's own deadline,
    // whichever side of it the attempt landed on. That is the whole point of
    // the cap — a presign cannot be withdrawn, so it must never have been
    // issued long in the first place.
    for (const attempt of attempts) {
      if (attempt === null) continue;
      if (attempt instanceof Error) {
        expect(attempt).toBeInstanceOf(ShareAccessError);
        continue;
      }
      const signed = attempt as { expiresAt: string };
      expect(Date.parse(signed.expiresAt))
        .toBeLessThanOrEqual(expiresAt.valueOf());
    }

    // Deterministic post-condition: past the deadline nothing resolves at all.
    await expect(resolveSharedMediaRead(grant, assetId))
      .rejects.toThrow(ShareAccessError);
    const guest = await app.request(
      `${TEST_ORIGIN}/api/shared/assets/${assetId}/read-url`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(guest.status).toBe(404);
    expect(await guest.text()).toBe(SHARE_UNAVAILABLE_BODY);
  });

  it("resolves a concurrent delete-and-read to the deny side", async () => {
    const doomed = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      startedOn: "2026-09-12",
      title: "Delete race journey",
    });
    if (!doomed) throw new Error("Journey fixture was not created");
    const assetId = await insertHardeningAsset(doomed.id, "delete-race");
    const token = await createShare([doomed.id]);
    const grant = await authorizedGrant(token);

    const [, ...outcomes] = await Promise.all([
      markJourneyForDeletionForAtlas(doomed.id, identity.atlasId),
      ...Array.from({ length: 12 }, async () => {
        const [payload, media] = await Promise.all([
          (async () => (await guestJourneys(token)).json())(),
          resolveSharedMediaRead(grant, assetId),
        ]);
        return [payload, media] as const;
      }),
    ]);

    // A journey that is deleting is never in a payload, and its media is never
    // resolvable, so the two answers can never disagree inside one outcome.
    for (const outcome of outcomes as Array<[HardeningPayload, unknown]>) {
      const [payload, media] = outcome;
      const listed = payload.journeys.some((journey) => journey.id === doomed.id);
      if (!listed) expect(media).toBeNull();
    }

    // Deterministic post-condition: the grant is still live and its scope is
    // simply empty, which is the "no viewable journeys" product state rather
    // than a dead link.
    const after = await guestJourneys(token);
    expect(after.status).toBe(200);
    expect((await after.json() as HardeningPayload).journeys).toHaveLength(0);
    expect(await resolveSharedMediaRead(grant, assetId)).toBeNull();
  });

  // --------------------------------------------------- read-only capability

  it("reaches no atlas-management or share-management surface", async () => {
    const token = await createShare([journeyA]);
    const bearer = { authorization: `Bearer ${token}`, origin: TEST_ORIGIN };
    // The remaining owner surfaces a share identity could try, beyond the
    // journey and upload routes covered above. A share grant is not an Atlas
    // member, so `requireAtlasAccess` never resolves an atlas for it.
    const read = await app.request(`${TEST_ORIGIN}/api/shares`, {
      headers: bearer,
    });
    expect(read.status).toBe(401);
    for (
      const [method, path] of [
        ["POST", "/api/shares"],
        ["POST", `/api/shares/${randomUUID()}/revoke`],
        ["POST", "/api/atlases/bootstrap"],
      ] as const
    ) {
      const response = await app.request(`${TEST_ORIGIN}${path}`, {
        method,
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ journeyIds: [journeyA], expiresAt: inDays(1) }),
      });
      expect(response.status).toBe(401);
    }
  });
});
