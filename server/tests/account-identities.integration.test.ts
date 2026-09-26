import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  accountIdentityActions,
  accountIdentityAudit,
  accountIdentityOwnerships,
} from "../db/app-schema";
import {
  account as authAccount,
  session as authSession,
  user as authUser,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import {
  AccountIdentityError,
  completeIdentityLink,
  createIdentityLinkIntent,
  createPasswordReverificationGrant,
  listAccountIdentityMethods,
  unlinkAccountIdentity,
} from "../account-identities/account-identity-repository";
import {
  issueVerifiedProviderIdentityProof,
  verifyProviderIdentityProof,
  type VerifiedProviderIdentity,
} from "../account-identities/provider-proof";

const PROOF_SECRET = "st067-synthetic-provider-proof";
const TEST_NOW = new Date("2026-09-13T12:00:00.000Z");
const userIds: string[] = [];

async function seedUser(label: string, credential = true) {
  const userId = `st067-user-${randomUUID()}`;
  const sessionId = `st067-session-${randomUUID()}`;
  const email = `${label}-${randomUUID()}@example.test`;
  userIds.push(userId);
  await db.insert(authUser).values({
    id: userId,
    name: label,
    email,
    emailVerified: true,
  });
  await db.insert(authSession).values({
    id: sessionId,
    token: `st067-token-${randomUUID()}`,
    userId,
    expiresAt: new Date("2026-10-13T12:00:00.000Z"),
  });
  if (credential) {
    await db.insert(authAccount).values({
      id: `st067-account-${randomUUID()}`,
      accountId: userId,
      providerId: "credential",
      userId,
      password: "synthetic-password-hash",
    });
  }
  return { userId, sessionId, email };
}

async function reverify(userId: string, sessionId: string, offsetMs = 0) {
  return await createPasswordReverificationGrant(
    userId,
    sessionId,
    new Date(TEST_NOW.getTime() + offsetMs),
  );
}

async function linkIdentity(
  fixture: { userId: string; sessionId: string },
  identity: VerifiedProviderIdentity,
  offsetMs = 0,
) {
  const reverified = await reverify(fixture.userId, fixture.sessionId, offsetMs);
  const intent = await createIdentityLinkIntent({
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    providerId: identity.providerId,
    reverificationToken: reverified.token,
    now: new Date(TEST_NOW.getTime() + offsetMs + 1_000),
  });
  const proofToken = issueVerifiedProviderIdentityProof(PROOF_SECRET, {
    actionId: intent.actionId,
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    identity,
  }, TEST_NOW.getTime() + offsetMs + 2_000);
  const proof = verifyProviderIdentityProof(
    PROOF_SECRET,
    proofToken,
    TEST_NOW.getTime() + offsetMs + 3_000,
  );
  if (!proof) throw new Error("synthetic provider proof did not verify");
  const result = await completeIdentityLink({
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    intentToken: intent.token,
    proof,
    now: new Date(TEST_NOW.getTime() + offsetMs + 3_000),
  });
  return { result, intent, proof };
}

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(accountIdentityAudit).where(inArray(accountIdentityAudit.userId, userIds));
    await db.delete(authUser).where(inArray(authUser.id, userIds));
  }
  await pool.end();
});

