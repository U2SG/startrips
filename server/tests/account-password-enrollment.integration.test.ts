import { randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createPasswordReverificationGrant,
  listAccountIdentityMethods,
} from "../account-identities/account-identity-repository";
import {
  AccountPasswordEnrollmentError,
  enrollAccountPassword,
} from "../account-identities/password-enrollment";
import { app } from "../app";
import { auth } from "../auth";
import { serverConfig } from "../config";
import { accountIdentityAudit, atlases, journeys } from "../db/app-schema";
import {
  account as authAccount,
  member as authMember,
  organization as authOrganization,
  session as authSession,
  user as authUser,
} from "../db/auth-schema";
import { db, pool } from "../db/client";

/**
 * #445: first-password enrollment for a stable Startrips user who holds no
 * usable password credential. The sibling suite
 * `account-password-change.integration.test.ts` covers the replacement path;
 * everything here is about the state that one refuses with
 * `CREDENTIAL_ACCOUNT_NOT_FOUND` — and about the rule that enrollment adds a
 * login method to the EXISTING user instead of creating a second one.
 */

const TEST_ORIGIN = serverConfig.appOrigin;

// Synthetic credentials only. Nothing here is a real account secret, and the
// values never leave this process.
const FIRST_PASSWORD = "st102-first-passphrase";
const OTHER_PASSWORD = "st102-other-passphrase";
const EXISTING_PASSWORD = "st102-existing-passphrase";
// Under the configured `minPasswordLength` of 10.
const SHORT_PASSWORD = "st102-x";

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

/**
 * Better Auth reads the session from its own signed cookie, so a synthetic
 * fixture has to present one. Signing with the configured secret and cookie
 * name keeps the test on the real authoritative-session path instead of
 * stubbing it out.
 */
async function sessionCookie(token: string) {
  const context = await authContext();
  const signed = `${token}.${await makeSignature(token, context.secret)}`;
  return `${context.authCookies.sessionToken.name}=${signed}`;
}

async function sessionHeaders(token: string) {
  const headers = new Headers();
  headers.set("cookie", await sessionCookie(token));
  return headers;
}

/**
 * A stable user with its own organization, membership, Atlas and Journey — the
 * identity that enrollment must leave completely alone apart from gaining one
 * credential row.
 *
 * `credential` is the starting login state: `none` is the credential-less user
 * this feature is for, `password` already holds a usable credential, and
 * `empty` is the degenerate row Better Auth's own `setPassword` lookup skips
 * (it requires a non-null password), which therefore reaches its `linkAccount`
 * insert and collides with the `account_provider_subject_unique` index.
 */
async function seedUser(label: string, options: {
  sessionCount?: number;
  credential?: "none" | "empty" | "password";
  emailVerified?: boolean;
} = {}) {
  const sessionCount = options.sessionCount ?? 1;
  const credential = options.credential ?? "none";
  const userId = "st102-user-" + randomUUID();
  const email = label + "-" + randomUUID() + "@example.test";
  const organizationId = "st102-org-" + randomUUID();
  const atlasId = randomUUID();
  const journeyId = randomUUID();
  const sessions = Array.from({ length: sessionCount }, () => ({
    id: "st102-session-" + randomUUID(),
    token: "st102-token-" + randomUUID(),
  }));
  userIds.push(userId);
  organizationIds.push(organizationId);

  await db.insert(authUser).values({
    id: userId,
    name: label,
    email,
    emailVerified: options.emailVerified ?? true,
  });
  if (credential !== "none") {
    await db.insert(authAccount).values({
      id: "st102-account-" + randomUUID(),
      // The same (providerId, accountId) pair Better Auth's `linkAccount` uses.
      accountId: userId,
      providerId: "credential",
      userId,
      password: credential === "password"
        ? await hashPassword(EXISTING_PASSWORD)
        : null,
    });
  }
  await db.insert(authSession).values(sessions.map((session, index) => ({
    id: session.id,
    token: session.token,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000 + index),
  })));
  await db.insert(authOrganization).values({
    id: organizationId,
    name: label + " Atlas",
    slug: "st102-" + randomUUID(),
    createdAt: new Date(),
  });
  const [member] = await db.insert(authMember).values({
    id: "st102-member-" + randomUUID(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  }).returning({ id: authMember.id });
  await db.insert(atlases).values({
    id: atlasId,
    organizationId,
    title: label + " Atlas",
    dedication: "",
  });
  await db.insert(journeys).values({
    id: journeyId,
    atlasId,
    title: label + " Journey",
    startedOn: "2026-01-02",
    createdByUserId: userId,
  });
  return {
    userId,
    email,
    organizationId,
    atlasId,
    journeyId,
    memberId: member!.id,
    sessions,
  };
}

type Fixture = Awaited<ReturnType<typeof seedUser>>;

