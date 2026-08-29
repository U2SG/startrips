import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, journeys, mediaAssets, mediaUploads } from "../db/app-schema";
import {
  member as authMembers,
  organization as authOrganizations,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  createJourneyForAtlas,
  getJourneyDeletionCandidateForAtlas,
  JOURNEY_DELETION_GRACE_MS,
  JourneyRouteChangedError,
  listJourneysPendingDeletion,
  listJourneysForAtlas,
  markJourneyForDeletionForAtlas,
  restoreJourneyForAtlas,
  setJourneyCoverForAtlas,
  updateJourneyForAtlas,
} from "../repositories/journey-repository";
import { finalizeUpload } from "../routes/uploads";

const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];
let atlasA = "";
let atlasB = "";
let journeyB = "";
let guardedOrganizationId = "";
const TEST_ORIGIN = "http://127.0.0.1:5173";

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
      latitude: 1.2903,
      longitude: 103.8519,
      label: "",
      isStop: false,
      occurredAt: new Date("2026-08-11T02:00:00Z"),
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

async function createVerifiedSession(label: string) {
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
  const signInPayload = await signIn.json() as { user: { id: string } };
  const cookie = signIn.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, userId: signInPayload.user.id };
}

async function createAuthenticatedAtlas(label: string) {
  const identity = await createVerifiedSession(label);
  const organizationResponse = await app.request(
    `${TEST_ORIGIN}/api/auth/organization/create`,
    {
      method: "POST",
      headers: authHeaders(identity.cookie),
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
    headers: authHeaders(identity.cookie),
    body: JSON.stringify({ title: `${label} Atlas`, dedication: "private" }),
  });
  expect([200, 201]).toContain(bootstrap.status);
  const payload = await bootstrap.json() as { atlas: { id: string } };
  atlasIds.push(payload.atlas.id);
  return { ...identity, organizationId: organization.id, atlasId: payload.atlas.id };
}

