import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACCOUNT_EMAIL_CHANGE_TTL_MS,
  AccountEmailChangeError,
  cancelAccountEmailChange,
  confirmAccountEmailChangeOldAddress,
  startAccountEmailChange,
  verifyAccountEmailChangeNewAddress,
} from "../account-identities/email-change-repository";
import { createPasswordReverificationGrant } from "../account-identities/account-identity-repository";
import {
  accountEmailChangeAudit,
  accountEmailChanges,
  accountIdentityAudit,
  atlases,
} from "../db/app-schema";
import {
  account as authAccount,
  member as authMember,
  organization as authOrganization,
  session as authSession,
  user as authUser,
  verification as authVerification,
} from "../db/auth-schema";
import { db, pool } from "../db/client";

const TEST_NOW = new Date("2026-09-18T09:30:00.000Z");
const userIds: string[] = [];
const organizationIds: string[] = [];

async function seedUser(label: string, sessionCount = 1) {
  const userId = "st089-user-" + randomUUID();
  const email = label + "-" + randomUUID() + "@example.test";
  const organizationId = "st089-org-" + randomUUID();
  const accountId = "st089-account-" + randomUUID();
  const atlasId = randomUUID();
  const sessionIds = Array.from(
    { length: sessionCount },
    () => "st089-session-" + randomUUID(),
  );
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
    password: "synthetic-password-hash",
  });
  await db.insert(authSession).values(sessionIds.map((id, index) => ({
    id,
    token: "st089-token-" + randomUUID(),
    userId,
    expiresAt: new Date(TEST_NOW.getTime() + 86_400_000 + index),
  })));
  await db.insert(authOrganization).values({
    id: organizationId,
    name: label + " Atlas",
    slug: "st089-" + randomUUID(),
    createdAt: TEST_NOW,
  });
  await db.insert(authMember).values({
    id: "st089-member-" + randomUUID(),
    organizationId,
    userId,
    role: "owner",
    createdAt: TEST_NOW,
  });
  await db.insert(atlases).values({
    id: atlasId,
    organizationId,
    title: label + " Atlas",
    dedication: "",
  });
  return {
    userId,
    email,
    organizationId,
    accountId,
    atlasId,
    sessionIds,
  };
}

async function grant(
  userId: string,
  sessionId: string,
  offsetMs = 0,
) {
  return await createPasswordReverificationGrant(
    userId,
    sessionId,
    new Date(TEST_NOW.getTime() + offsetMs),
  );
}

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(accountEmailChangeAudit)
      .where(inArray(accountEmailChangeAudit.userId, userIds));
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

