import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { count, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import {
  atlases,
  everydayFragments,
  homeBasePeriods,
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
  countEverydayFragmentsForAtlas,
  createEverydayFragmentForAtlas,
  deleteEverydayFragmentForAtlas,
  listEverydayFragmentsForAtlas,
} from "../repositories/everyday-fragment-repository";
import { createHomeBasePeriodForAtlas } from "../repositories/home-base-repository";
import { createJourneyForAtlas } from "../repositories/journey-repository";
import { groupEverydayFragmentsByHomeBase } from "../../src/journey/everydayFragment";

/**
 * #234: the database-level media-ownership invariant, the fragment deletion
 * guarantee and the Journey-only Journey list, against the real PostgreSQL 17
 * the `core` CI lane provisions.
 *
 * Media now has two possible owners and exactly one at a time. That is a
 * CHECK constraint rather than a convention, so these assertions insert
 * directly and expect the database itself to refuse — an application-level
 * guard would only prove that one code path happens to be careful.
 */

const TEST_ORIGIN = "http://127.0.0.1:5173";
const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];

const baseJourney = {
  startedOn: "2024-04-18",
  endedOn: "2024-04-20",
  note: "private",
  lightColor: "#f4ce73",
  routePoints: [
    {
      latitude: 22.543096,
      longitude: 114.057865,
      label: "Shenzhen",
      isStop: true,
      occurredAt: new Date("2024-04-18T00:00:00Z"),
    },
    {
      latitude: 22.198745,
      longitude: 113.543873,
      label: "",
      isStop: false,
      occurredAt: new Date("2024-04-19T00:00:00Z"),
    },
  ],
};

const EVENING = {
  occurredOn: "2026-03-14",
  latitude: 22.503,
  longitude: 113.938,
  placeLabel: "Shenzhen Bay Park",
  note: "A walk after work.",
  homeBasePeriodId: null,
};

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

/**
 * One authenticated identity with its own Atlas, so the Journey-only
 * assertion can go through the real `GET /api/journeys` rather than through
 * the repository the route happens to call.
 */
async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  // `/sign-up/email` allows five attempts per ten minutes with the counters in
  // the database, shared with every other integration file in the run. The
  // same clear `media-preview.integration.test.ts` performs; this file creates
  // exactly one identity.
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
  return { cookie: cookie!, atlasId: payload.atlas.id };
}

async function freshAtlas(label: string): Promise<string> {
  const [atlas] = await db
    .insert(atlases)
    .values({
      organizationId: `test-org-fragments-int-${label}-${randomUUID()}`,
      title: `${label} Atlas`,
    })
    .returning({ id: atlases.id });
  atlasIds.push(atlas.id);
  return atlas.id;
}

async function journeyMediaCount(journeyId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(mediaAssets)
    .where(eq(mediaAssets.journeyId, journeyId));
  return Number(row.total);
}

/** A media row with only the owner columns varied, so the CHECK is the subject. */
function mediaValues(owners: {
  journeyId?: string | null;
  everydayFragmentId?: string | null;
  routePointId?: string | null;
}) {
  return {
    journeyId: owners.journeyId ?? null,
    everydayFragmentId: owners.everydayFragmentId ?? null,
    routePointId: owners.routePointId ?? null,
    storageDriver: "disabled",
    storageKey: `test/fragments/${randomUUID()}.jpg`,
    fileName: "evening.jpg",
    mimeType: "image/jpeg",
    bytes: 1024,
    uploadedByUserId: "user-fragments",
  };
}

let atlasId = "";
let otherAtlasId = "";
let journeyId = "";
let routePointId = "";
let journeyAssetId = "";
let fragmentId = "";
let member: Awaited<ReturnType<typeof createAuthenticatedAtlas>>;