async function grantFor(fixture: Fixture, options: {
  sessionIndex?: number;
  now?: Date;
} = {}) {
  return await createPasswordReverificationGrant(
    fixture.userId,
    fixture.sessions[options.sessionIndex ?? 0]!.id,
    options.now,
  );
}

async function enroll(fixture: Fixture, values: {
  sessionIndex?: number;
  newPassword?: string;
  reverificationToken: string;
}) {
  const session = fixture.sessions[values.sessionIndex ?? 0]!;
  return await enrollAccountPassword({
    userId: fixture.userId,
    sessionId: session.id,
    newPassword: values.newPassword ?? FIRST_PASSWORD,
    reverificationToken: values.reverificationToken,
    headers: await sessionHeaders(session.token),
  });
}

async function enrollOverHttp(fixture: Fixture, body: unknown, options: {
  sessionIndex?: number;
  origin?: string;
  authenticated?: boolean;
} = {}) {
  const session = fixture.sessions[options.sessionIndex ?? 0]!;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: options.origin ?? TEST_ORIGIN,
  };
  if (options.authenticated !== false) {
    headers.cookie = await sessionCookie(session.token);
  }
  return await app.request(
    `${TEST_ORIGIN}/api/account-identities/password/enrollment`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

async function credentialAccounts(userId: string) {
  return await db
    .select({
      accountId: authAccount.accountId,
      password: authAccount.password,
    })
    .from(authAccount)
    .where(and(
      eq(authAccount.userId, userId),
      eq(authAccount.providerId, "credential"),
    ));
}

async function auditRows(userId: string) {
  return await db
    .select()
    .from(accountIdentityAudit)
    .where(and(
      eq(accountIdentityAudit.userId, userId),
      eq(accountIdentityAudit.event, "password-enroll"),
    ));
}

/** Observes whether the Better Auth write was reached at all. */
function watchSetPassword() {
  return vi.spyOn(auth.api, "setPassword");
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

async function expectRefusal(operation: Promise<unknown>, code: string) {
  await expect(operation).rejects.toMatchObject({
    name: "AccountPasswordEnrollmentError",
    code,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(accountIdentityAudit)
      .where(inArray(accountIdentityAudit.userId, userIds));
    await db.delete(authUser).where(inArray(authUser.id, userIds));
  }
  if (organizationIds.length > 0) {
    await db.delete(atlases)
      .where(inArray(atlases.organizationId, organizationIds));
    await db.delete(authOrganization)
      .where(inArray(authOrganization.id, organizationIds));
  }
  await pool.end();
});

describe("first password enrollment", () => {
  it("links one credential to the existing user and leaves that identity intact", async () => {
    const fixture = await seedUser("enrolled", { sessionCount: 2 });
    const grant = await grantFor(fixture);

    const result = await enroll(fixture, { reverificationToken: grant.token });
    expect(result).toEqual({ enrolled: true, alreadyEnrolled: false });

    // Exactly one credential, linked to this user rather than a new one.
    const credentials = await credentialAccounts(fixture.userId);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.accountId).toBe(fixture.userId);
    expect(await passwordMatches(credentials[0]!.password!, FIRST_PASSWORD))
      .toBe(true);

    // The same stable user, the same Atlas membership, the same Journey.
    const [user] = await db.select().from(authUser)
      .where(eq(authUser.id, fixture.userId));
    expect(user?.email).toBe(fixture.email);
    expect(await db.select({ id: authUser.id }).from(authUser)
      .where(eq(authUser.email, fixture.email))).toHaveLength(1);
    expect(await db.select({ id: authMember.id }).from(authMember)
      .where(eq(authMember.userId, fixture.userId)))
      .toEqual([{ id: fixture.memberId }]);
    expect(await db.select({ id: authOrganization.id }).from(authOrganization)
      .where(eq(authOrganization.id, fixture.organizationId))).toHaveLength(1);
    expect(await db.select({ id: journeys.id }).from(journeys)
      .where(eq(journeys.atlasId, fixture.atlasId)))
      .toEqual([{ id: fixture.journeyId }]);

    // Adding a login method is not rotating a secret, so no session is revoked.
    const remaining = await db.select({ id: authSession.id }).from(authSession)
      .where(eq(authSession.userId, fixture.userId));
    expect(remaining.map((row) => row.id).sort())
      .toEqual(fixture.sessions.map((session) => session.id).sort());

    // Exactly one receipt, bound to the consumed grant and carrying no secret.
    const audit = await auditRows(fixture.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "success", reason: null });
    expect(audit[0]!.actionId).toBeTruthy();

    const methods = await listAccountIdentityMethods(
      fixture.userId,
      new Set<string>(),
    );
    expect(methods).toMatchObject([{ type: "password", usable: true }]);
  });

  it("keeps a user who already holds a credential on the change-password path", async () => {
    const fixture = await seedUser("existing", { credential: "password" });
    const grant = await grantFor(fixture);
    const setPassword = watchSetPassword();

    await expectRefusal(
      enroll(fixture, { reverificationToken: grant.token }),
      "PASSWORD_ENROLL_ALREADY_SET",
    );
    expect(setPassword).not.toHaveBeenCalled();

    const credentials = await credentialAccounts(fixture.userId);
    expect(credentials).toHaveLength(1);
    expect(await passwordMatches(credentials[0]!.password!, EXISTING_PASSWORD))
      .toBe(true);
    expect(await auditRows(fixture.userId)).toMatchObject([{
      outcome: "refused",
      reason: "PASSWORD_ENROLL_ALREADY_SET",
    }]);
  });

  it("refuses an unverified recovery address before any Better Auth call", async () => {
    const fixture = await seedUser("unverified", { emailVerified: false });
    const grant = await grantFor(fixture);
    const setPassword = watchSetPassword();

    await expectRefusal(
      enroll(fixture, { reverificationToken: grant.token }),
      "PASSWORD_ENROLL_RECOVERY_REQUIRED",
    );
    expect(setPassword).not.toHaveBeenCalled();
    expect(await credentialAccounts(fixture.userId)).toHaveLength(0);
    expect(await auditRows(fixture.userId)).toMatchObject([{
      outcome: "refused",
      reason: "PASSWORD_ENROLL_RECOVERY_REQUIRED",
    }]);
  });

  it("refuses a password under the configured minimum and links nothing", async () => {
    const fixture = await seedUser("weak");
    const grant = await grantFor(fixture);

    await expectRefusal(
      enroll(fixture, {
        newPassword: SHORT_PASSWORD,
        reverificationToken: grant.token,
      }),
      "PASSWORD_ENROLL_PASSWORD_TOO_SHORT",
    );
    expect(await credentialAccounts(fixture.userId)).toHaveLength(0);

    // The refused attempt spent the grant: it was a completed sensitive
    // action, so retrying it is a replay rather than a second authorization.
    await expectRefusal(
      enroll(fixture, { reverificationToken: grant.token }),
      "PASSWORD_ENROLL_REVERIFY_REPLAYED",
    );
    expect(await credentialAccounts(fixture.userId)).toHaveLength(0);
  });

  it("refuses an unknown, expired or foreign-session grant", async () => {
    const fixture = await seedUser("grants", { sessionCount: 2 });

    await expectRefusal(
      enroll(fixture, { reverificationToken: "st102-not-a-grant" }),
      "PASSWORD_ENROLL_REVERIFY_INVALID",
    );

    const expired = await grantFor(fixture, {
      now: new Date(Date.now() - 60 * 60 * 1000),
    });
    await expectRefusal(
      enroll(fixture, { reverificationToken: expired.token }),
      "PASSWORD_ENROLL_REVERIFY_EXPIRED",
    );

    // A grant minted for the user's other session is not authority here.
    const otherSession = await grantFor(fixture, { sessionIndex: 1 });
    await expectRefusal(
      enroll(fixture, { reverificationToken: otherSession.token }),
      "PASSWORD_ENROLL_SESSION_CHANGED",
    );

    expect(await credentialAccounts(fixture.userId)).toHaveLength(0);
  });

  it("answers a retry of the same completed request without enrolling twice", async () => {
    const fixture = await seedUser("retry");
    const grant = await grantFor(fixture);

    expect(await enroll(fixture, { reverificationToken: grant.token }))
      .toEqual({ enrolled: true, alreadyEnrolled: false });

    const setPassword = watchSetPassword();
    expect(await enroll(fixture, {
      newPassword: OTHER_PASSWORD,
      reverificationToken: grant.token,
    })).toEqual({ enrolled: false, alreadyEnrolled: true });
    expect(setPassword).not.toHaveBeenCalled();

    // The replay changed nothing: one credential, still the first password,
    // still one receipt.
    const credentials = await credentialAccounts(fixture.userId);
    expect(credentials).toHaveLength(1);
    expect(await passwordMatches(credentials[0]!.password!, FIRST_PASSWORD))
      .toBe(true);
    expect(await passwordMatches(credentials[0]!.password!, OTHER_PASSWORD))
      .toBe(false);
    expect(await auditRows(fixture.userId)).toHaveLength(1);
  });

  it("creates no second credential when two enrollments run concurrently", async () => {
    const fixture = await seedUser("concurrent");
    const [first, second] = await Promise.all([grantFor(fixture), grantFor(fixture)]);

    const results = await Promise.allSettled([
      enroll(fixture, { reverificationToken: first.token }),
      enroll(fixture, {
        newPassword: OTHER_PASSWORD,
        reverificationToken: second.token,
      }),
    ]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason)
      .toBeInstanceOf(AccountPasswordEnrollmentError);
    expect((rejected[0] as PromiseRejectedResult).reason.code)
      .toBe("PASSWORD_ENROLL_ALREADY_SET");

    const credentials = await credentialAccounts(fixture.userId);
    expect(credentials).toHaveLength(1);
    // One winner, one refusal; the two rows have no deterministic order.
    const audit = await auditRows(fixture.userId);
    expect(audit.map((row) => row.outcome).sort())
      .toEqual(["refused", "success"]);
    expect(audit.find((row) => row.outcome === "refused")?.reason)
      .toBe("PASSWORD_ENROLL_ALREADY_SET");
  });

  it("refuses rather than duplicating when a credential row already occupies the identity", async () => {
    // Better Auth skips a null-password `credential` row when it looks for an
    // existing password, so this reaches its insert and the durable
    // `account_provider_subject_unique` index answers. #198 rule: a unique
    // violation is the database reporting the real state, not a bug to
    // pre-empt with a read.
    const fixture = await seedUser("occupied", { credential: "empty" });
    const grant = await grantFor(fixture);

    await expectRefusal(
      enroll(fixture, { reverificationToken: grant.token }),
      "PASSWORD_ENROLL_ALREADY_SET",
    );
    expect(await credentialAccounts(fixture.userId))
      .toEqual([{ accountId: fixture.userId, password: null }]);
  });
});

