import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { atlases, journeys, mediaUploads } from "../db/app-schema";
import {
  member as authMembers,
  organization as authOrganizations,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  createJourneyForAtlas,
  listJourneysForAtlas,
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

  await db
    .update(authUsers)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(authUsers.email, email));
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
  const [user] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email))
    .limit(1);
  return { cookie: cookie!, userId: user.id };
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
    const privateB = await createB.json() as { journey: { id: string } };

    const forgedSwitch = await app.request(
      `${TEST_ORIGIN}/api/auth/organization/set-active`,
      {
        method: "POST",
        headers: authHeaders(identityA.cookie),
        body: JSON.stringify({ organizationId: identityB.organizationId }),
      },
    );
    expect(forgedSwitch.ok).toBe(false);

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

describe("tenant-scoped journey repository", () => {
  it("never lists journeys from another atlas", async () => {
    const visible = await listJourneysForAtlas(atlasA);
    expect(visible.map((journey) => journey.title)).toEqual(["Only A"]);
  });

  it("cannot update a journey through another atlas id", async () => {
    const result = await updateJourneyForAtlas(journeyB, atlasA, {
      ...baseJourney,
      title: "Leaked update",
    });
    expect(result).toBeUndefined();

    const [unchanged] = await db
      .select({ title: journeys.title })
      .from(journeys)
      .where(eq(journeys.id, journeyB));
    expect(unchanged.title).toBe("Only B");
  });

  it("atomically replaces and preserves route order", async () => {
    const created = await createJourneyForAtlas(atlasA, "user-a", {
      ...baseJourney,
      title: "Route edit",
    });
    if (!created) throw new Error("Journey fixture was not created");
    const updated = await updateJourneyForAtlas(created.id, atlasA, {
      ...baseJourney,
      title: "Route edit",
      routePoints: [...baseJourney.routePoints].reverse(),
    });
    expect(updated?.routePoints.map((point) => point.sortOrder)).toEqual([0, 1]);
    expect(updated?.routePoints.map((point) => point.label)).toEqual(["", "Singapore"]);
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
  });
});
