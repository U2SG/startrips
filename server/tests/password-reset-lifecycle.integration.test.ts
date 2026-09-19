import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { auth } from "../auth";
import { serverConfig } from "../config";
import { atlases } from "../db/app-schema";
import {
  account as authAccount,
  member as authMember,
  organization as authOrganization,
  rateLimit,
  session as authSession,
  user as authUser,
  verification as authVerification,
} from "../db/auth-schema";
import { db, pool } from "../db/client";

/**
 * #425: the native Better Auth password-reset lifecycle, proven end to end
 * against the pinned 1.6.23 endpoints. Nothing here introduces a second reset
 * token store or a second password hash path — the point is that the
 * configuration already on `main` actually delivers the guarantees #344 needs:
 * anti-enumeration, a one-time expiring credential, single-winner concurrency,
 * session revocation, and a stable Startrips user and Atlas across the
 * rotation.
 */

const TEST_ORIGIN = serverConfig.appOrigin;

/**
 * Better Auth keys its limiter `${ip}|${path}` (`@better-auth/core/utils/ip`),
 * so a rate-limit fixture is scoped by choosing addresses no other suite uses
 * and deleting only those rows. TEST-NET-1 is free here: the identity-route
 * suite occupies 203.0.113.x and 198.51.100.x. Truncating the shared
 * `rateLimit` table instead would silently reset every other suite's budget.
 */
const FIXTURE_IP_PREFIX = "192.0.2.";
const ENUMERATION_IP = `${FIXTURE_IP_PREFIX}10`;
const LIFECYCLE_IP = `${FIXTURE_IP_PREFIX}20`;
const CONCURRENCY_IP = `${FIXTURE_IP_PREFIX}30`;
const REVOCATION_IP = `${FIXTURE_IP_PREFIX}40`;
const LOGGING_IP = `${FIXTURE_IP_PREFIX}50`;

// Synthetic credentials only. Nothing here is a real account secret, and the
// values never leave this process.
const ORIGINAL_PASSWORD = "st096-original-passphrase";
const REPLACEMENT_PASSWORD = "st096-replacement-passphrase";
const RACE_PASSWORD_A = "st096-race-passphrase-alpha";
const RACE_PASSWORD_B = "st096-race-passphrase-bravo";

const RESET_IDENTIFIER_PREFIX = "reset-password:";

const userIds: string[] = [];
const organizationIds: string[] = [];

async function authContext() {
  return await auth.$context;
}

async function hashPassword(password: string) {
  return await (await authContext()).password.hash(password);
}

async function passwordMatches(hash: string, password: string) {
  return await (await authContext()).password.verify({ hash, password });
}

function headers(ip: string, cookie = "") {
  return {
    "content-type": "application/json",
    origin: TEST_ORIGIN,
    "x-forwarded-for": ip,
    ...(cookie ? { cookie } : {}),
  };
}

/**
 * A verified credential account with its own organization, membership and
 * Atlas — the identity that has to survive a credential rotation unchanged.
 * Seeded directly rather than through sign-up so the suite spends no
 * `/sign-up/email` or verification-mail budget on setup.
 */
