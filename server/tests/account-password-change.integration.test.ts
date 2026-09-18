import { randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPasswordReverificationGrant,
  listAccountIdentityMethods,
} from "../account-identities/account-identity-repository";
import { changeAccountPassword } from "../account-identities/password-change";
import { auth } from "../auth";
import { accountIdentityAudit, atlases } from "../db/app-schema";
import {
  account as authAccount,
  member as authMember,
  organization as authOrganization,
  session as authSession,
  user as authUser,
  verification as authVerification,
} from "../db/auth-schema";
import { db, pool } from "../db/client";

// Synthetic credentials only. Nothing here is a real account secret, and the
// values never leave this process.
const CURRENT_PASSWORD = "st092-current-passphrase";
const NEXT_PASSWORD = "st092-replacement-passphrase";
const SHORT_PASSWORD = "st092-x";

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
async function sessionHeaders(token: string) {
  const context = await authContext();
  const signed = `${token}.${await makeSignature(token, context.secret)}`;
  const headers = new Headers();
  headers.set("cookie", `${context.authCookies.sessionToken.name}=${signed}`);
  return headers;
}

async function seedUser(label: string, options: {
  sessionCount?: number;
  withPassword?: boolean;
} = {}) {
  const sessionCount = options.sessionCount ?? 1;
  const userId = "st092-user-" + randomUUID();
  const email = label + "-" + randomUUID() + "@example.test";
  const organizationId = "st092-org-" + randomUUID();
  const accountId = "st092-account-" + randomUUID();
  const atlasId = randomUUID();
  const sessions = Array.from({ length: sessionCount }, () => ({
    id: "st092-session-" + randomUUID(),
    token: "st092-token-" + randomUUID(),
  }));
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
    password: options.withPassword === false
      ? null
      : await hashPassword(CURRENT_PASSWORD),
  });
  await db.insert(authSession).values(sessions.map((session, index) => ({
    id: session.id,
    token: session.token,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000 + index),
  })));
  await db.insert(authOrganization).values({
    id: organizationId,
    name: label + " Atlas",
    slug: "st092-" + randomUUID(),
    createdAt: new Date(),
  });
  await db.insert(authMember).values({
    id: "st092-member-" + randomUUID(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(atlases).values({
    id: atlasId,
    organizationId,
    title: label + " Atlas",
    dedication: "",
  });
  return { userId, email, organizationId, accountId, atlasId, sessions };
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

async function change(fixture: Awaited<ReturnType<typeof seedUser>>, values: {
  sessionIndex?: number;
  currentPassword?: string;
  newPassword?: string;
  reverificationToken: string;
}) {
  const session = fixture.sessions[values.sessionIndex ?? 0]!;
  return await changeAccountPassword({
    userId: fixture.userId,
    sessionId: session.id,
    currentPassword: values.currentPassword ?? CURRENT_PASSWORD,
    newPassword: values.newPassword ?? NEXT_PASSWORD,
    reverificationToken: values.reverificationToken,
    headers: await sessionHeaders(session.token),
  });
}

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

describe("authenticated account password change", () => {
  it("replaces the credential, keeps the caller signed in and preserves the stable account", async () => {
    const fixture = await seedUser("normal", { sessionCount: 3 });
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );
    await db.insert(authVerification).values({
      id: "st092-reset-" + randomUUID(),
      identifier: "reset-password:stale-token-" + randomUUID(),
      value: fixture.userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const result = await change(fixture, { reverificationToken: grant.token });
    expect(result).toEqual({
      changed: true,
      alreadyChanged: false,
      revokedOtherSessions: 2,
    });

    const hash = await storedPasswordHash(fixture.userId);
    expect(hash).not.toBeNull();
    expect(await passwordMatches(hash!, NEXT_PASSWORD)).toBe(true);
    expect(await passwordMatches(hash!, CURRENT_PASSWORD)).toBe(false);

    // Deterministic session rule: this session survives, every other one is
    // revoked, and no outstanding capability keyed to the user id remains.
    expect(await db.select({ id: authSession.id }).from(authSession)
      .where(eq(authSession.userId, fixture.userId)))
      .toEqual([{ id: fixture.sessions[0]!.id }]);
    expect(await db.select().from(authVerification)
      .where(eq(authVerification.value, fixture.userId))).toHaveLength(0);

    // The same stable user, the same single credential row, the same Atlas.
    const [user] = await db.select().from(authUser)
      .where(eq(authUser.id, fixture.userId));
    expect(user?.id).toBe(fixture.userId);
    expect(user?.email).toBe(fixture.email);
    expect(await db.select().from(authAccount)
      .where(eq(authAccount.userId, fixture.userId))).toMatchObject([{
        id: fixture.accountId,
        accountId: fixture.userId,
        providerId: "credential",
      }]);
    expect(await db.select().from(authMember)
      .where(eq(authMember.userId, fixture.userId))).toHaveLength(1);
    expect(await db.select().from(atlases)
      .where(eq(atlases.id, fixture.atlasId))).toMatchObject([{
        organizationId: fixture.organizationId,
      }]);

    const audits = await db.select().from(accountIdentityAudit)
      .where(eq(accountIdentityAudit.userId, fixture.userId));
    expect(audits.some((row) =>
      row.event === "password-change" && row.outcome === "success"
    )).toBe(true);
    const serializedAudit = JSON.stringify(audits);
    for (const secret of [CURRENT_PASSWORD, NEXT_PASSWORD, grant.token, hash!]) {
      expect(serializedAudit).not.toContain(secret);
    }
    const methods = JSON.stringify(
      await listAccountIdentityMethods(fixture.userId, new Set<string>()),
    );
    for (const secret of [CURRENT_PASSWORD, NEXT_PASSWORD, hash!]) {
      expect(methods).not.toContain(secret);
    }

    // A lost response is answered from the receipt of that exact grant rather
    // than by rotating the credential a second time.
    const retry = await change(fixture, { reverificationToken: grant.token });
    expect(retry).toEqual({
      changed: false,
      alreadyChanged: true,
      revokedOtherSessions: 0,
    });
    expect(await storedPasswordHash(fixture.userId)).toBe(hash);

    // The credential is the sign-in credential: the new secret authenticates
    // and the replaced one no longer does.
    await expect(auth.api.signInEmail({
      body: { email: fixture.email, password: CURRENT_PASSWORD },
    })).rejects.toBeDefined();
    const signedIn = await auth.api.signInEmail({
      body: { email: fixture.email, password: NEXT_PASSWORD },
    });
    expect(signedIn.user.id).toBe(fixture.userId);
  });

  it("refuses a wrong current password and spends that grant", async () => {
    const fixture = await seedUser("wrong-current", { sessionCount: 2 });
    const before = await storedPasswordHash(fixture.userId);
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );

    await expect(change(fixture, {
      reverificationToken: grant.token,
      currentPassword: CURRENT_PASSWORD + "-wrong",
    })).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID",
    });
    expect(await storedPasswordHash(fixture.userId)).toBe(before);
    // Revocation runs before the credential write so an interruption can only
    // over-revoke. A refused write therefore still costs the other sessions,
    // which is the deliberate conservative side of that trade.
    expect(await db.select({ id: authSession.id }).from(authSession)
      .where(eq(authSession.userId, fixture.userId)))
      .toEqual([{ id: fixture.sessions[0]!.id }]);

    // The refused attempt consumed the single-use grant, so guessing cannot be
    // retried behind one re-verification.
    await expect(change(fixture, { reverificationToken: grant.token }))
      .rejects.toMatchObject({ code: "PASSWORD_CHANGE_REVERIFY_REPLAYED" });
    expect(await storedPasswordHash(fixture.userId)).toBe(before);
  });

  it("refuses a new password below the configured policy", async () => {
    const fixture = await seedUser("weak");
    const before = await storedPasswordHash(fixture.userId);
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );

    await expect(change(fixture, {
      reverificationToken: grant.token,
      newPassword: SHORT_PASSWORD,
    })).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_PASSWORD_TOO_SHORT",
    });
    expect(await storedPasswordHash(fixture.userId)).toBe(before);
  });

  it("refuses a session that has expired but is still stored", async () => {
    const fixture = await seedUser("expired");
    const before = await storedPasswordHash(fixture.userId);
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );
    // The row survives, so the grant survives with it; only Better Auth's
    // authoritative session check can refuse this one.
    await db.update(authSession)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSession.id, fixture.sessions[0]!.id));

    await expect(change(fixture, { reverificationToken: grant.token }))
      .rejects.toMatchObject({ code: "PASSWORD_CHANGE_SESSION_EXPIRED" });
    expect(await storedPasswordHash(fixture.userId)).toBe(before);
  });

  it("refuses a revoked session, whose grants are gone with it", async () => {
    const fixture = await seedUser("revoked");
    const before = await storedPasswordHash(fixture.userId);
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );
    await db.delete(authSession)
      .where(eq(authSession.id, fixture.sessions[0]!.id));

    // A grant is a child of the session that proved the password, so revoking
    // that session cascades it away. The refusal is therefore about an
    // unusable grant rather than about the session, and either way no
    // credential is touched.
    await expect(change(fixture, { reverificationToken: grant.token }))
      .rejects.toMatchObject({ code: "PASSWORD_CHANGE_REVERIFY_INVALID" });
    expect(await storedPasswordHash(fixture.userId)).toBe(before);
  });

  it("refuses an account with no usable password credential", async () => {
    const fixture = await seedUser("no-credential", { withPassword: false });
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );

    await expect(change(fixture, { reverificationToken: grant.token }))
      .rejects.toMatchObject({ code: "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND" });
    expect(await storedPasswordHash(fixture.userId)).toBeNull();
  });

  it("refuses a grant issued to a different session of the same user", async () => {
    const fixture = await seedUser("session-bound", { sessionCount: 2 });
    const before = await storedPasswordHash(fixture.userId);
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[1]!.id,
    );

    await expect(change(fixture, {
      reverificationToken: grant.token,
      sessionIndex: 0,
    })).rejects.toMatchObject({ code: "PASSWORD_CHANGE_SESSION_CHANGED" });
    expect(await storedPasswordHash(fixture.userId)).toBe(before);
  });

  it("finishes an interrupted change instead of refusing its retry", async () => {
    const fixture = await seedUser("interrupted", { sessionCount: 2 });
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );
    await change(fixture, { reverificationToken: grant.token });
    const hash = await storedPasswordHash(fixture.userId);

    // Reproduce the state a crash between Better Auth's credential write and
    // the receipt leaves behind: the grant is spent, the new password is
    // stored, nothing recorded the completion, and a session that should have
    // been revoked is live again.
    await db.delete(accountIdentityAudit).where(and(
      eq(accountIdentityAudit.userId, fixture.userId),
      eq(accountIdentityAudit.event, "password-change"),
      eq(accountIdentityAudit.outcome, "success"),
    ));
    await db.insert(authSession).values({
      id: fixture.sessions[1]!.id,
      token: "st092-token-" + randomUUID(),
      userId: fixture.userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const recovered = await change(fixture, {
      reverificationToken: grant.token,
    });
    expect(recovered).toEqual({
      changed: false,
      alreadyChanged: true,
      revokedOtherSessions: 1,
    });
    expect(await storedPasswordHash(fixture.userId)).toBe(hash);
    expect(await db.select({ id: authSession.id }).from(authSession)
      .where(eq(authSession.userId, fixture.userId)))
      .toEqual([{ id: fixture.sessions[0]!.id }]);
    expect(await db.select({ id: accountIdentityAudit.id })
      .from(accountIdentityAudit)
      .where(and(
        eq(accountIdentityAudit.userId, fixture.userId),
        eq(accountIdentityAudit.event, "password-change"),
        eq(accountIdentityAudit.outcome, "success"),
      ))).toHaveLength(1);
  });

  it("rotates the credential once when the same grant is submitted concurrently", async () => {
    const fixture = await seedUser("concurrent", { sessionCount: 2 });
    const grant = await createPasswordReverificationGrant(
      fixture.userId,
      fixture.sessions[0]!.id,
    );

    const outcomes = await Promise.allSettled([
      change(fixture, { reverificationToken: grant.token }),
      change(fixture, { reverificationToken: grant.token }),
    ]);
    const performed = outcomes.filter((outcome) =>
      outcome.status === "fulfilled" && outcome.value.changed
    );
    expect(performed).toHaveLength(1);

    const hash = await storedPasswordHash(fixture.userId);
    expect(await passwordMatches(hash!, NEXT_PASSWORD)).toBe(true);
    expect(await db.select({ id: accountIdentityAudit.id })
      .from(accountIdentityAudit)
      .where(and(
        eq(accountIdentityAudit.userId, fixture.userId),
        eq(accountIdentityAudit.event, "password-change"),
        eq(accountIdentityAudit.outcome, "success"),
      ))).toHaveLength(1);
  });
});