beforeAll(async () => {
  atlasId = await freshAtlas("first");
  otherAtlasId = await freshAtlas("second");

  const journey = await createJourneyForAtlas(atlasId, "user-fragments", {
    ...baseJourney,
    title: "Shenzhen to Macau",
  });
  if (!journey) throw new Error("Journey fixture was not created");
  journeyId = journey.id;

  const [point] = await db
    .select({ id: journeyRoutePoints.id })
    .from(journeyRoutePoints)
    .where(eq(journeyRoutePoints.journeyId, journeyId))
    .limit(1);
  routePointId = point.id;

  const [asset] = await db
    .insert(mediaAssets)
    .values(mediaValues({ journeyId, routePointId }))
    .returning({ id: mediaAssets.id });
  journeyAssetId = asset.id;

  const created = await createEverydayFragmentForAtlas(
    atlasId,
    "user-fragments",
    EVENING,
  );
  if (created.outcome !== "ok") {
    throw new Error(`Fragment fixture was not created: ${created.outcome}`);
  }
  fragmentId = created.fragment.id;

  member = await createAuthenticatedAtlas("Fragmentmember");
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

describe("media belongs to exactly one owner", () => {
  it("rejects a media asset that names both a Journey and a fragment", async () => {
    await expect(db
      .insert(mediaAssets)
      .values(mediaValues({ journeyId, everydayFragmentId: fragmentId })))
      .rejects.toThrow(/media_assets_single_owner/);
  });

  it("rejects a media asset that names neither owner", async () => {
    // Before #234 this was impossible because `journey_id` was NOT NULL.
    // Relaxing it to admit a second owner would otherwise have admitted an
    // orphan owned by nobody and reachable from nothing.
    await expect(db.insert(mediaAssets).values(mediaValues({})))
      .rejects.toThrow(/media_assets_single_owner/);
  });

  it("rejects a fragment-owned asset that carries a route point", async () => {
    // Every Route Point belongs to some Journey, so a fragment-owned asset
    // hanging off one would be media a fragment owns and a foreign Journey's
    // route positions.
    await expect(db
      .insert(mediaAssets)
      .values(mediaValues({ everydayFragmentId: fragmentId, routePointId })))
      .rejects.toThrow(/media_assets_single_owner/);
  });

  it("accepts each legal shape", async () => {
    const [fragmentOwned] = await db
      .insert(mediaAssets)
      .values(mediaValues({ everydayFragmentId: fragmentId }))
      .returning({ id: mediaAssets.id });
    const [journeyOwned] = await db
      .insert(mediaAssets)
      .values(mediaValues({ journeyId }))
      .returning({ id: mediaAssets.id });
    expect(fragmentOwned.id).toBeTruthy();
    expect(journeyOwned.id).toBeTruthy();
    await db
      .delete(mediaAssets)
      .where(inArray(mediaAssets.id, [fragmentOwned.id, journeyOwned.id]));
  });
});

describe("removing an everyday fragment", () => {
  it("leaves the atlas's journeys, route points and Journey-owned media intact", async () => {
    const doomed = await createEverydayFragmentForAtlas(
      atlasId,
      "user-fragments",
      { ...EVENING, occurredOn: "2026-03-15", note: "Recorded by mistake." },
    );
    if (doomed.outcome !== "ok") throw new Error("Fragment was not created");
    const [fragmentAsset] = await db
      .insert(mediaAssets)
      .values(mediaValues({ everydayFragmentId: doomed.fragment.id }))
      .returning({ id: mediaAssets.id });

    const journeysBefore = await db
      .select({ total: count() })
      .from(journeys)
      .where(eq(journeys.atlasId, atlasId));
    const pointsBefore = await db
      .select({ total: count() })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId));
    const journeyMediaBefore = await journeyMediaCount(journeyId);
    expect(journeyMediaBefore).toBeGreaterThan(0);

    const deleted = await deleteEverydayFragmentForAtlas(
      atlasId,
      doomed.fragment.id,
    );
    expect(deleted).toEqual({ id: doomed.fragment.id });

    // Its own media went with it, and nothing else moved.
    expect(await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, fragmentAsset.id))).toEqual([]);
    expect(await db
      .select({ total: count() })
      .from(journeys)
      .where(eq(journeys.atlasId, atlasId))).toEqual(journeysBefore);
    expect(await db
      .select({ total: count() })
      .from(journeyRoutePoints)
      .where(eq(journeyRoutePoints.journeyId, journeyId))).toEqual(pointsBefore);
    expect(await journeyMediaCount(journeyId)).toBe(journeyMediaBefore);
    expect(await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, journeyAssetId))).toEqual([
        { id: journeyAssetId },
      ]);
    // And the fragment the atlas still holds is untouched.
    expect(await countEverydayFragmentsForAtlas(atlasId)).toBe(1);
  });

  it("keeps a fragment when the Home Base period it named is withdrawn", async () => {
    const period = await createHomeBasePeriodForAtlas(otherAtlasId, {
      label: "Shenzhen",
      latitude: 22.543096,
      longitude: 114.057865,
      startedOn: "2022-06-01",
      endedOn: null,
      source: "manual",
    });
    if (!period) throw new Error("Home Base fixture was not created");

    const created = await createEverydayFragmentForAtlas(
      otherAtlasId,
      "user-fragments",
      { ...EVENING, homeBasePeriodId: period.id },
    );
    if (created.outcome !== "ok") throw new Error("Fragment was not created");

    await db.delete(homeBasePeriods).where(eq(homeBasePeriods.id, period.id));

    // `on delete set null`: withdrawing a life period must never delete the
    // ordinary evening that happened during it.
    const [remaining] = await listEverydayFragmentsForAtlas(otherAtlasId);
    expect(remaining).toMatchObject({
      id: created.fragment.id,
      occurredOn: EVENING.occurredOn,
      latitude: EVENING.latitude,
      longitude: EVENING.longitude,
      homeBasePeriodId: null,
    });
    // Grouping is derived, so the fragment falls back to the ungrouped bucket
    // rather than becoming unreadable.
    expect(groupEverydayFragmentsByHomeBase([remaining], []))
      .toEqual({ groups: [], ungrouped: [remaining] });
  });

  it("refuses a Home Base period that did not hold on the fragment's date", async () => {
    // Ownership is not enough: a same-atlas period whose interval does not
    // contain `occurredOn` would persist an association that disagrees with
    // what `resolveHomeBaseForDate` answers, showing one fragment in two
    // different chapters of the member's life.
    const period = await createHomeBasePeriodForAtlas(atlasId, {
      label: "Porto",
      latitude: 41.157944,
      longitude: -8.629105,
      startedOn: "2019-01-01",
      endedOn: "2020-01-01",
      source: "manual",
    });
    if (!period) throw new Error("Home Base fixture was not created");

    const outside = await createEverydayFragmentForAtlas(
      atlasId,
      "user-fragments",
      { ...EVENING, homeBasePeriodId: period.id },
    );
    expect(outside).toEqual({ outcome: "home-base-not-covering" });

    // The same period accepts a fragment recorded inside its interval, and
    // the day it ended belongs to no period under the half-open rule.
    const inside = await createEverydayFragmentForAtlas(
      atlasId,
      "user-fragments",
      { ...EVENING, occurredOn: "2019-08-09", homeBasePeriodId: period.id },
    );
    expect(inside).toMatchObject({
      outcome: "ok",
      fragment: { homeBasePeriodId: period.id },
    });
    expect(await createEverydayFragmentForAtlas(atlasId, "user-fragments", {
      ...EVENING,
      occurredOn: "2020-01-01",
      homeBasePeriodId: period.id,
    })).toEqual({ outcome: "home-base-not-covering" });

    if (inside.outcome === "ok") {
      await deleteEverydayFragmentForAtlas(atlasId, inside.fragment.id);
    }
    await db.delete(homeBasePeriods).where(eq(homeBasePeriods.id, period.id));
  });

  it("cannot reach a fragment owned by another atlas", async () => {
    expect(await deleteEverydayFragmentForAtlas(otherAtlasId, fragmentId))
      .toBeUndefined();
    expect(await countEverydayFragmentsForAtlas(atlasId)).toBe(1);
  });
});

