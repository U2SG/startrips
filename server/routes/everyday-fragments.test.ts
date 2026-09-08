import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { atlases, everydayFragments } from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { hasAtlasPermission } from "../authorization/permissions";
import { db, pool } from "../db/client";

/**
 * #234: the HTTP surface, through the real `app` so the Atlas really is
 * derived from the session and the `onError` envelope really is the one a
 * client sees. Everything below the request is the same PostgreSQL the `core`
 * CI lane provisions.
 */

const TEST_ORIGIN = "http://127.0.0.1:5173";
const FRAGMENTS_URL = `${TEST_ORIGIN}/api/everyday-fragments`;
const atlasIds: string[] = [];
const authOrganizationIds: string[] = [];
const authUserEmails: string[] = [];

const EVENING = {
  occurredOn: "2026-03-14",
  latitude: 22.503,
  longitude: 113.938,
  placeLabel: "Shenzhen Bay Park",
  note: "A walk after work.",
};

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

// The same lifecycle `home-bases.test.ts` uses: Better Auth rate-limits
// sign-ups independently of the anonymous limiter, so each identity is created
// once for the whole file.
async function createAuthenticatedAtlas(label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = "test-only-password-123";
  authUserEmails.push(email);
  // `/sign-up/email` allows five attempts per ten minutes with the counters in
  // the database, so they are shared with every other integration file in the
  // run and are mostly spent by the time this one starts. Counters a previous
  // FILE left behind go; the product limit itself is untouched.
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

type FragmentPayload = {
  fragment: {
    id: string;
    occurredOn: string;
    latitude: number;
    longitude: number;
    placeLabel: string | null;
    note: string | null;
    homeBasePeriodId: string | null;
  };
};

async function createFragment(cookie: string, body: unknown) {
  const response = await app.request(FRAGMENTS_URL, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json() as FragmentPayload).fragment;
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

describe("the Atlas an Everyday Fragment is written to", () => {
  it("ignores a body-supplied atlas or organization ID", async () => {
    // The one rule the whole module rests on: the Atlas comes from the
    // session's active Organization, so naming someone else's here changes
    // nothing about where the fragment lands.
    const fragment = await createFragment(resident.cookie, {
      ...EVENING,
      atlasId: neighbour.atlasId,
      organizationId: neighbour.organizationId,
    });

    const [stored] = await db
      .select({ atlasId: everydayFragments.atlasId })
      .from(everydayFragments)
      .where(eq(everydayFragments.id, fragment.id));
    expect(stored.atlasId).toBe(resident.atlasId);
    expect(stored.atlasId).not.toBe(neighbour.atlasId);

    // And it is invisible from the Atlas the body named.
    const neighbourList = await app.request(FRAGMENTS_URL, {
      headers: authHeaders(neighbour.cookie),
    });
    expect(neighbourList.status).toBe(200);
    const { fragments } = await neighbourList.json() as {
      fragments: Array<{ id: string }>;
    };
    expect(fragments.map((entry) => entry.id)).not.toContain(fragment.id);
  });

  it("answers 404 for a fragment that belongs to another atlas", async () => {
    const fragment = await createFragment(resident.cookie, { ...EVENING });

    const foreignUpdate = await app.request(`${FRAGMENTS_URL}/${fragment.id}`, {
      method: "PUT",
      headers: authHeaders(neighbour.cookie),
      body: JSON.stringify({ ...EVENING, note: "Not mine to edit." }),
    });
    expect(foreignUpdate.status).toBe(404);
    expect(await foreignUpdate.json())
      .toMatchObject({ error: "EVERYDAY_FRAGMENT_NOT_FOUND" });

    const foreignDelete = await app.request(`${FRAGMENTS_URL}/${fragment.id}`, {
      method: "DELETE",
      headers: authHeaders(neighbour.cookie),
    });
    expect(foreignDelete.status).toBe(404);

    // A foreign id is answered exactly like one that does not exist, so the
    // refusal discloses nothing, and the row is still there.
    const missing = await app.request(`${FRAGMENTS_URL}/${randomUUID()}`, {
      method: "DELETE",
      headers: authHeaders(neighbour.cookie),
    });
    expect(missing.status).toBe(404);
    expect(await db
      .select({ id: everydayFragments.id })
      .from(everydayFragments)
      .where(eq(everydayFragments.id, fragment.id))).toEqual([
        { id: fragment.id },
      ]);
  });

  it("requires a session at all", async () => {
    const anonymous = await app.request(FRAGMENTS_URL, {
      headers: authHeaders(),
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "AUTH_REQUIRED" });
  });
});

describe("an unusable fragment document", () => {
  it("is refused with the validation reason code in the app error envelope", async () => {
    // The code comes from the pure validator and leaves through
    // `server/app.ts` `onError`, not from JSON composed in the route, so a
    // client learns which field is wrong from `error` rather than from prose.
    const cases: Array<[unknown, string]> = [
      [{ latitude: 22.5, longitude: 113.9 }, "EVERYDAY_FRAGMENT_INVALID_DATE"],
      [{ ...EVENING, occurredOn: "2026-3-14" }, "EVERYDAY_FRAGMENT_INVALID_DATE"],
      [{ ...EVENING, latitude: 91 }, "EVERYDAY_FRAGMENT_INVALID_LATITUDE"],
      [{ ...EVENING, longitude: -181 }, "EVERYDAY_FRAGMENT_INVALID_LONGITUDE"],
      [{ ...EVENING, note: 7 }, "EVERYDAY_FRAGMENT_INVALID_TEXT"],
      [
        { ...EVENING, homeBasePeriodId: "nope" },
        "EVERYDAY_FRAGMENT_INVALID_HOME_BASE_PERIOD",
      ],
    ];
    for (const [body, code] of cases) {
      const response = await app.request(FRAGMENTS_URL, {
        method: "POST",
        headers: authHeaders(resident.cookie),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const payload = await response.json() as {
        error: string;
        message: string;
      };
      expect(payload.error).toBe(code);
      expect(payload.message.length).toBeGreaterThan(0);
    }
  });

  it("refuses a non-object body without disclosing which failure it was", async () => {
    const response = await app.request(FRAGMENTS_URL, {
      method: "POST",
      headers: authHeaders(resident.cookie),
      body: "not json at all",
    });
    expect(response.status).toBe(400);
    expect(await response.json())
      .toMatchObject({ error: "INVALID_EVERYDAY_FRAGMENT" });
  });

  it("refuses a Home Base period this atlas does not own", async () => {
    // A well-formed identifier that belongs to nobody here. The foreign key
    // alone would have accepted another atlas's period and made it observable
    // through the fragment it was attached to.
    const response = await app.request(FRAGMENTS_URL, {
      method: "POST",
      headers: authHeaders(resident.cookie),
      body: JSON.stringify({ ...EVENING, homeBasePeriodId: randomUUID() }),
    });
    expect(response.status).toBe(404);
    expect(await response.json())
      .toMatchObject({ error: "HOME_BASE_PERIOD_NOT_FOUND" });
  });
});

describe("the fragment lifecycle", () => {
  it("records, serves, corrects and withdraws one everyday moment", async () => {
    const fragment = await createFragment(neighbour.cookie, {
      occurredOn: "2026-04-20",
      latitude: 35.68,
      longitude: 139.76,
    });
    // No title and no route were sent, and none was required.
    expect(fragment).toMatchObject({
      occurredOn: "2026-04-20",
      placeLabel: null,
      note: null,
      homeBasePeriodId: null,
    });

    const list = await app.request(FRAGMENTS_URL, {
      headers: authHeaders(neighbour.cookie),
    });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control"))
      .toBe("private, no-store, max-age=0");
    const { fragments } = await list.json() as {
      fragments: Array<{ id: string; occurredOn: string }>;
    };
    expect(fragments.map((entry) => entry.id)).toContain(fragment.id);
    const dates = fragments.map((entry) => entry.occurredOn);
    expect([...dates].sort().reverse()).toEqual(dates);

    const corrected = await app.request(`${FRAGMENTS_URL}/${fragment.id}`, {
      method: "PUT",
      headers: authHeaders(neighbour.cookie),
      body: JSON.stringify({
        occurredOn: "2026-04-21",
        latitude: 35.68,
        longitude: 139.76,
        note: "  It was the next evening.  ",
      }),
    });
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({
      fragment: {
        id: fragment.id,
        occurredOn: "2026-04-21",
        note: "It was the next evening.",
      },
    });

    const removed = await app.request(`${FRAGMENTS_URL}/${fragment.id}`, {
      method: "DELETE",
      headers: authHeaders(neighbour.cookie),
    });
    expect(removed.status).toBe(204);
    expect(await db
      .select({ id: everydayFragments.id })
      .from(everydayFragments)
      .where(eq(everydayFragments.id, fragment.id))).toEqual([]);
  });
});

describe("the authorization level each verb asks for", () => {
  it("keeps recording and withdrawing reachable by a member", () => {
    // A member who can record an ordinary evening must be able to withdraw one
    // they recorded by mistake, so DELETE asks for `update` rather than the
    // owner-only `delete` action.
    expect(hasAtlasPermission("member", "read")).toBe(true);
    expect(hasAtlasPermission("member", "create")).toBe(true);
    expect(hasAtlasPermission("member", "update")).toBe(true);
    expect(hasAtlasPermission("member", "delete")).toBe(false);
  });
});