async function seedUser(label: string) {
  const userId = `st096-user-${randomUUID()}`;
  const email = `st096-${label}-${randomUUID()}@example.test`;
  const organizationId = `st096-org-${randomUUID()}`;
  const accountId = `st096-account-${randomUUID()}`;
  const atlasId = randomUUID();
  userIds.push(userId);
  organizationIds.push(organizationId);

  await db.insert(authUser).values({
    id: userId,
    name: label,
    email,
    emailVerified: true,
  });
  await db.insert(authAccount).values({
    id: accountId,
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(ORIGINAL_PASSWORD),
  });
  await db.insert(authOrganization).values({
    id: organizationId,
    name: `${label} Atlas`,
    slug: `st096-${randomUUID()}`,
    createdAt: new Date(),
  });
  await db.insert(authMember).values({
    id: `st096-member-${randomUUID()}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(atlases).values({
    id: atlasId,
    organizationId,
    title: `${label} Atlas`,
    dedication: "",
  });
  return { userId, email, organizationId, accountId, atlasId };
}

async function requestReset(email: string, ip: string) {
  return await app.request(`${TEST_ORIGIN}/api/auth/request-password-reset`, {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({ email }),
  });
}

async function submitReset(token: string, newPassword: string, ip: string) {
  return await app.request(`${TEST_ORIGIN}/api/auth/reset-password`, {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({ token, newPassword }),
  });
}

async function signIn(email: string, password: string, ip: string) {
  return await app.request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({ email, password }),
  });
}

function sessionCookie(response: Response) {
  return response.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0] ?? "";
}

async function resetTokensFor(userId: string) {
  const rows = await db
    .select({ identifier: authVerification.identifier })
    .from(authVerification)
    .where(and(
      eq(authVerification.value, userId),
      like(authVerification.identifier, `${RESET_IDENTIFIER_PREFIX}%`),
    ))
    .orderBy(desc(authVerification.createdAt));
  return rows.map((row) => row.identifier.slice(RESET_IDENTIFIER_PREFIX.length));
}

async function latestResetToken(userId: string) {
  const [token] = await resetTokensFor(userId);
  expect(token).toBeTruthy();
  return token!;
}

async function storedPasswordHash(userId: string) {
  const [row] = await db
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(and(
      eq(authAccount.userId, userId),
      eq(authAccount.providerId, "credential"),
    ))
    .limit(1);
  return row?.password ?? null;
}

/** A reset credential that the pinned endpoint will find already expired. */
async function seedExpiredResetToken(userId: string) {
  const token = `st096-expired-${randomUUID()}`;
  await db.insert(authVerification).values({
    id: `st096-verification-${randomUUID()}`,
    identifier: `${RESET_IDENTIFIER_PREFIX}${token}`,
    value: userId,
    expiresAt: new Date(Date.now() - 60_000),
  });
  return token;
}

function captureLogs() {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

function capturedLines(logs: ReturnType<typeof captureLogs>) {
  return Object.values(logs).flatMap((spy) =>
    spy.mock.calls.map((call) => call.map(String).join(" "))
  );
}

/**
 * The mail send is deliberately fire-and-forget (`sendInBackground`), so the
 * sink writes its line after the HTTP response resolves. Asserting on the
 * captured log immediately would pass because nothing had been logged yet.
 */
async function waitForLine(
  logs: ReturnType<typeof captureLogs>,
  needle: string,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (capturedLines(logs).some((line) => line.includes(needle))) return;
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 10); });
  }
  expect(capturedLines(logs)).toContain(needle);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(authVerification)
      .where(inArray(authVerification.value, userIds));
    await db.delete(authUser).where(inArray(authUser.id, userIds));
  }
  if (organizationIds.length > 0) {
    await db.delete(atlases)
      .where(inArray(atlases.organizationId, organizationIds));
    await db.delete(authOrganization)
      .where(inArray(authOrganization.id, organizationIds));
  }
  await db.delete(rateLimit)
    .where(like(rateLimit.key, `${FIXTURE_IP_PREFIX}%`));
  await pool.end();
});

describe("native password-reset lifecycle", () => {
  it("answers a known and an unknown address identically and still stops the fourth request", async () => {
    await db.delete(rateLimit)
      .where(like(rateLimit.key, `${ENUMERATION_IP}|%`));
    const fixture = await seedUser("enumeration");

    const known = await requestReset(fixture.email, ENUMERATION_IP);
    const unknown = await requestReset(
      `st096-absent-${randomUUID()}@example.test`,
      ENUMERATION_IP,
    );
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    // The public contract is the whole answer, not just its status: a probe
    // must not be able to read account existence out of the body either.
    expect(await unknown.json()).toEqual(await known.json());

    const third = await requestReset(
      `st096-absent-${randomUUID()}@example.test`,
      ENUMERATION_IP,
    );
    expect(third.status).toBe(200);

    const fourth = await requestReset(fixture.email, ENUMERATION_IP);
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("x-retry-after"))).toBeGreaterThan(0);

    // The refusal is a real refusal: the throttled request minted nothing, so
    // the only outstanding credential is the one the first request created.
    expect(await resetTokensFor(fixture.userId)).toHaveLength(1);
  });

  it("refuses an expired, malformed or already-used credential and never replays a spent one", async () => {
    const fixture = await seedUser("lifecycle");
    const original = await storedPasswordHash(fixture.userId);
    expect(original).not.toBeNull();

    const malformed = await submitReset(
      `st096-not-a-token-${randomUUID()}`,
      REPLACEMENT_PASSWORD,
      LIFECYCLE_IP,
    );
    expect(malformed.status).toBe(400);
    expect(await storedPasswordHash(fixture.userId)).toBe(original);

    const expired = await submitReset(
      await seedExpiredResetToken(fixture.userId),
      REPLACEMENT_PASSWORD,
      LIFECYCLE_IP,
    );
    expect(expired.status).toBe(400);
    expect(await storedPasswordHash(fixture.userId)).toBe(original);

    expect((await requestReset(fixture.email, LIFECYCLE_IP)).status).toBe(200);
    const token = await latestResetToken(fixture.userId);
    const accepted = await submitReset(
      token,
      REPLACEMENT_PASSWORD,
      LIFECYCLE_IP,
    );
    expect(accepted.status).toBe(200);
    const rotated = await storedPasswordHash(fixture.userId);
    expect(rotated).not.toBe(original);
    expect(await passwordMatches(rotated!, REPLACEMENT_PASSWORD)).toBe(true);
    expect(await passwordMatches(rotated!, ORIGINAL_PASSWORD)).toBe(false);

    // The credential is single-use: a captured token is worthless afterwards,
    // and the second attempt changes nothing rather than rotating again.
    const replay = await submitReset(
      token,
      `${REPLACEMENT_PASSWORD}-again`,
      LIFECYCLE_IP,
    );
    expect(replay.status).toBe(400);
    expect(await storedPasswordHash(fixture.userId)).toBe(rotated);
    expect(await resetTokensFor(fixture.userId)).toHaveLength(0);
  });

  it("lets exactly one of two in-flight resets of one token win", async () => {
    const fixture = await seedUser("concurrent");
    expect((await requestReset(fixture.email, CONCURRENCY_IP)).status).toBe(200);
    const token = await latestResetToken(fixture.userId);

    const attempts = [
      { password: RACE_PASSWORD_A },
      { password: RACE_PASSWORD_B },
    ];
    const outcomes = await Promise.all(attempts.map(async (attempt) => ({
      ...attempt,
      status: (await submitReset(token, attempt.password, CONCURRENCY_IP)).status,
    })));

    const winners = outcomes.filter((outcome) => outcome.status === 200);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 400)).toHaveLength(1);

    // The stored credential is the winner's, derived from which response
    // succeeded rather than from the order the promises were created in.
    const hash = await storedPasswordHash(fixture.userId);
    expect(await passwordMatches(hash!, winners[0]!.password)).toBe(true);
    const loser = outcomes.find((outcome) => outcome.status !== 200)!;
    expect(await passwordMatches(hash!, loser.password)).toBe(false);
    expect(await passwordMatches(hash!, ORIGINAL_PASSWORD)).toBe(false);
  });

  it("revokes the pre-reset session while the stable user and Atlas stay put", async () => {
    const fixture = await seedUser("revocation");
    const signedIn = await signIn(
      fixture.email,
      ORIGINAL_PASSWORD,
      REVOCATION_IP,
    );
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);
    expect(cookie).toBeTruthy();
    const authorized = await app.request(
      `${TEST_ORIGIN}/api/account-preferences/earth-experience`,
      { headers: headers(REVOCATION_IP, cookie) },
    );
    expect(authorized.status).toBe(200);

    expect((await requestReset(fixture.email, REVOCATION_IP)).status).toBe(200);
    const reset = await submitReset(
      await latestResetToken(fixture.userId),
      REPLACEMENT_PASSWORD,
      REVOCATION_IP,
    );
    expect(reset.status).toBe(200);

    // `revokeSessionsOnPasswordReset` is the reason a stolen-password recovery
    // is a recovery: the session the thief still holds stops authorizing.
    const afterReset = await app.request(
      `${TEST_ORIGIN}/api/account-preferences/earth-experience`,
      { headers: headers(REVOCATION_IP, cookie) },
    );
    expect(afterReset.status).toBe(401);
    expect(await db.select({ id: authSession.id }).from(authSession)
      .where(eq(authSession.userId, fixture.userId))).toHaveLength(0);

    expect((await signIn(fixture.email, ORIGINAL_PASSWORD, REVOCATION_IP)).status)
      .not.toBe(200);
    const reauthenticated = await signIn(
      fixture.email,
      REPLACEMENT_PASSWORD,
      REVOCATION_IP,
    );
    expect(reauthenticated.status).toBe(200);
    expect((await reauthenticated.json() as { user: { id: string } }).user.id)
      .toBe(fixture.userId);

    // Rotating a credential rotates nothing about identity or ownership: the
    // same stable user, the same single credential row rather than a forked
    // second one, and the same membership and Atlas.
    expect(await db.select().from(authUser)
      .where(eq(authUser.id, fixture.userId))).toMatchObject([{
        id: fixture.userId,
        email: fixture.email,
      }]);
    expect(await db.select().from(authAccount)
      .where(eq(authAccount.userId, fixture.userId))).toMatchObject([{
        id: fixture.accountId,
        accountId: fixture.userId,
        providerId: "credential",
      }]);
    expect(await db.select().from(authMember)
      .where(eq(authMember.userId, fixture.userId))).toMatchObject([{
        organizationId: fixture.organizationId,
        role: "owner",
      }]);
    expect(await db.select().from(atlases)
      .where(eq(atlases.id, fixture.atlasId))).toMatchObject([{
        organizationId: fixture.organizationId,
      }]);
  });

  it("keeps the reset token and the password out of responses and application logs", async () => {
    const fixture = await seedUser("logging");
    const logs = captureLogs();

    const requested = await requestReset(fixture.email, LOGGING_IP);
    expect(requested.status).toBe(200);
    const requestedBody = await requested.text();

    // Wait for the fire-and-forget sink to actually run, so the assertions
    // below grade a line that exists rather than an empty capture.
    await waitForLine(logs, `[development email] ${fixture.email}:`);
    expect(capturedLines(logs).some((line) =>
      line.includes("body omitted: sensitive")
    )).toBe(true);

    const token = await latestResetToken(fixture.userId);
    const reset = await submitReset(token, REPLACEMENT_PASSWORD, LOGGING_IP);
    expect(reset.status).toBe(200);
    const resetBody = await reset.text();

    const secrets = [token, ORIGINAL_PASSWORD, REPLACEMENT_PASSWORD];
    for (const line of capturedLines(logs)) {
      for (const secret of secrets) {
        expect(line).not.toContain(secret);
      }
    }
    for (const body of [requestedBody, resetBody]) {
      for (const secret of secrets) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it("keeps the reset return target on the single configured origin", () => {
    expect(auth.options.trustedOrigins).toEqual([serverConfig.appOrigin]);
  });
});