describe("the Journey list stays Journey-only", () => {
  it("returns only Journey rows for an atlas that also holds everyday fragments", async () => {
    const journey = await createJourneyForAtlas(member.atlasId, "user-fragments", {
      ...baseJourney,
      title: "One recorded trip",
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const fragment = await createEverydayFragmentForAtlas(
      member.atlasId,
      "user-fragments",
      EVENING,
    );
    if (fragment.outcome !== "ok") throw new Error("Fragment was not created");

    const response = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: authHeaders(member.cookie),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      journeys: Array<{ id: string; title: string }>;
    };
    // Exactly the Journey, and nothing derived from the fragment: an ordinary
    // evening must not fill the Journey list.
    expect(payload.journeys.map((entry) => entry.id)).toEqual([journey.id]);
    expect(payload.journeys.map((entry) => entry.title))
      .toEqual(["One recorded trip"]);

    // The fragment is real, and it is served by its own surface only.
    const fragmentsResponse = await app.request(
      `${TEST_ORIGIN}/api/everyday-fragments`,
      { headers: authHeaders(member.cookie) },
    );
    expect(fragmentsResponse.status).toBe(200);
    const fragmentsPayload = await fragmentsResponse.json() as {
      fragments: Array<{ id: string }>;
    };
    expect(fragmentsPayload.fragments.map((entry) => entry.id))
      .toEqual([fragment.fragment.id]);
  });

  it("never lets a fragment-owned asset be read as Journey media", async () => {
    const [fragmentOwned] = await db
      .insert(mediaAssets)
      .values(mediaValues({ everydayFragmentId: fragmentId }))
      .returning({ id: mediaAssets.id });

    // The Journey loader keys media by a non-null `journey_id`, so an asset a
    // fragment owns is not merely filtered out of a view — it is not in the
    // result set the view is built from.
    const ownerless = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(isNull(mediaAssets.journeyId));
    expect(ownerless.map((row) => row.id)).toContain(fragmentOwned.id);

    const response = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: authHeaders(member.cookie),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      journeys: Array<{ media: Array<{ id: string }> }>;
    };
    expect(payload.journeys.flatMap((entry) => entry.media.map((m) => m.id)))
      .not.toContain(fragmentOwned.id);

    await db.delete(mediaAssets).where(eq(mediaAssets.id, fragmentOwned.id));
  });
});

describe("the generated migration is the one applied", () => {
  it("carries the single-owner check constraint in the live schema", async () => {
    // Proves the constraint reached the database through the drizzle-kit
    // migration the `core` lane applies, not just the TypeScript schema.
    const { rows } = await db.execute(sql`
      select conname
      from pg_constraint
      where conrelid = 'media_assets'::regclass
        and contype = 'c'
        and conname = 'media_assets_single_owner'
    `);
    expect(rows).toHaveLength(1);
  });
});