describe("account email-change transaction", () => {
  it("changes only the email after both address proofs and preserves stable ownership", async () => {
    const fixture = await seedUser("normal", 2);
    const reverify = await grant(
      fixture.userId,
      fixture.sessionIds[0]!,
    );
    await db.insert(authVerification).values({
      id: "st089-reset-" + randomUUID(),
      identifier: "reset-password:stale-token-" + randomUUID(),
      value: fixture.userId,
      expiresAt: new Date(TEST_NOW.getTime() + 86_400_000),
    });
    const proposedEmail =
      ("NEXT-" + randomUUID() + "@EXAMPLE.TEST").toUpperCase();

    const started = await startAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      proposedEmail,
      reverificationToken: reverify.token,
      now: new Date(TEST_NOW.getTime() + 1_000),
    });
    expect(started.change.status).toBe("pending");
    expect(started.change.proposedEmail).toBe(proposedEmail.toLowerCase());

    const [before] = await db.select({
      id: authUser.id,
      email: authUser.email,
    }).from(authUser).where(eq(authUser.id, fixture.userId));
    expect(before).toEqual({
      id: fixture.userId,
      email: fixture.email,
    });

    const [stored] = await db.select()
      .from(accountEmailChanges)
      .where(eq(accountEmailChanges.id, started.change.id));
    const serializedStored = JSON.stringify(stored);
    expect(serializedStored).not.toContain(started.oldProofToken);
    expect(serializedStored).not.toContain(started.newProofToken);

    const newFirst = await verifyAccountEmailChangeNewAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      token: started.newProofToken,
      now: new Date(TEST_NOW.getTime() + 2_000),
    });
    expect(newFirst.completed).toBe(false);

    const completed = await confirmAccountEmailChangeOldAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      token: started.oldProofToken,
      now: new Date(TEST_NOW.getTime() + 3_000),
    });
    expect(completed.completed).toBe(true);
    expect(completed.change.status).toBe("completed");

    const [userAfter] = await db.select()
      .from(authUser)
      .where(eq(authUser.id, fixture.userId));
    expect(userAfter?.id).toBe(fixture.userId);
    expect(userAfter?.email).toBe(proposedEmail.toLowerCase());
    expect(userAfter?.emailVerified).toBe(true);

    expect(await db.select().from(authSession)
      .where(eq(authSession.userId, fixture.userId))).toHaveLength(0);
    expect(await db.select().from(authVerification)
      .where(eq(authVerification.value, fixture.userId))).toHaveLength(0);
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

    const audits = await db.select().from(accountEmailChangeAudit)
      .where(eq(accountEmailChangeAudit.userId, fixture.userId));
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain(fixture.email);
    expect(serializedAudit).not.toContain(proposedEmail.toLowerCase());
    expect(serializedAudit).not.toContain(started.oldProofToken);
    expect(serializedAudit).not.toContain(started.newProofToken);

    await expect(verifyAccountEmailChangeNewAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      token: started.newProofToken,
      now: new Date(TEST_NOW.getTime() + 4_000),
    })).rejects.toMatchObject({
      code: "EMAIL_CHANGE_PROOF_REPLAYED",
    });
  });

  it("consumes recent proof when the proposed email belongs to another account", async () => {
    const owner = await seedUser("conflict-owner");
    const occupied = await seedUser("conflict-target");
    const reverify = await grant(owner.userId, owner.sessionIds[0]!);

    await expect(startAccountEmailChange({
      userId: owner.userId,
      sessionId: owner.sessionIds[0]!,
      proposedEmail: occupied.email.toUpperCase(),
      reverificationToken: reverify.token,
      now: new Date(TEST_NOW.getTime() + 10_000),
    })).rejects.toMatchObject({
      code: "EMAIL_CHANGE_EMAIL_UNAVAILABLE",
    });

    await expect(startAccountEmailChange({
      userId: owner.userId,
      sessionId: owner.sessionIds[0]!,
      proposedEmail: "unused-" + randomUUID() + "@example.test",
      reverificationToken: reverify.token,
      now: new Date(TEST_NOW.getTime() + 11_000),
    })).rejects.toMatchObject({
      code: "EMAIL_CHANGE_REVERIFY_REPLAYED",
    });

    const [unchanged] = await db.select({ email: authUser.email })
      .from(authUser)
      .where(eq(authUser.id, owner.userId));
    expect(unchanged?.email).toBe(owner.email);
  });

  it("allows only one concurrent claimant for the same normalized new email", async () => {
    const first = await seedUser("race-first");
    const second = await seedUser("race-second");
    const firstGrant = await grant(
      first.userId,
      first.sessionIds[0]!,
      20_000,
    );
    const secondGrant = await grant(
      second.userId,
      second.sessionIds[0]!,
      20_001,
    );
    const proposedEmail =
      "shared-" + randomUUID() + "@example.test";

    const outcomes = await Promise.allSettled([
      startAccountEmailChange({
        userId: first.userId,
        sessionId: first.sessionIds[0]!,
        proposedEmail,
        reverificationToken: firstGrant.token,
        now: new Date(TEST_NOW.getTime() + 21_000),
      }),
      startAccountEmailChange({
        userId: second.userId,
        sessionId: second.sessionIds[0]!,
        proposedEmail: proposedEmail.toUpperCase(),
        reverificationToken: secondGrant.token,
        now: new Date(TEST_NOW.getTime() + 21_000),
      }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((item) => item.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason)
      .toMatchObject({ code: "EMAIL_CHANGE_EMAIL_UNAVAILABLE" });

    const pending = await db.select().from(accountEmailChanges)
      .where(eq(accountEmailChanges.proposedEmail, proposedEmail));
    expect(pending.filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("makes replacement, session switching, cancel and expiry deterministic", async () => {
    const fixture = await seedUser("lifecycle", 2);
    const firstGrant = await grant(
      fixture.userId,
      fixture.sessionIds[0]!,
      30_000,
    );
    const first = await startAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      proposedEmail: "first-" + randomUUID() + "@example.test",
      reverificationToken: firstGrant.token,
      now: new Date(TEST_NOW.getTime() + 31_000),
    });
    const secondGrant = await grant(
      fixture.userId,
      fixture.sessionIds[0]!,
      32_000,
    );
    const second = await startAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      proposedEmail: "second-" + randomUUID() + "@example.test",
      reverificationToken: secondGrant.token,
      now: new Date(TEST_NOW.getTime() + 33_000),
    });

    // Delivery compensation for the older request must target that exact row.
    // Once a newer start replaced it, the compensation is a no-op and cannot
    // cancel the newer transaction that already delivered its own proofs.
    const obsoleteCompensation = await cancelAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      changeId: first.change.id,
      now: new Date(TEST_NOW.getTime() + 33_500),
    });
    expect(obsoleteCompensation).toBeNull();
    expect(await db.select({
      id: accountEmailChanges.id,
      status: accountEmailChanges.status,
    }).from(accountEmailChanges).where(eq(
      accountEmailChanges.id,
      second.change.id,
    ))).toEqual([{
      id: second.change.id,
      status: "pending",
    }]);

    await expect(confirmAccountEmailChangeOldAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      token: first.oldProofToken,
      now: new Date(TEST_NOW.getTime() + 34_000),
    })).rejects.toMatchObject({ code: "EMAIL_CHANGE_REPLACED" });

    await expect(verifyAccountEmailChangeNewAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[1]!,
      token: second.newProofToken,
      now: new Date(TEST_NOW.getTime() + 35_000),
    })).rejects.toMatchObject({ code: "EMAIL_CHANGE_SESSION_CHANGED" });

    await expect(cancelAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[1]!,
      now: new Date(TEST_NOW.getTime() + 36_000),
    })).rejects.toMatchObject({ code: "EMAIL_CHANGE_SESSION_CHANGED" });

    const cancelled = await cancelAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      now: new Date(TEST_NOW.getTime() + 37_000),
    });
    expect(cancelled?.status).toBe("cancelled");
    await expect(verifyAccountEmailChangeNewAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      token: second.newProofToken,
      now: new Date(TEST_NOW.getTime() + 38_000),
    })).rejects.toMatchObject({ code: "EMAIL_CHANGE_CANCELLED" });

    const expiryGrant = await grant(
      fixture.userId,
      fixture.sessionIds[0]!,
      40_000,
    );
    const expiring = await startAccountEmailChange({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      proposedEmail: "expiry-" + randomUUID() + "@example.test",
      reverificationToken: expiryGrant.token,
      now: new Date(TEST_NOW.getTime() + 41_000),
    });
    await expect(confirmAccountEmailChangeOldAddress({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      token: expiring.oldProofToken,
      now: new Date(
        TEST_NOW.getTime() + 41_000 + ACCOUNT_EMAIL_CHANGE_TTL_MS + 1,
      ),
    })).rejects.toMatchObject({ code: "EMAIL_CHANGE_EXPIRED" });

    const [unchanged] = await db.select({ email: authUser.email })
      .from(authUser)
      .where(eq(authUser.id, fixture.userId));
    expect(unchanged?.email).toBe(fixture.email);
  });
});