beforeAll(async () => {
  const insertedAtlases = await db
    .insert(atlases)
    .values([
      { organizationId: `test-org-a-${randomUUID()}`, title: "Atlas A" },
      { organizationId: `test-org-b-${randomUUID()}`, title: "Atlas B" },
    ])
    .returning({ id: atlases.id });
  [atlasA, atlasB] = insertedAtlases.map((atlas) => atlas.id);
  atlasIds.push(atlasA, atlasB);

  const [createdA, createdB] = await Promise.all([
    createJourneyForAtlas(atlasA, "user-a", { ...baseJourney, title: "Only A" }),
    createJourneyForAtlas(atlasB, "user-b", { ...baseJourney, title: "Only B" }),
  ]);
  if (!createdA || !createdB) throw new Error("Journey fixtures were not created");
  journeyB = createdB.id;
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

describe("authenticated tenant boundary", () => {
  it("rejects active-organization switching and cross-atlas mutation", async () => {
    const identityA = await createAuthenticatedAtlas("Alice");
    const identityB = await createAuthenticatedAtlas("Bob");
    guardedOrganizationId = identityA.organizationId;

    const createA = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      method: "POST",
      headers: authHeaders(identityA.cookie),
      body: JSON.stringify({ ...baseJourney, title: "Private A" }),
    });
    const createB = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      method: "POST",
      headers: authHeaders(identityB.cookie),
      body: JSON.stringify({ ...baseJourney, title: "Private B" }),
    });
    expect(createA.status).toBe(201);
    expect(createB.status).toBe(201);
    const privateA = await createA.json() as { journey: { id: string } };
    const privateB = await createB.json() as { journey: { id: string } };

    const legacyUpdate = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateA.journey.id}`,
      {
        method: "PATCH",
        headers: authHeaders(identityA.cookie),
        body: JSON.stringify({ ...baseJourney, title: "Legacy overwrite" }),
      },
    );
    expect(legacyUpdate.status).toBe(409);
    await expect(legacyUpdate.json()).resolves.toMatchObject({
      error: "JOURNEY_ROUTE_CHANGED",
    });

    const visibleToA = await app.request(
      `${TEST_ORIGIN}/api/journeys?organizationId=${identityB.organizationId}`,
      {
        headers: {
          ...authHeaders(identityA.cookie),
          "x-organization-id": identityB.organizationId,
        },
      },
    );
    expect(visibleToA.status).toBe(200);
    const visiblePayload = await visibleToA.json() as {
      journeys: { title: string }[];
    };
    expect(visiblePayload.journeys.map((journey) => journey.title)).toEqual([
      "Private A",
    ]);

    const crossAtlasUpdate = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateB.journey.id}`,
      {
        method: "PATCH",
        headers: authHeaders(identityA.cookie),
        body: JSON.stringify({ ...baseJourney, title: "Stolen" }),
      },
    );
    expect(crossAtlasUpdate.status).toBe(404);

    const deleteA = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateA.journey.id}`,
      { method: "DELETE", headers: authHeaders(identityA.cookie) },
    );
    expect(deleteA.status).toBe(204);
    const restoreA = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateA.journey.id}/restore`,
      { method: "POST", headers: authHeaders(identityA.cookie) },
    );
    expect(restoreA.status).toBe(200);
    await expect(restoreA.json()).resolves.toMatchObject({
      journey: { id: privateA.journey.id, title: "Private A" },
    });
    const deleteB = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateB.journey.id}`,
      { method: "DELETE", headers: authHeaders(identityB.cookie) },
    );
    expect(deleteB.status).toBe(204);
    const crossAtlasRestore = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateB.journey.id}/restore`,
      { method: "POST", headers: authHeaders(identityA.cookie) },
    );
    expect(crossAtlasRestore.status).toBe(404);
    const restoreB = await app.request(
      `${TEST_ORIGIN}/api/journeys/${privateB.journey.id}/restore`,
      { method: "POST", headers: authHeaders(identityB.cookie) },
    );
    expect(restoreB.status).toBe(200);

    const forgedSwitch = await app.request(
      `${TEST_ORIGIN}/api/auth/organization/set-active`,
      {
        method: "POST",
        headers: authHeaders(identityA.cookie),
        body: JSON.stringify({ organizationId: identityB.organizationId }),
      },
    );
    expect(forgedSwitch.ok).toBe(false);

    const afterForgedSwitch = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: authHeaders(identityA.cookie),
    });
    expect(afterForgedSwitch.status).toBe(409);
    await expect(afterForgedSwitch.json()).resolves.toMatchObject({
      error: "ACTIVE_ORGANIZATION_REQUIRED",
    });
  });

  it("serializes concurrent inserts at the two-member database limit", async () => {
    const extraUsers = [randomUUID(), randomUUID()].map((id, index) => ({
      id,
      name: `Extra ${index}`,
      email: `extra-${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    authUserEmails.push(...extraUsers.map((user) => user.email));
    await db.insert(authUsers).values(extraUsers);

    const attempts = await Promise.allSettled(
      extraUsers.map((user) =>
        db.insert(authMembers).values({
          id: randomUUID(),
          organizationId: guardedOrganizationId,
          userId: user.id,
          role: "member",
          createdAt: new Date(),
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const [membershipCount] = await db
      .select({ value: count() })
      .from(authMembers)
      .where(eq(authMembers.organizationId, guardedOrganizationId));
    expect(membershipCount.value).toBe(2);
  });
});

describe("API robustness", () => {
  it("reports database health through the public probe", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns 400 for malformed JSON bodies instead of 500", async () => {
    const identity = await createAuthenticatedAtlas("Malformed");
    const response = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: '{"title": ',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_JSON",
    });
  });
});

describe("media and atlas HTTP endpoints", () => {
  // One shared identity keeps sign-ups under the auth rate limit; the
  // atlas-deletion test runs last because it removes the shared atlas.
  let identity: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;
  let sharedJourneyId = "";

  beforeAll(async () => {
    identity = await createAuthenticatedAtlas("EndpointShared");
    const shared = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Shared degradation journey",
    });
    if (!shared) throw new Error("Shared journey fixture was not created");
    sharedJourneyId = shared.id;
  });

  it("reads a single tenant-scoped journey and rejects foreign ids", async () => {
    const created = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Single read",
    });
    if (!created) throw new Error("Journey fixture was not created");

    const own = await app.request(
      `${TEST_ORIGIN}/api/journeys/${created.id}`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({
      journey: { id: created.id, title: "Single read" },
    });

    const foreign = await app.request(
      `${TEST_ORIGIN}/api/journeys/${journeyB}`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(foreign.status).toBe(404);
  });

  it("reorders journey media through the tenant-scoped endpoint", async () => {
    const journey = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Reorder story",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const assets = await db
      .insert(mediaAssets)
      .values(["a.jpg", "b.jpg", "c.jpg"].map((fileName, index) => ({
        journeyId: journey.id,
        routePointId: null,
        storageDriver: "test",
        storageKey: `${identity.atlasId}/${journey.id}/${randomUUID()}`,
        fileName,
        mimeType: "image/jpeg",
        bytes: 128,
        sortOrder: index,
        uploadedByUserId: identity.userId,
      })))
      .returning({ id: mediaAssets.id });

    const reordered = [assets[2], assets[0], assets[1]].map((asset) => asset.id);
    const response = await app.request(`${TEST_ORIGIN}/api/uploads/assets/reorder`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyId: journey.id, assetIds: reordered }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { journey: { media: { id: string; sortOrder: number }[] } };
    expect(payload.journey.media.map((asset) => asset.id)).toEqual(reordered);
    expect(payload.journey.media.map((asset) => asset.sortOrder)).toEqual([0, 1, 2]);

    const foreignAsset = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/reorder`,
      {
        method: "POST",
        headers: authHeaders(identity.cookie),
        body: JSON.stringify({
          journeyId: journey.id,
          assetIds: [assets[2].id, "00000000-0000-4000-8000-000000000099"],
        }),
      },
    );
    expect(foreignAsset.status).toBe(400);

    const unknownJourney = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/reorder`,
      {
        method: "POST",
        headers: authHeaders(identity.cookie),
        body: JSON.stringify({
          journeyId: "00000000-0000-4000-8000-000000000099",
          assetIds: reordered,
        }),
      },
    );
    expect(unknownJourney.status).toBe(404);

    // The fake backend rows exist only for this reorder assertion; remove
    // them so the later atlas-deletion test sees no storage references.
    await db.delete(mediaAssets).where(eq(mediaAssets.journeyId, journey.id));
  });

  it("moves a batch of media onto a route point through the tenant-scoped endpoint", async () => {
    const journey = await createJourneyForAtlas(identity.atlasId, identity.userId, {
      ...baseJourney,
      title: "Move story",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const [stopId, wayPointId] = journey.routePoints.map((point) => point.id);
    const assets = await db
      .insert(mediaAssets)
      .values(["a.jpg", "b.jpg", "c.jpg"].map((fileName, index) => ({
        journeyId: journey.id,
        routePointId: null,
        storageDriver: "test",
        storageKey: `${identity.atlasId}/${journey.id}/${randomUUID()}`,
        fileName,
        mimeType: "image/jpeg",
        bytes: 128,
        sortOrder: index,
        uploadedByUserId: identity.userId,
      })))
      .returning({ id: mediaAssets.id });
    const [soundtrack] = await db
      .insert(mediaAssets)
      .values({
        journeyId: journey.id,
        routePointId: null,
        storageDriver: "test",
        storageKey: `${identity.atlasId}/${journey.id}/${randomUUID()}`,
        fileName: "theme.mp3",
        mimeType: "audio/mpeg",
        bytes: 128,
        sortOrder: 3,
        uploadedByUserId: identity.userId,
      })
      .returning({ id: mediaAssets.id });

    const moved = [assets[0].id, assets[2].id];
    const response = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyId: journey.id, assetIds: moved, routePointId: stopId }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      journey: { media: { id: string; routePointId: string | null }[] };
    };
    const byId = new Map(payload.journey.media.map((asset) => [asset.id, asset]));
    expect(byId.get(assets[0].id)?.routePointId).toBe(stopId);
    expect(byId.get(assets[2].id)?.routePointId).toBe(stopId);
    expect(byId.get(assets[1].id)?.routePointId).toBeNull();

    // Moving back to the whole journey (null) is the same endpoint.
    const movedBack = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyId: journey.id, assetIds: [assets[0].id], routePointId: null }),
    });
    expect(movedBack.status).toBe(200);
    const movedBackPayload = await movedBack.json() as {
      journey: { media: { id: string; routePointId: string | null }[] };
    };
    expect(
      movedBackPayload.journey.media.find((asset) => asset.id === assets[0].id)?.routePointId,
    ).toBeNull();

    const foreignAsset = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId: journey.id,
        assetIds: [assets[1].id, "00000000-0000-4000-8000-000000000099"],
        routePointId: wayPointId,
      }),
    });
    expect(foreignAsset.status).toBe(400);

    const soundtrackOntoRoutePoint = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ journeyId: journey.id, assetIds: [soundtrack.id], routePointId: stopId }),
    });
    expect(soundtrackOntoRoutePoint.status).toBe(400);

    const unknownRoutePoint = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId: journey.id,
        assetIds: [assets[1].id],
        routePointId: "00000000-0000-4000-8000-000000000099",
      }),
    });
    expect(unknownRoutePoint.status).toBe(404);

    const unknownJourney = await app.request(`${TEST_ORIGIN}/api/uploads/assets/move`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId: "00000000-0000-4000-8000-000000000099",
        assetIds: [assets[1].id],
        routePointId: stopId,
      }),
    });
    expect(unknownJourney.status).toBe(404);

    await db.delete(mediaAssets).where(eq(mediaAssets.journeyId, journey.id));
  });

  it("degrades truthfully when media storage is disabled", async () => {
    const start = await app.request(`${TEST_ORIGIN}/api/uploads/start`, {
      method: "POST",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({
        journeyId: sharedJourneyId,
        fileName: "memory.jpg",
        mimeType: "image/jpeg",
        bytes: 128,
      }),
    });
    expect(start.status).toBe(503);
    await expect(start.json()).resolves.toMatchObject({
      error: "STORAGE_UNAVAILABLE",
    });

    const read = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/00000000-0000-4000-8000-000000000099/read-url`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(read.status).toBe(404);
    const remove = await app.request(
      `${TEST_ORIGIN}/api/uploads/assets/00000000-0000-4000-8000-000000000099`,
      { method: "DELETE", headers: authHeaders(identity.cookie) },
    );
    expect(remove.status).toBe(404);
  });

  it("degrades truthfully when location search is disabled", async () => {
    const search = await app.request(
      `${TEST_ORIGIN}/api/locations/search?q=Singapore`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(search.status).toBe(503);
    await expect(search.json()).resolves.toMatchObject({
      error: "LOCATION_SEARCH_UNAVAILABLE",
    });

    const reverse = await app.request(
      `${TEST_ORIGIN}/api/locations/reverse?latitude=22.5&longitude=114.05`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(reverse.status).toBe(503);

    const invalidReverse = await app.request(
      `${TEST_ORIGIN}/api/locations/reverse?latitude=&longitude=114.05`,
      { headers: authHeaders(identity.cookie) },
    );
    expect(invalidReverse.status).toBe(400);
    await expect(invalidReverse.json()).resolves.toMatchObject({
      error: "INVALID_LOCATION_COORDINATES",
    });
  });

  it("updates and then deletes the current atlas through the tenant API", async () => {
    const patch = await app.request(`${TEST_ORIGIN}/api/atlases/current`, {
      method: "PATCH",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ title: "Renamed Atlas", dedication: "still private" }),
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      atlas: { title: "Renamed Atlas", dedication: "still private" },
    });

    const invalid = await app.request(`${TEST_ORIGIN}/api/atlases/current`, {
      method: "PATCH",
      headers: authHeaders(identity.cookie),
      body: JSON.stringify({ title: "", dedication: "" }),
    });
    expect(invalid.status).toBe(400);

    // Deletion fails closed while any stored object cannot be cleaned up.
    const [blockingAsset] = await db
      .insert(mediaAssets)
      .values({
        journeyId: sharedJourneyId,
        routePointId: null,
        storageDriver: "unavailable-backend",
        storageKey: `${identity.atlasId}/blocking.jpg`,
        fileName: "blocking.jpg",
        mimeType: "image/jpeg",
        bytes: 128,
        sortOrder: 0,
        uploadedByUserId: identity.userId,
      })
      .returning({ id: mediaAssets.id });
    const blocked = await app.request(
      `${TEST_ORIGIN}/api/atlases/current`,
      { method: "DELETE", headers: authHeaders(identity.cookie) },
    );
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "STORAGE_UNAVAILABLE",
    });
    await db.delete(mediaAssets).where(eq(mediaAssets.id, blockingAsset.id));

    const deleteResponse = await app.request(
      `${TEST_ORIGIN}/api/atlases/current`,
      { method: "DELETE", headers: authHeaders(identity.cookie) },
    );
    expect(deleteResponse.status).toBe(204);
    const afterDelete = await app.request(`${TEST_ORIGIN}/api/atlases/current`, {
      headers: authHeaders(identity.cookie),
    });
    expect(afterDelete.status).toBe(404);
    const journeysAfterDelete = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: authHeaders(identity.cookie),
    });
    expect(journeysAfterDelete.status).toBe(404);
  });
});