describe("account identity repository", () => {
  it("keeps audit records secret-free", async () => {
    const fixture = await seedUser("audit-safe");
    const providerSubject = `secret-subject-${randomUUID()}`;
    const providerEmail = `secret-provider-${randomUUID()}@example.test`;
    const linked = await linkIdentity(fixture, {
      providerId: "google",
      subject: providerSubject,
      email: providerEmail,
      emailVerified: true,
    });
    const rows = await db.select().from(accountIdentityAudit)
      .where(eq(accountIdentityAudit.userId, fixture.userId));
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(providerSubject);
    expect(serialized).not.toContain(providerEmail);
    expect(serialized).not.toContain(linked.intent.token);
    expect(serialized).not.toContain(linked.proof.nonce);
    expect(serialized).toContain("google");
    expect(serialized).toContain(linked.result.accountRecordId);
  });

  it("uses explicit provider proof rather than email equality and never rewrites the primary email", async () => {
    const fixture = await seedUser("email-proof");
    const variants: VerifiedProviderIdentity[] = [
      { providerId: "same-email", subject: randomUUID(), email: fixture.email, emailVerified: true },
      { providerId: "different-email", subject: randomUUID(), email: "different@example.test", emailVerified: true },
      { providerId: "apple-relay", subject: randomUUID(), email: "relay@privaterelay.appleid.com", emailVerified: true },
      { providerId: "missing-email", subject: randomUUID(), email: null, emailVerified: false },
      { providerId: "unverified-email", subject: randomUUID(), email: "unverified@example.test", emailVerified: false },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      await linkIdentity(fixture, variants[index]!, index * 20_000);
    }

    const [user] = await db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, fixture.userId));
    expect(user?.email).toBe(fixture.email);
    const rows = await db.select({
      providerId: accountIdentityOwnerships.providerId,
      providerEmail: accountIdentityOwnerships.providerEmail,
      providerEmailVerified: accountIdentityOwnerships.providerEmailVerified,
    }).from(accountIdentityOwnerships).where(eq(accountIdentityOwnerships.userId, fixture.userId));
    expect(rows).toHaveLength(variants.length);
    expect(rows.map((row) => row.providerId).sort()).toEqual(variants.map((entry) => entry.providerId).sort());
  });

  it("enforces provider+subject uniqueness on the Better Auth account table itself", async () => {
    const first = await seedUser("db-identity-first");
    const second = await seedUser("db-identity-second");
    const providerSubject = `shared-subject-${randomUUID()}`;
    await db.insert(authAccount).values({
      id: `st067-account-${randomUUID()}`,
      userId: first.userId,
      providerId: "google",
      accountId: providerSubject,
    });
    await expect(db.insert(authAccount).values({
      id: `st067-account-${randomUUID()}`,
      userId: second.userId,
      providerId: "google",
      accountId: providerSubject,
    })).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint: "account_provider_subject_unique",
      },
    });
  });

  it("reconciles a native provider insert that races explicit link completion", async () => {
    const linkingUser = await seedUser("native-race-linking");
    const nativeUser = await seedUser("native-race-owner");
    const identity = {
      providerId: "google",
      subject: `race-subject-${randomUUID()}`,
      email: linkingUser.email,
      emailVerified: true,
    } satisfies VerifiedProviderIdentity;
    const reverified = await reverify(linkingUser.userId, linkingUser.sessionId);
    const intent = await createIdentityLinkIntent({
      userId: linkingUser.userId,
      sessionId: linkingUser.sessionId,
      providerId: identity.providerId,
      reverificationToken: reverified.token,
      now: new Date(TEST_NOW.getTime() + 1_000),
    });
    const proofToken = issueVerifiedProviderIdentityProof(PROOF_SECRET, {
      actionId: intent.actionId,
      userId: linkingUser.userId,
      sessionId: linkingUser.sessionId,
      identity,
    }, TEST_NOW.getTime() + 2_000);
    const proof = verifyProviderIdentityProof(PROOF_SECRET, proofToken, TEST_NOW.getTime() + 3_000)!;

    const native = await pool.connect();
    const nativeAccountId = `st067-native-race-${randomUUID()}`;
    try {
      await native.query("begin");
      await native.query(
        `insert into account (id, account_id, provider_id, user_id, updated_at)
         values ($1, $2, $3, $4, now())`,
        [nativeAccountId, identity.subject, identity.providerId, nativeUser.userId],
      );

      const completion = completeIdentityLink({
        userId: linkingUser.userId,
        sessionId: linkingUser.sessionId,
        intentToken: intent.token,
        proof,
        now: new Date(TEST_NOW.getTime() + 3_000),
      });
      // The explicit linker has read the old snapshot and then blocks on the
      // database unique index while the native callback still owns its insert.
      await new Promise((resolve) => setTimeout(resolve, 75));
      await native.query("commit");

      await expect(completion).rejects.toMatchObject({ code: "IDENTITY_ALREADY_OWNED" });
      await expect(completeIdentityLink({
        userId: linkingUser.userId,
        sessionId: linkingUser.sessionId,
        intentToken: intent.token,
        proof,
        now: new Date(TEST_NOW.getTime() + 4_000),
      })).rejects.toMatchObject({ code: "IDENTITY_ACTION_REPLAYED" });

      const rows = await db.select({ id: authAccount.id, userId: authAccount.userId })
        .from(authAccount)
        .where(eq(authAccount.accountId, identity.subject));
      expect(rows).toEqual([{ id: nativeAccountId, userId: nativeUser.userId }]);
      const ownerships = await db.select({ id: accountIdentityOwnerships.id })
        .from(accountIdentityOwnerships)
        .where(eq(accountIdentityOwnerships.providerSubject, identity.subject));
      expect(ownerships).toEqual([]);
    } finally {
      try { await native.query("rollback"); } catch {}
      native.release();
    }
  });

  it("fails closed when provider+subject is already owned by another stable user", async () => {
    const first = await seedUser("collision-first");
    const second = await seedUser("collision-second");
    const identity = {
      providerId: "google",
      subject: `subject-${randomUUID()}`,
      email: first.email,
      emailVerified: true,
    } satisfies VerifiedProviderIdentity;
    await linkIdentity(first, identity);

    const reverified = await reverify(second.userId, second.sessionId);
    const intent = await createIdentityLinkIntent({
      userId: second.userId,
      sessionId: second.sessionId,
      providerId: identity.providerId,
      reverificationToken: reverified.token,
      now: new Date(TEST_NOW.getTime() + 1_000),
    });
    const proofToken = issueVerifiedProviderIdentityProof(PROOF_SECRET, {
      actionId: intent.actionId,
      userId: second.userId,
      sessionId: second.sessionId,
      identity: { ...identity, email: second.email },
    }, TEST_NOW.getTime() + 2_000);
    const proof = verifyProviderIdentityProof(PROOF_SECRET, proofToken, TEST_NOW.getTime() + 3_000)!;

    await expect(completeIdentityLink({
      userId: second.userId,
      sessionId: second.sessionId,
      intentToken: intent.token,
      proof,
      now: new Date(TEST_NOW.getTime() + 3_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ALREADY_OWNED" });
    await expect(completeIdentityLink({
      userId: second.userId,
      sessionId: second.sessionId,
      intentToken: intent.token,
      proof,
      now: new Date(TEST_NOW.getTime() + 4_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_REPLAYED" });

    const secondProviderRows = await db.select({ id: authAccount.id })
      .from(authAccount)
      .where(eq(authAccount.userId, second.userId));
    expect(secondProviderRows).toHaveLength(1);
  });

  it("makes successful link completion idempotent without reusing proof for another action", async () => {
    const fixture = await seedUser("link-idempotent");
    const linked = await linkIdentity(fixture, {
      providerId: "google",
      subject: `subject-${randomUUID()}`,
      email: fixture.email,
      emailVerified: true,
    });
    const retry = await completeIdentityLink({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      intentToken: linked.intent.token,
      proof: linked.proof,
      now: new Date(TEST_NOW.getTime() + 4_000),
    });
    expect(retry).toMatchObject({
      accountRecordId: linked.result.accountRecordId,
      linked: false,
      alreadyLinked: true,
    });

    const freshReverify = await reverify(fixture.userId, fixture.sessionId, 10_000);
    const anotherIntent = await createIdentityLinkIntent({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      providerId: "google",
      reverificationToken: freshReverify.token,
      now: new Date(TEST_NOW.getTime() + 11_000),
    });
    await expect(completeIdentityLink({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      intentToken: anotherIntent.token,
      proof: linked.proof,
      now: new Date(TEST_NOW.getTime() + 12_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_INVALID" });
  });

  it("binds link proof to the current session", async () => {
    const fixture = await seedUser("session-bound");
    const otherSessionId = `st067-session-${randomUUID()}`;
    await db.insert(authSession).values({
      id: otherSessionId,
      token: `st067-token-${randomUUID()}`,
      userId: fixture.userId,
      expiresAt: new Date("2026-10-13T12:00:00.000Z"),
    });
    const reverified = await reverify(fixture.userId, fixture.sessionId);
    const intent = await createIdentityLinkIntent({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      providerId: "google",
      reverificationToken: reverified.token,
      now: new Date(TEST_NOW.getTime() + 1_000),
    });
    const token = issueVerifiedProviderIdentityProof(PROOF_SECRET, {
      actionId: intent.actionId,
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      identity: {
        providerId: "google",
        subject: randomUUID(),
        email: fixture.email,
        emailVerified: true,
      },
    }, TEST_NOW.getTime() + 2_000);
    const proof = verifyProviderIdentityProof(PROOF_SECRET, token, TEST_NOW.getTime() + 3_000)!;
    await expect(completeIdentityLink({
      userId: fixture.userId,
      sessionId: otherSessionId,
      intentToken: intent.token,
      proof,
      now: new Date(TEST_NOW.getTime() + 3_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_SESSION_CHANGED" });
  });

  it("refreshes existing provider ownership from a fresh proof for the same subject", async () => {
    const fixture = await seedUser("ownership-refresh");
    const identity = {
      providerId: "google",
      subject: `subject-${randomUUID()}`,
      email: null,
      emailVerified: false,
    } satisfies VerifiedProviderIdentity;
    const initial = await linkIdentity(fixture, identity);
    expect((await listAccountIdentityMethods(fixture.userId, new Set(["google"])))
      .find((method) => method.id === initial.result.accountRecordId)).toMatchObject({
      verified: false,
      usable: false,
    });

    const verifiedEmail = `verified-${randomUUID()}@example.test`;
    const refreshed = await linkIdentity(fixture, {
      ...identity,
      email: verifiedEmail,
      emailVerified: true,
    }, 20_000);
    expect(refreshed.result.accountRecordId).toBe(initial.result.accountRecordId);

    const [ownership] = await db.select({
      providerEmail: accountIdentityOwnerships.providerEmail,
      providerEmailVerified: accountIdentityOwnerships.providerEmailVerified,
      verifiedAt: accountIdentityOwnerships.verifiedAt,
    }).from(accountIdentityOwnerships).where(eq(
      accountIdentityOwnerships.accountRecordId,
      initial.result.accountRecordId,
    ));
    expect(ownership).toMatchObject({
      providerEmail: verifiedEmail,
      providerEmailVerified: true,
    });
    expect(ownership!.verifiedAt.getTime()).toBe(TEST_NOW.getTime() + 23_000);
    expect((await listAccountIdentityMethods(fixture.userId, new Set(["google"])))
      .find((method) => method.id === initial.result.accountRecordId)).toMatchObject({
      verified: true,
      usable: true,
    });
  });

  it("does not count an unverified or unconfigured provider as a usable fallback", async () => {
    const fixture = await seedUser("usable-guard");
    const linked = await linkIdentity(fixture, {
      providerId: "google",
      subject: randomUUID(),
      email: fixture.email,
      emailVerified: false,
    });
    const methods = await listAccountIdentityMethods(fixture.userId, new Set(["google"]));
    expect(methods.find((method) => method.id === linked.result.accountRecordId)).toMatchObject({
      verified: false,
      usable: false,
    });
  });

  it("keeps the credential identity until provider-based reverification exists", async () => {
    const fixture = await seedUser("credential-reverify-anchor");
    await linkIdentity(fixture, {
      providerId: "google",
      subject: randomUUID(),
      email: fixture.email,
      emailVerified: true,
    });
    const credential = (await db.select({ id: authAccount.id })
      .from(authAccount)
      .where(eq(authAccount.userId, fixture.userId)))
      .find((row) => row.id.startsWith("st067-account-"))!;
    const grant = await reverify(fixture.userId, fixture.sessionId, 20_000);
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: credential.id,
      reverificationToken: grant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 21_000),
    })).rejects.toMatchObject({ code: "IDENTITY_CREDENTIAL_UNLINK_UNAVAILABLE" });
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: credential.id,
      reverificationToken: grant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 22_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_REPLAYED" });
    const methods = await listAccountIdentityMethods(fixture.userId, new Set(["google"]));
    expect(methods.find((method) => method.id === credential.id)).toMatchObject({
      type: "password",
      usable: true,
      canUnlink: false,
    });
  });

  it("refuses removal of the last usable provider method", async () => {
    const fixture = await seedUser("provider-last-usable", false);
    const linked = await linkIdentity(fixture, {
      providerId: "google",
      subject: randomUUID(),
      email: fixture.email,
      emailVerified: true,
    });
    const grant = await reverify(fixture.userId, fixture.sessionId, 20_000);
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 21_000),
    })).rejects.toMatchObject({ code: "IDENTITY_LAST_USABLE_LOGIN" });
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 22_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_REPLAYED" });
  });

  it("consumes re-verification when unlink target is missing", async () => {
    const fixture = await seedUser("missing-unlink");
    const grant = await reverify(fixture.userId, fixture.sessionId, 20_000);
    const missingAccountRecordId = randomUUID();
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: missingAccountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: new Set(),
      now: new Date(TEST_NOW.getTime() + 21_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACCOUNT_NOT_FOUND" });
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: missingAccountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: new Set(),
      now: new Date(TEST_NOW.getTime() + 22_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_REPLAYED" });
  });

  it("serializes concurrent unlinks so two requests cannot remove the last usable method", async () => {
    const fixture = await seedUser("concurrent-unlink", false);
    const first = await linkIdentity(fixture, {
      providerId: "google",
      subject: randomUUID(),
      email: "first@example.test",
      emailVerified: true,
    });
    const second = await linkIdentity(fixture, {
      providerId: "apple",
      subject: randomUUID(),
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
    }, 20_000);
    const firstGrant = await reverify(fixture.userId, fixture.sessionId, 40_000);
    const secondGrant = await reverify(fixture.userId, fixture.sessionId, 41_000);

    const results = await Promise.allSettled([
      unlinkAccountIdentity({
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        accountRecordId: first.result.accountRecordId,
        reverificationToken: firstGrant.token,
        usableProviderIds: new Set(["google", "apple"]),
        now: new Date(TEST_NOW.getTime() + 42_000),
      }),
      unlinkAccountIdentity({
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        accountRecordId: second.result.accountRecordId,
        reverificationToken: secondGrant.token,
        usableProviderIds: new Set(["google", "apple"]),
        now: new Date(TEST_NOW.getTime() + 42_000),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(AccountIdentityError);
    expect(rejected?.reason).toMatchObject({ code: "IDENTITY_LAST_USABLE_LOGIN" });
    const remaining = await listAccountIdentityMethods(fixture.userId, new Set(["google", "apple"]));
    expect(remaining.filter((method) => method.usable)).toHaveLength(1);
  });

  it("refuses an unlink that would leave only stale provider emails as the recovery channel", async () => {
    const fixture = await seedUser("stale-provider-recovery", false);
    const google = await linkIdentity(fixture, {
      providerId: "google",
      subject: randomUUID(),
      email: "first@example.test",
      emailVerified: true,
    });
    await linkIdentity(fixture, {
      providerId: "apple",
      subject: randomUUID(),
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
    }, 20_000);
    // #486: the Account's own address is no longer verified, so the remaining
    // Apple identity can sign in but offers no reachable recovery channel.
    await db.update(authUser).set({ emailVerified: false }).where(eq(authUser.id, fixture.userId));
    const configured = new Set(["google", "apple"]);
    const before = await listAccountIdentityMethods(fixture.userId, configured);
    expect(before.map((method) => [method.usable, method.canUnlink])).toEqual([[true, false], [true, false]]);

    const grant = await reverify(fixture.userId, fixture.sessionId, 40_000);
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: google.result.accountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: configured,
      now: new Date(TEST_NOW.getTime() + 41_000),
    })).rejects.toMatchObject({ code: "IDENTITY_LAST_USABLE_LOGIN" });
    const after = await listAccountIdentityMethods(fixture.userId, configured);
    expect(after).toHaveLength(2);
  });

  it("makes a successful unlink retry idempotent and preserves the current session", async () => {
    const fixture = await seedUser("unlink-idempotent");
    const linked = await linkIdentity(fixture, {
      providerId: "google",
      subject: randomUUID(),
      email: fixture.email,
      emailVerified: true,
    });
    const grant = await reverify(fixture.userId, fixture.sessionId, 20_000);
    const first = await unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 21_000),
    });
    expect(first).toEqual({ unlinked: true, alreadyUnlinked: false });
    const retry = await unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: grant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 22_000),
    });
    expect(retry).toEqual({ unlinked: false, alreadyUnlinked: true });

    const unrelatedGrant = await reverify(fixture.userId, fixture.sessionId, 23_000);
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: unrelatedGrant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 24_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACCOUNT_NOT_FOUND" });
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: unrelatedGrant.token,
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 25_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_REPLAYED" });
    await expect(unlinkAccountIdentity({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      accountRecordId: linked.result.accountRecordId,
      reverificationToken: "not-a-real-reverification-token",
      usableProviderIds: new Set(["google"]),
      now: new Date(TEST_NOW.getTime() + 26_000),
    })).rejects.toMatchObject({ code: "IDENTITY_ACTION_INVALID" });

    const [session] = await db.select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.id, fixture.sessionId));
    expect(session?.id).toBe(fixture.sessionId);
  });
});
