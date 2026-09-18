import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { accountExperiencePreferences, atlases } from "../db/app-schema";
import {
  organization as authOrganizations,
  rateLimit,
  user as authUsers,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { createJourneyForAtlas } from "../repositories/journey-repository";

/**
 * #387: the account-scoped Earth experience preference, end to end.
 *
 * The questions this file exists to answer are all about OWNERSHIP rather than
 * about storing a string: whose row a request reaches, what a person who is
 * not that person sees, and what a write leaves behind in the rest of the
 * product.
 */

const TEST_ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "test-only-password-387";
const PREFERENCE_URL = `${TEST_ORIGIN}/api/account-preferences/earth-experience`;

const createdUserEmails: string[] = [];
const createdOrganizationIds: string[] = [];

type PreferenceBody = {
  earthExperience: string;
  revision: number;
  updatedAt: string | null;
};

function authHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    ...(cookie ? { cookie } : {}),
  };
}

/**
 * One verified account with its own Atlas, the way the product creates one.
 *
 * Better Auth rate-limits sign-up and sign-in per address independently of
 * anything this feature does, and ownership questions need more than one
 * account, so the budget is cleared the way
 * `account-identity-routes.integration.test.ts` clears it.
 */
async function createAccount(label: string) {
  await db.delete(rateLimit);
  const email = `st087-${label}-${randomUUID()}@example.test`;
  createdUserEmails.push(email);
  const signUp = await app.request(`${TEST_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: label, email, password: PASSWORD }),
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
  const { cookie, userId } = await signIn(email);
  const organizationResponse = await app.request(
    `${TEST_ORIGIN}/api/auth/organization/create`,
    {
      method: "POST",
      headers: authHeaders(cookie),
      body: JSON.stringify({
        name: `${label} Atlas`,
        slug: `st087-${label.toLowerCase()}-${randomUUID()}`,
      }),
    },
  );
  expect(organizationResponse.status).toBe(200);
  const organization = await organizationResponse.json() as { id: string };
  createdOrganizationIds.push(organization.id);
  const bootstrap = await app.request(`${TEST_ORIGIN}/api/atlases/bootstrap`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ title: `${label} Atlas`, dedication: "private" }),
  });
  expect([200, 201]).toContain(bootstrap.status);
  const payload = await bootstrap.json() as { atlas: { id: string } };
  return { email, cookie, userId, atlasId: payload.atlas.id };
}

async function signIn(email: string) {
  await db.delete(rateLimit);
  const response = await app.request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0];
  expect(cookie).toBeTruthy();
  const { user } = await response.json() as { user: { id: string } };
  return { cookie: cookie!, userId: user.id };
}

async function readPreference(cookie?: string) {
  const response = await app.request(PREFERENCE_URL, {
    headers: authHeaders(cookie),
  });
  return response;
}

async function writePreference(cookie: string | undefined, body: unknown) {
  return await app.request(PREFERENCE_URL, {
    method: "PUT",
    headers: authHeaders(cookie),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function storedRows(userId: string) {
  return await db
    .select()
    .from(accountExperiencePreferences)
    .where(eq(accountExperiencePreferences.userId, userId));
}

let alice: Awaited<ReturnType<typeof createAccount>>;
let bob: Awaited<ReturnType<typeof createAccount>>;

beforeAll(async () => {
  alice = await createAccount("alice");
  bob = await createAccount("bob");
});

afterAll(async () => {
  for (const id of createdOrganizationIds) {
    await db.delete(authOrganizations).where(eq(authOrganizations.id, id));
  }
  for (const email of createdUserEmails) {
    await db.delete(authUsers).where(eq(authUsers.email, email));
  }
  await pool.end();
});

describe("Earth experience preference: absence", () => {
  it("answers the documented default without writing a row", async () => {
    const response = await readPreference(bob.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      earthExperience: "default",
      revision: 0,
      updatedAt: null,
    });
    // A read that lazily inserted would silently make "never chose" and
    // "chose default" the same state, and would leave a trace that somebody
    // was looked at.
    expect(await storedRows(bob.userId)).toHaveLength(0);
  });
});

describe("Earth experience preference: round trip", () => {
  it("stores a chosen value and reads it back with version truth", async () => {
    const write = await writePreference(alice.cookie, {
      earthExperience: "particle-only",
    });
    expect(write.status).toBe(200);
    expect(write.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const written = await write.json() as PreferenceBody;
    expect(written.earthExperience).toBe("particle-only");
    expect(written.revision).toBe(1);
    expect(written.updatedAt).not.toBeNull();

    const read = await readPreference(alice.cookie);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual(written);
    expect(await storedRows(alice.userId)).toHaveLength(1);
  });

  it("converges on a repeated same-value write without moving version truth", async () => {
    const before = await readPreference(alice.cookie);
    const baseline = await before.json() as PreferenceBody;
    expect(baseline.earthExperience).toBe("particle-only");

    const repeat = await writePreference(alice.cookie, {
      earthExperience: "particle-only",
    });
    expect(repeat.status).toBe(200);
    // `revision` counts value transitions, not requests: storing the value
    // that is already stored is a no-op, so a client can tell "my write landed
    // and changed nothing" from "someone moved this since I read it".
    await expect(repeat.json()).resolves.toEqual(baseline);
    expect(await storedRows(alice.userId)).toHaveLength(1);
  });

  it("advances revision and updatedAt on a real transition", async () => {
    const before = await readPreference(alice.cookie);
    const baseline = await before.json() as PreferenceBody;

    const changed = await writePreference(alice.cookie, {
      earthExperience: "default",
    });
    expect(changed.status).toBe(200);
    const body = await changed.json() as PreferenceBody;
    expect(body.earthExperience).toBe("default");
    expect(body.revision).toBe(baseline.revision + 1);
    expect(Date.parse(body.updatedAt!)).toBeGreaterThanOrEqual(
      Date.parse(baseline.updatedAt!),
    );
    expect(await storedRows(alice.userId)).toHaveLength(1);
  });
});

describe("Earth experience preference: malformed input", () => {
  const rejected: { name: string; body: unknown }[] = [
    { name: "an unknown value", body: { earthExperience: "detail-only" } },
    { name: "a casing variant", body: { earthExperience: "Particle-Only" } },
    { name: "a padded value", body: { earthExperience: " particle-only" } },
    { name: "an empty string", body: { earthExperience: "" } },
    { name: "a null value", body: { earthExperience: null } },
    { name: "a numeric value", body: { earthExperience: 1 } },
    { name: "an array value", body: { earthExperience: ["particle-only"] } },
    { name: "an omitted field", body: {} },
    { name: "a non-object document", body: "\"particle-only\"" },
    { name: "a syntactically broken document", body: "{ not json" },
  ];

  for (const { name, body } of rejected) {
    it(`refuses ${name} and leaves the stored value alone`, async () => {
      const before = await readPreference(alice.cookie);
      const baseline = await before.json() as PreferenceBody;

      const response = await writePreference(alice.cookie, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_EARTH_EXPERIENCE",
      });

      const after = await readPreference(alice.cookie);
      await expect(after.json()).resolves.toEqual(baseline);
    });
  }
});

describe("Earth experience preference: repeated and concurrent updates", () => {
  it("inserts exactly one row when identical writes race from absence", async () => {
    const racer = await createAccount("racer");
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        writePreference(racer.cookie, { earthExperience: "particle-only" })),
    );
    for (const response of responses) expect(response.status).toBe(200);

    const rows = await storedRows(racer.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.earthExperience).toBe("particle-only");
    // Five identical writes are one transition. A conflicting insert that fell
    // back to a blind `revision + 1` would read 5 here.
    expect(rows[0]!.revision).toBe(1);
    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({
        earthExperience: "particle-only",
        revision: 1,
        updatedAt: rows[0]!.updatedAt.toISOString(),
      });
    }
  });

  it("leaves one deterministic winner when conflicting writes race", async () => {
    const racer = await createAccount("contender");
    const values = [
      "particle-only",
      "default",
      "particle-only",
      "default",
      "particle-only",
      "default",
    ];
    const responses = await Promise.all(
      values.map((earthExperience) =>
        writePreference(racer.cookie, { earthExperience })),
    );
    for (const response of responses) expect(response.status).toBe(200);

    const rows = await storedRows(racer.userId);
    expect(rows).toHaveLength(1);
    const winner = rows[0]!;
    expect(["default", "particle-only"]).toContain(winner.earthExperience);

    // Every answered response described a row that really was durable at that
    // moment; none of them can be ahead of the final committed revision.
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<PreferenceBody>),
    );
    for (const body of bodies) {
      expect(body.revision).toBeLessThanOrEqual(winner.revision);
      expect(body.revision).toBeGreaterThanOrEqual(1);
    }
    // The highest revision any caller was told about is the one that survived,
    // with the value that caller was told about.
    const latest = bodies.reduce((a, b) => (b.revision > a.revision ? b : a));
    expect(latest.revision).toBe(winner.revision);
    expect(latest.earthExperience).toBe(winner.earthExperience);

    // And a fresh read agrees with the row, so no caller was handed a state
    // the database does not hold.
    const read = await readPreference(racer.cookie);
    await expect(read.json()).resolves.toEqual({
      earthExperience: winner.earthExperience,
      revision: winner.revision,
      updatedAt: winner.updatedAt.toISOString(),
    });
  });
});

describe("Earth experience preference: who owns the row", () => {
  it("keeps two accounts' preferences independent", async () => {
    await writePreference(alice.cookie, { earthExperience: "particle-only" });
    const bobBefore = await readPreference(bob.cookie);
    // Bob has never chosen, and Alice's choice is not his.
    await expect(bobBefore.json()).resolves.toEqual({
      earthExperience: "default",
      revision: 0,
      updatedAt: null,
    });

    const aliceBaseline = await (await readPreference(alice.cookie)).json() as PreferenceBody;
    const bobWrite = await writePreference(bob.cookie, {
      earthExperience: "particle-only",
    });
    expect(bobWrite.status).toBe(200);
    expect((await bobWrite.json() as PreferenceBody).revision).toBe(1);

    await expect((await readPreference(alice.cookie)).json()).resolves.toEqual(
      aliceBaseline,
    );
    expect(await storedRows(alice.userId)).toHaveLength(1);
    expect(await storedRows(bob.userId)).toHaveLength(1);
  });

  it("ignores a userId in the body and writes only the session's own row", async () => {
    const bobBefore = await (await readPreference(bob.cookie)).json() as PreferenceBody;
    const response = await writePreference(alice.cookie, {
      earthExperience: "default",
      userId: bob.userId,
      atlasId: bob.atlasId,
    });
    expect(response.status).toBe(200);
    expect((await response.json() as PreferenceBody).earthExperience).toBe("default");
    // Bob's row is untouched: the route names the one field it accepts, and
    // the user id comes only from the resolved session.
    await expect((await readPreference(bob.cookie)).json()).resolves.toEqual(
      bobBefore,
    );
  });

  it("serves a share-grant holder their own preference, never the sharer's", async () => {
    await writePreference(alice.cookie, { earthExperience: "particle-only" });
    await writePreference(bob.cookie, { earthExperience: "default" });

    const journey = await createJourneyForAtlas(alice.atlasId, alice.userId, {
      title: "Shared north",
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
    });
    if (!journey) throw new Error("Journey fixture was not created");
    const created = await app.request(`${TEST_ORIGIN}/api/shares`, {
      method: "POST",
      headers: authHeaders(alice.cookie),
      body: JSON.stringify({
        journeyIds: [journey.id],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(created.status).toBe(201);
    const { token } = await created.json() as { token: string };

    // A guest is a bearer token, not a session. The token authorizes exactly
    // the shared Journeys under `/api/shared`; it says nothing about who the
    // sharer is as an account.
    const guest = await app.request(PREFERENCE_URL, {
      headers: { authorization: `Bearer ${token}`, origin: TEST_ORIGIN },
    });
    expect(guest.status).toBe(401);
    await expect(guest.json()).resolves.toEqual({ error: "UNAUTHORIZED" });

    const guestWrite = await app.request(PREFERENCE_URL, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ earthExperience: "default" }),
    });
    expect(guestWrite.status).toBe(401);

    // Bob is signed in AND holds the same token. He still gets his own value,
    // because the preference is derived from his session, not from the Atlas
    // the token opens.
    const holder = await app.request(PREFERENCE_URL, {
      headers: {
        ...authHeaders(bob.cookie),
        authorization: `Bearer ${token}`,
      },
    });
    expect(holder.status).toBe(200);
    expect((await holder.json() as PreferenceBody).earthExperience).toBe("default");
    // Alice's own choice survived every one of those requests.
    const aliceRows = await storedRows(alice.userId);
    expect(aliceRows[0]!.earthExperience).toBe("particle-only");
  });
});

describe("Earth experience preference: session lifetime", () => {
  it("refuses an unauthenticated read and write", async () => {
    const read = await readPreference();
    expect(read.status).toBe(401);
    await expect(read.json()).resolves.toEqual({ error: "UNAUTHORIZED" });
    const write = await writePreference(undefined, {
      earthExperience: "particle-only",
    });
    expect(write.status).toBe(401);
  });

  it("cannot reuse a signed-out session's cookie for the next account", async () => {
    const leaver = await createAccount("leaver");
    await writePreference(leaver.cookie, { earthExperience: "particle-only" });
    const stored = await storedRows(leaver.userId);
    expect(stored[0]!.earthExperience).toBe("particle-only");

    const signOut = await app.request(`${TEST_ORIGIN}/api/auth/sign-out`, {
      method: "POST",
      headers: authHeaders(leaver.cookie),
    });
    expect(signOut.status).toBe(200);

    // The same browser now belongs to Bob. The stale cookie resolves to no
    // session at all, so it can neither read the previous account's value nor
    // write onto the new one's row.
    const staleRead = await readPreference(leaver.cookie);
    expect(staleRead.status).toBe(401);
    const bobBefore = await (await readPreference(bob.cookie)).json() as PreferenceBody;
    const staleWrite = await writePreference(leaver.cookie, {
      earthExperience: "default",
    });
    expect(staleWrite.status).toBe(401);
    await expect((await readPreference(bob.cookie)).json()).resolves.toEqual(
      bobBefore,
    );
    expect((await storedRows(leaver.userId))[0]!.earthExperience).toBe(
      "particle-only",
    );

    // Signing back in reaches the same durable row: the preference belongs to
    // the stable user, not to a session.
    const again = await signIn(leaver.email);
    const restored = await readPreference(again.cookie);
    expect((await restored.json() as PreferenceBody).earthExperience).toBe(
      "particle-only",
    );
  });
});

describe("Earth experience preference: blast radius", () => {
  it("changes no Atlas or Journey state", async () => {
    const [atlasBefore] = await db
      .select()
      .from(atlases)
      .where(eq(atlases.id, alice.atlasId));
    const journeysBefore = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: authHeaders(alice.cookie),
    });
    const journeyPayloadBefore = await journeysBefore.text();

    const write = await writePreference(alice.cookie, {
      earthExperience: "particle-only",
    });
    expect(write.status).toBe(200);
    const second = await writePreference(alice.cookie, {
      earthExperience: "default",
    });
    expect(second.status).toBe(200);

    const [atlasAfter] = await db
      .select()
      .from(atlases)
      .where(eq(atlases.id, alice.atlasId));
    expect(atlasAfter).toEqual(atlasBefore);
    const journeysAfter = await app.request(`${TEST_ORIGIN}/api/journeys`, {
      headers: authHeaders(alice.cookie),
    });
    expect(await journeysAfter.text()).toBe(journeyPayloadBefore);
  });
});