describe("tenant-scoped journey repository", () => {
  it("never lists journeys from another atlas", async () => {
    const visible = await listJourneysForAtlas(atlasA);
    expect(visible.map((journey) => journey.title)).toEqual(["Only A"]);
  });

  it("cannot update a journey through another atlas id", async () => {
    const result = await updateJourneyForAtlas(journeyB, atlasA, {
      ...baseJourney,
      title: "Leaked update",
      revision: 1,
    });
    expect(result).toBeUndefined();

    const [unchanged] = await db
      .select({ title: journeys.title })
      .from(journeys)
      .where(eq(journeys.id, journeyB));
    expect(unchanged.title).toBe("Only B");
  });

  it("scopes deletion intent and hides the journey from active reads", async () => {
    const created = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Pending deletion",
    });
    if (!created) throw new Error("Journey fixture was not created");

    await expect(
      markJourneyForDeletionForAtlas(created.id, atlasB),
    ).resolves.toBeUndefined();
    await expect(
      markJourneyForDeletionForAtlas(created.id, atlasA),
    ).resolves.toEqual({ id: created.id });

    const visible = await listJourneysForAtlas(atlasA);
    expect(visible.some((journey) => journey.id === created.id)).toBe(false);
    await expect(updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Should stay hidden",
      revision: created.revision,
    })).resolves.toBeUndefined();
    await expect(
      getJourneyDeletionCandidateForAtlas(created.id, atlasA),
    ).resolves.toMatchObject({ id: created.id, media: [], uploads: [] });

    const immediateCandidates = await listJourneysPendingDeletion();
    expect(immediateCandidates.some((candidate) => candidate.id === created.id)).toBe(false);
    await db
      .update(journeys)
      .set({ deletionStartedAt: new Date(Date.now() - JOURNEY_DELETION_GRACE_MS - 1_000) })
      .where(eq(journeys.id, created.id));
    const afterGraceCandidates = await listJourneysPendingDeletion();
    expect(afterGraceCandidates.some((candidate) => candidate.id === created.id)).toBe(true);
    await expect(restoreJourneyForAtlas(created.id, atlasA)).resolves.toBeUndefined();

    await expect(restoreJourneyForAtlas(created.id, atlasB)).resolves.toBeUndefined();
    await db
      .update(journeys)
      .set({ deletionStartedAt: new Date() })
      .where(eq(journeys.id, created.id));
    await expect(restoreJourneyForAtlas(created.id, atlasA)).resolves.toMatchObject({
      id: created.id,
      title: "Pending deletion",
    });
    await expect(getJourneyDeletionCandidateForAtlas(created.id, atlasA)).resolves.toBeUndefined();
  });

  it("prevents upload finalization after deletion begins", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Deletion versus completion",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const [upload] = await db
      .insert(mediaUploads)
      .values({
        atlasId: atlasA,
        journeyId: journey.id,
        storageDriver: "test",
        storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
        providerUploadId: randomUUID(),
        fileName: "blocked.jpg",
        mimeType: "image/jpeg",
        bytes: 128,
        partSize: 128,
        partCount: 1,
        status: "finalizing",
        createdByUserId: "user-a",
      })
      .returning();

    await markJourneyForDeletionForAtlas(journey.id, atlasA);
    await expect(finalizeUpload(upload)).rejects.toThrow(
      "Upload journey no longer exists",
    );

    const [assetCount] = await db
      .select({ value: count() })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, journey.id));
    expect(assetCount.value).toBe(0);
  });

  it("atomically replaces and preserves route order", async () => {
    const created = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Route edit",
    });
    if (!created) throw new Error("Journey fixture was not created");
    const originalIds = created.routePoints.map((point) => point.id);
    const updated = await updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Route edit",
      revision: created.revision,
      routePoints: [...created.routePoints]
        .reverse()
        .map(({ id, latitude, longitude, label, isStop, occurredAt }) => ({
          id,
          latitude,
          longitude,
          label,
          isStop,
          occurredAt,
        })),
    });
    expect(updated?.routePoints.map((point) => point.sortOrder)).toEqual([0, 1]);
    expect(updated?.routePoints.map((point) => point.label)).toEqual(["", "Singapore"]);
    expect(updated?.routePoints.map((point) => point.id)).toEqual([...originalIds].reverse());

    await expect(updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Stale route edit",
      revision: created.revision,
    })).rejects.toBeInstanceOf(JourneyRouteChangedError);

    const [foreignJourney] = await listJourneysForAtlas(atlasB);
    await expect(updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Route edit",
      revision: updated!.revision,
      routePoints: [{
        ...baseJourney.routePoints[0],
        id: foreignJourney.routePoints[0].id,
      }],
    })).rejects.toBeInstanceOf(JourneyRouteChangedError);
  });

  it("preserves route-point notes across edits and clears them explicitly (#10)", async () => {
    const created = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Noted route",
      routePoints: baseJourney.routePoints.map((point, index) => ({
        ...point,
        note: index === 0 ? "第一次看到雪山的时候，风很大。" : null,
      })),
    });
    if (!created) throw new Error("Journey fixture was not created");
    const pointA = created.routePoints[0];
    const pointB = created.routePoints[1];

    // Notes round-trip through create/read.
    expect(pointA.note).toBe("第一次看到雪山的时候，风很大。");
    expect(pointB.note).toBeNull();

    // A full replace that echoes the notes back preserves them; editing other
    // fields never clears what the client carried.
    const edited = await updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Noted route (edited)",
      revision: created.revision,
      routePoints: created.routePoints.map(({ id, latitude, longitude, label, isStop, occurredAt, note }) => ({
        id,
        latitude,
        longitude,
        label,
        isStop,
        occurredAt,
        note: note ?? null,
      })),
    });
    expect(edited?.title).toBe("Noted route (edited)");
    expect(edited?.routePoints[0].note).toBe("第一次看到雪山的时候，风很大。");

    // Explicit null clears a note.
    const cleared = await updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Noted route (edited)",
      revision: edited!.revision,
      routePoints: edited!.routePoints.map(({ id, latitude, longitude, label, isStop, occurredAt }) => ({
        id,
        latitude,
        longitude,
        label,
        isStop,
        occurredAt,
        note: null,
      })),
    });
    expect(cleared?.routePoints[0].note).toBeNull();
    expect(cleared?.routePoints[1].note).toBeNull();
  });

  it("keeps existing route-point notes when an update omits the note field (review P1)", async () => {
    const created = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Omitted note",
      routePoints: baseJourney.routePoints.map((point, index) => ({
        ...point,
        note: index === 0 ? "这句必须留下" : null,
      })),
    });
    if (!created) throw new Error("Journey fixture was not created");

    // An older/partial client updates the route but does not send `note` at
    // all. The stored note must survive — only explicit null/empty clears.
    const updated = await updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Omitted note (edited)",
      revision: created.revision,
      routePoints: created.routePoints.map(({ id, latitude, longitude, label, isStop, occurredAt }) => ({
        id,
        latitude,
        longitude,
        label,
        isStop,
        occurredAt,
        // note deliberately omitted
      })),
    });
    expect(updated?.title).toBe("Omitted note (edited)");
    expect(updated?.routePoints[0].note).toBe("这句必须留下");
    expect(updated?.routePoints[1].note).toBeNull();
  });

  it("serializes media finalization into a stable story order", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Ordered story",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const uploads = await db
      .insert(mediaUploads)
      .values(["first.jpg", "second.mp4"].map((fileName) => ({
        atlasId: atlasA,
        journeyId: journey.id,
        routePointId: journey.routePoints[0].id,
        storageDriver: "test",
        storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
        providerUploadId: randomUUID(),
        fileName,
        mimeType: fileName.endsWith(".jpg") ? "image/jpeg" : "video/mp4",
        bytes: 128,
        partSize: 128,
        partCount: 1,
        status: "finalizing",
        createdByUserId: "user-a",
      })))
      .returning();

    await Promise.all(uploads.map((upload) => finalizeUpload(upload)));

    const listed = await listJourneysForAtlas(atlasA);
    const ordered = listed.find((candidate) => candidate.id === journey.id);
    expect(ordered?.media.map((asset) => asset.sortOrder)).toEqual([0, 1]);
    expect(new Set(ordered?.media.map((asset) => asset.fileName))).toEqual(
      new Set(["first.jpg", "second.mp4"]),
    );
    expect(new Set(ordered?.media.map((asset) => asset.routePointId))).toEqual(
      new Set([journey.routePoints[0].id]),
    );
  });

  it("deduplicates identical media content within a journey", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Dedup story",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const hash = "c".repeat(64);
    const uploads = await db
      .insert(mediaUploads)
      .values(["first.jpg", "second.jpg"].map((fileName) => ({
        atlasId: atlasA,
        journeyId: journey.id,
        storageDriver: "test",
        storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
        providerUploadId: randomUUID(),
        fileName,
        mimeType: "image/jpeg",
        bytes: 128,
        contentHash: hash,
        partSize: 128,
        partCount: 1,
        status: "finalizing",
        createdByUserId: "user-a",
      })))
      .returning();

    const first = await finalizeUpload(uploads[0]);
    const second = await finalizeUpload(uploads[1]);

    expect(second.id).toBe(first.id);
    const [assetCount] = await db
      .select({ value: count() })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, journey.id));
    expect(assetCount.value).toBe(1);
    const [completedUpload] = await db
      .select()
      .from(mediaUploads)
      .where(eq(mediaUploads.id, uploads[1].id));
    expect(completedUpload.mediaAssetId).toBe(first.id);
  });

  it("never deduplicates a soundtrack onto identical visual content", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Same bytes, two kinds",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    // One MP4 can be stored as the journey's video and, later, as its
    // soundtrack. Content hashing alone would collapse them into one row.
    const hash = "d".repeat(64);
    const [videoUpload, audioUpload] = await db
      .insert(mediaUploads)
      .values([
        { fileName: "passage.mp4", mimeType: "video/mp4" },
        { fileName: "passage.m4a", mimeType: "audio/mp4" },
      ].map(({ fileName, mimeType }) => ({
        atlasId: atlasA,
        journeyId: journey.id,
        storageDriver: "test",
        storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
        providerUploadId: randomUUID(),
        fileName,
        mimeType,
        bytes: 128,
        contentHash: hash,
        partSize: 128,
        partCount: 1,
        status: "finalizing",
        createdByUserId: "user-a",
      })))
      .returning();

    const video = await finalizeUpload(videoUpload);
    const audio = await finalizeUpload(audioUpload);

    expect(audio.id).not.toBe(video.id);
    expect(audio.mimeType).toBe("audio/mp4");
    expect(video.mimeType).toBe("video/mp4");
    const [assetCount] = await db
      .select({ value: count() })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, journey.id));
    expect(assetCount.value).toBe(2);

    // A second soundtrack upload of the same audio bytes still deduplicates
    // inside its own kind, which is what keeps replacement idempotent.
    const [repeatUpload] = await db
      .insert(mediaUploads)
      .values({
        atlasId: atlasA,
        journeyId: journey.id,
        storageDriver: "test",
        storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
        providerUploadId: randomUUID(),
        fileName: "passage.m4a",
        mimeType: "audio/mp4",
        bytes: 128,
        contentHash: hash,
        partSize: 128,
        partCount: 1,
        status: "finalizing",
        createdByUserId: "user-a",
      })
      .returning();
    expect((await finalizeUpload(repeatUpload)).id).toBe(audio.id);
  });

  it("allows the same media bytes at different route points, dedupes within one point", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "One file, two stops",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const pointA = journey.routePoints[0].id;
    const pointB = journey.routePoints[1].id;
    if (!pointA || !pointB) throw new Error("Journey fixture lacks two route points");
    const hash = "e".repeat(64);

    const insertUpload = (routePointId: string | null, fileName: string) =>
      db
        .insert(mediaUploads)
        .values({
          atlasId: atlasA,
          journeyId: journey.id,
          routePointId,
          storageDriver: "test",
          storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
          providerUploadId: randomUUID(),
          fileName,
          mimeType: "image/jpeg",
          bytes: 128,
          contentHash: hash,
          partSize: 128,
          partCount: 1,
          status: "finalizing",
          createdByUserId: "user-a",
        })
        .returning();

    // Same hash at point A, then at point B: two distinct assets.
    const [uploadA] = await insertUpload(pointA, "group.jpg");
    const assetA = await finalizeUpload(uploadA);
    const [uploadB] = await insertUpload(pointB, "group.jpg");
    const assetB = await finalizeUpload(uploadB);

    expect(assetA.id).not.toBe(assetB.id);
    expect(assetA.routePointId).toBe(pointA);
    expect(assetB.routePointId).toBe(pointB);

    // Re-uploading the same bytes at point A still dedupes to asset A.
    const [repeatA] = await insertUpload(pointA, "group-copy.jpg");
    expect((await finalizeUpload(repeatA)).id).toBe(assetA.id);

    // A journey-scoped upload (routePointId = null) of the same hash must not
    // reuse either route-point asset.
    const [journeyScoped] = await insertUpload(null, "group-journey.jpg");
    const journeyScopedAsset = await finalizeUpload(journeyScoped);
    expect(journeyScopedAsset.id).not.toBe(assetA.id);
    expect(journeyScopedAsset.id).not.toBe(assetB.id);
    expect(journeyScopedAsset.routePointId).toBeNull();

    const [assetCount] = await db
      .select({ value: count() })
      .from(mediaAssets)
      .where(eq(mediaAssets.journeyId, journey.id));
    expect(assetCount.value).toBe(3);
  });

  it("applies route-point scoping to video dedupe as well", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "One clip, two stops",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const pointA = journey.routePoints[0].id;
    const pointB = journey.routePoints[1].id;
    if (!pointA || !pointB) throw new Error("Journey fixture lacks two route points");
    const hash = "f".repeat(64);

    const insertUpload = (routePointId: string | null) =>
      db
        .insert(mediaUploads)
        .values({
          atlasId: atlasA,
          journeyId: journey.id,
          routePointId,
          storageDriver: "test",
          storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
          providerUploadId: randomUUID(),
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          bytes: 128,
          contentHash: hash,
          partSize: 128,
          partCount: 1,
          status: "finalizing",
          createdByUserId: "user-a",
        })
        .returning();

    const [uploadA] = await insertUpload(pointA);
    const assetA = await finalizeUpload(uploadA);
    const [uploadB] = await insertUpload(pointB);
    const assetB = await finalizeUpload(uploadB);

    expect(assetA.id).not.toBe(assetB.id);
    expect(assetA.routePointId).toBe(pointA);
    expect(assetB.routePointId).toBe(pointB);
  });

  it("sets and clears an explicit journey cover, rejecting foreign or audio assets (#14)", async () => {
    const journey = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Cover story",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const pointA = journey.routePoints[0].id;
    if (!pointA) throw new Error("Journey fixture lacks a route point");

    const makeUpload = (fileName: string, mimeType: string, pointId: string | null) =>
      db
        .insert(mediaUploads)
        .values({
          atlasId: atlasA,
          journeyId: journey.id,
          routePointId: pointId,
          storageDriver: "test",
          storageKey: `${atlasA}/${journey.id}/${randomUUID()}`,
          providerUploadId: randomUUID(),
          fileName,
          mimeType,
          bytes: 128,
          partSize: 128,
          partCount: 1,
          status: "finalizing",
          createdByUserId: "user-a",
        })
        .returning();

    const [photoUpload] = await makeUpload("photo.jpg", "image/jpeg", pointA);
    const photo = await finalizeUpload(photoUpload);
    const [audioUpload] = await makeUpload("track.mp3", "audio/mpeg", null);
    const audio = await finalizeUpload(audioUpload);

    // A visual asset of this journey becomes the cover.
    const withCover = await setJourneyCoverForAtlas(journey.id, atlasA, photo.id);
    expect(withCover?.coverMediaAssetId).toBe(photo.id);

    // A soundtrack can never be the cover; the journey keeps its current cover.
    const rejectedAudio = await setJourneyCoverForAtlas(journey.id, atlasA, audio.id);
    expect(rejectedAudio?.id).toBe(journey.id);
    expect(rejectedAudio?.coverMediaAssetId).toBe(photo.id);

    // A foreign journey's asset is rejected.
    const other = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Other cover",
    });
    if (!other) throw new Error("Other journey fixture was not created");
    const otherPhoto = await finalizeUpload(
      (await db
        .insert(mediaUploads)
        .values({
          atlasId: atlasA,
          journeyId: other.id,
          routePointId: other.routePoints[0]?.id ?? null,
          storageDriver: "test",
          storageKey: `${atlasA}/${other.id}/${randomUUID()}`,
          providerUploadId: randomUUID(),
          fileName: "other.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          partSize: 128,
          partCount: 1,
          status: "finalizing",
          createdByUserId: "user-a",
        })
        .returning())[0],
    );
    const rejectedForeign = await setJourneyCoverForAtlas(journey.id, atlasA, otherPhoto.id);
    expect(rejectedForeign?.coverMediaAssetId).toBe(photo.id);

    // Clearing works.
    const cleared = await setJourneyCoverForAtlas(journey.id, atlasA, null);
    expect(cleared?.coverMediaAssetId).toBeNull();
    expect(cleared?.id).toBe(journey.id);
  });
});