describe("first password enrollment route", () => {
  it("enrolls through the route and reports the enrollment", async () => {
    const fixture = await seedUser("route-success");
    const grant = await grantFor(fixture);

    const response = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: grant.token,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: true,
      enrolled: true,
      alreadyEnrolled: false,
    });
    expect(await credentialAccounts(fixture.userId)).toHaveLength(1);
  });

  it("refuses a missing, foreign or spent grant without reaching Better Auth", async () => {
    const fixture = await seedUser("route-refusals", { sessionCount: 2 });
    const setPassword = watchSetPassword();

    const missing = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "PASSWORD_ENROLL_INVALID" });

    const expired = await grantFor(fixture, {
      now: new Date(Date.now() - 60 * 60 * 1000),
    });
    const stale = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: expired.token,
    });
    expect(stale.status).toBe(403);
    expect(await stale.json())
      .toEqual({ error: "PASSWORD_ENROLL_REVERIFY_EXPIRED" });

    const foreign = await grantFor(fixture, { sessionIndex: 1 });
    const mismatched = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: foreign.token,
    });
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json())
      .toEqual({ error: "PASSWORD_ENROLL_SESSION_CHANGED" });

    const spent = await grantFor(fixture);
    await expectRefusal(
      enroll(fixture, {
        newPassword: SHORT_PASSWORD,
        reverificationToken: spent.token,
      }),
      "PASSWORD_ENROLL_PASSWORD_TOO_SHORT",
    );
    const replayed = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: spent.token,
    });
    expect(replayed.status).toBe(403);
    expect(await replayed.json())
      .toEqual({ error: "PASSWORD_ENROLL_REVERIFY_REPLAYED" });

    // Only the short-password attempt above may have reached the write.
    expect(setPassword).toHaveBeenCalledTimes(1);
    expect(await credentialAccounts(fixture.userId)).toHaveLength(0);
  });

  it("refuses a cross-origin or unauthenticated caller", async () => {
    const fixture = await seedUser("route-origin");
    const grant = await grantFor(fixture);
    const setPassword = watchSetPassword();

    const crossOrigin = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: grant.token,
    }, { origin: "https://attacker.example" });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json())
      .toEqual({ error: "PASSWORD_ENROLL_ORIGIN_REQUIRED" });

    const anonymous = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: grant.token,
    }, { authenticated: false });
    expect(anonymous.status).toBe(401);

    expect(setPassword).not.toHaveBeenCalled();
    expect(await credentialAccounts(fixture.userId)).toHaveLength(0);
  });

  it("keeps the password and the grant out of responses, logs and the audit row", async () => {
    const fixture = await seedUser("logging");
    const grant = await grantFor(fixture);
    const logs = captureLogs();

    const response = await enrollOverHttp(fixture, {
      newPassword: FIRST_PASSWORD,
      reverificationToken: grant.token,
    });
    expect(response.status).toBe(200);
    const body = await response.text();

    const [credential] = await credentialAccounts(fixture.userId);
    const audit = await auditRows(fixture.userId);
    const secrets = [FIRST_PASSWORD, grant.token, credential!.password!];
    const written = [
      body,
      JSON.stringify(audit),
      ...capturedLines(logs),
    ];
    expect(capturedLines(logs).length).toBeGreaterThan(0);
    for (const line of written) {
      for (const secret of secrets) {
        expect(line).not.toContain(secret);
      }
    }
  });
});
