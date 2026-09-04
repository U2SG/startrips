import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import {
  generateShareToken,
  hashShareToken,
  MAX_SHARE_LIFETIME_MS,
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
});
