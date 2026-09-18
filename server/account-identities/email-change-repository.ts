import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
import {
  accountEmailChangeAudit,
  accountEmailChanges,
} from "../db/app-schema";
import {
  AccountIdentityError,
  consumePasswordReverificationAction,
} from "./account-identity-repository";
import {
  session as authSession,
  user as authUser,
  verification as authVerification,
} from "../db/auth-schema";
import { db } from "../db/client";

export const ACCOUNT_EMAIL_CHANGE_TTL_MS = 30 * 60 * 1000;

export type AccountEmailChangeStatus =
  | "pending"
  | "completed"
  | "cancelled"
  | "replaced"
  | "expired"
  | "conflicted";

export type AccountEmailChangeErrorCode =
  | "EMAIL_CHANGE_INVALID"
  | "EMAIL_CHANGE_ACCOUNT_NOT_FOUND"
  | "EMAIL_CHANGE_CURRENT_EMAIL_UNVERIFIED"
  | "EMAIL_CHANGE_SAME_EMAIL"
  | "EMAIL_CHANGE_EMAIL_UNAVAILABLE"
  | "EMAIL_CHANGE_REVERIFY_INVALID"
  | "EMAIL_CHANGE_REVERIFY_EXPIRED"
  | "EMAIL_CHANGE_REVERIFY_REPLAYED"
  | "EMAIL_CHANGE_SESSION_CHANGED"
  | "EMAIL_CHANGE_PROOF_INVALID"
  | "EMAIL_CHANGE_PROOF_REPLAYED"
  | "EMAIL_CHANGE_EXPIRED"
  | "EMAIL_CHANGE_REPLACED"
  | "EMAIL_CHANGE_CANCELLED"
  | "EMAIL_CHANGE_ACCOUNT_CHANGED";

export class AccountEmailChangeError extends Error {
  constructor(readonly code: AccountEmailChangeErrorCode) {
    super(code);
    this.name = "AccountEmailChangeError";
  }
}

export type AccountEmailChangeView = {
  id: string;
  currentEmail: string;
  proposedEmail: string;
  status: AccountEmailChangeStatus;
  oldConfirmedAt: string | null;
  newVerifiedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ChangeRow = typeof accountEmailChanges.$inferSelect;

type AuditEvent =
  | "start"
  | "old-confirm"
  | "new-verify"
  | "complete"
  | "cancel"
  | "replace"
  | "expire";

function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function validBearerSecret(value: string): boolean {
  return value.length >= 32 && value.length <= 512;
}

export function normalizeAccountEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3
    || email.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AccountEmailChangeError("EMAIL_CHANGE_INVALID");
  }
  return email;
}

function asView(row: ChangeRow, now = new Date()): AccountEmailChangeView {
  const derivedStatus: AccountEmailChangeStatus =
    row.status === "pending" && row.expiresAt.getTime() <= now.getTime()
      ? "expired"
      : row.status as AccountEmailChangeStatus;
  return {
    id: row.id,
    currentEmail: row.currentEmail,
    proposedEmail: row.proposedEmail,
    status: derivedStatus,
    oldConfirmedAt: row.oldConfirmedAt?.toISOString() ?? null,
    newVerifiedAt: row.newVerifiedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function audit(
  transaction: Transaction,
  values: {
    userId: string;
    changeId?: string | null;
    actionId?: string | null;
    event: AuditEvent;
    outcome: "success" | "refused";
    reason?: string | null;
  },
) {
  await transaction.insert(accountEmailChangeAudit).values({
    userId: values.userId,
    changeId: values.changeId ?? null,
    actionId: values.actionId ?? null,
    event: values.event,
    outcome: values.outcome,
    reason: values.reason ?? null,
  });
}

async function lockUser(transaction: Transaction, userId: string) {
  const [user] = await transaction
    .select({
      id: authUser.id,
      email: authUser.email,
      emailVerified: authUser.emailVerified,
    })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .for("update")
    .limit(1);
  if (!user) {
    throw new AccountEmailChangeError("EMAIL_CHANGE_ACCOUNT_NOT_FOUND");
  }
  return user;
}

async function lockEmailAddress(transaction: Transaction, email: string) {
  const lockKey = `startrips:account-email-change:${email}`;
  await transaction.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `);
}

async function consumeReverification(
  transaction: Transaction,
  values: {
    userId: string;
    sessionId: string;
    token: string;
    now: Date;
  },
) {
  try {
    return await consumePasswordReverificationAction(transaction, values);
  } catch (error) {
    if (!(error instanceof AccountIdentityError)) throw error;
    switch (error.code) {
      case "IDENTITY_ACTION_EXPIRED":
        throw new AccountEmailChangeError("EMAIL_CHANGE_REVERIFY_EXPIRED");
      case "IDENTITY_ACTION_REPLAYED":
        throw new AccountEmailChangeError("EMAIL_CHANGE_REVERIFY_REPLAYED");
      case "IDENTITY_ACTION_SESSION_CHANGED":
        throw new AccountEmailChangeError("EMAIL_CHANGE_SESSION_CHANGED");
      default:
        throw new AccountEmailChangeError("EMAIL_CHANGE_REVERIFY_INVALID");
    }
  }
}

async function expirePendingForAddress(
  transaction: Transaction,
  proposedEmail: string,
  now: Date,
) {
  const expired = await transaction
    .update(accountEmailChanges)
    .set({ status: "expired", closedAt: now, updatedAt: now })
    .where(and(
      eq(accountEmailChanges.proposedEmail, proposedEmail),
      eq(accountEmailChanges.status, "pending"),
      lte(accountEmailChanges.expiresAt, now),
    ))
    .returning({
      id: accountEmailChanges.id,
      userId: accountEmailChanges.userId,
    });
  for (const row of expired) {
    await audit(transaction, {
      userId: row.userId,
      changeId: row.id,
      event: "expire",
      outcome: "success",
    });
  }
}

async function replacePendingForUser(
  transaction: Transaction,
  userId: string,
  now: Date,
) {
  const expired = await transaction
    .update(accountEmailChanges)
    .set({ status: "expired", closedAt: now, updatedAt: now })
    .where(and(
      eq(accountEmailChanges.userId, userId),
      eq(accountEmailChanges.status, "pending"),
      lte(accountEmailChanges.expiresAt, now),
    ))
    .returning({ id: accountEmailChanges.id });
  for (const row of expired) {
    await audit(transaction, {
      userId,
      changeId: row.id,
      event: "expire",
      outcome: "success",
    });
  }

  const replaced = await transaction
    .update(accountEmailChanges)
    .set({ status: "replaced", closedAt: now, updatedAt: now })
    .where(and(
      eq(accountEmailChanges.userId, userId),
      eq(accountEmailChanges.status, "pending"),
    ))
    .returning({ id: accountEmailChanges.id });
  for (const row of replaced) {
    await audit(transaction, {
      userId,
      changeId: row.id,
      event: "replace",
      outcome: "success",
    });
  }
}

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object"
      && current !== null
      && "code" in current
      && (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current = (
      typeof current === "object"
      && current !== null
      && "cause" in current
    ) ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export async function startAccountEmailChange(values: {
  userId: string;
  sessionId: string;
  proposedEmail: string;
  reverificationToken: string;
  now?: Date;
}) {
  const now = values.now ?? new Date();
  const proposedEmail = normalizeAccountEmail(values.proposedEmail);
  const oldProofToken = newSecret();
  const newProofToken = newSecret();
  const expiresAt = new Date(now.getTime() + ACCOUNT_EMAIL_CHANGE_TTL_MS);

  try {
    const outcome = await db.transaction(async (transaction) => {
      const user = await lockUser(transaction, values.userId);
      const currentEmail = user.email;
      const normalizedCurrentEmail = normalizeAccountEmail(user.email);
      const action = await consumeReverification(transaction, {
        userId: values.userId,
        sessionId: values.sessionId,
        token: values.reverificationToken,
        now,
      });
      if (!user.emailVerified) {
        await audit(transaction, {
          userId: values.userId,
          actionId: action.id,
          event: "start",
          outcome: "refused",
          reason: "EMAIL_CHANGE_CURRENT_EMAIL_UNVERIFIED",
        });
        return { refusal: "EMAIL_CHANGE_CURRENT_EMAIL_UNVERIFIED" as const };
      }
      if (normalizedCurrentEmail === proposedEmail) {
        await audit(transaction, {
          userId: values.userId,
          actionId: action.id,
          event: "start",
          outcome: "refused",
          reason: "EMAIL_CHANGE_SAME_EMAIL",
        });
        return { refusal: "EMAIL_CHANGE_SAME_EMAIL" as const };
      }

      await lockEmailAddress(transaction, proposedEmail);
      await expirePendingForAddress(transaction, proposedEmail, now);

      const [existingUser] = await transaction
        .select({ id: authUser.id })
        .from(authUser)
        .where(and(
          sql`lower(${authUser.email}) = ${proposedEmail}`,
          ne(authUser.id, values.userId),
        ))
        .limit(1);
      const [otherPending] = await transaction
        .select({ id: accountEmailChanges.id })
        .from(accountEmailChanges)
        .where(and(
          eq(accountEmailChanges.proposedEmail, proposedEmail),
          eq(accountEmailChanges.status, "pending"),
          ne(accountEmailChanges.userId, values.userId),
        ))
        .limit(1);

      if (existingUser || otherPending) {
        await audit(transaction, {
          userId: values.userId,
          actionId: action.id,
          event: "start",
          outcome: "refused",
          reason: "EMAIL_CHANGE_EMAIL_UNAVAILABLE",
        });
        return { refusal: "EMAIL_CHANGE_EMAIL_UNAVAILABLE" as const };
      }

      await replacePendingForUser(transaction, values.userId, now);
      const [created] = await transaction
        .insert(accountEmailChanges)
        .values({
          userId: values.userId,
          initiatingSessionId: values.sessionId,
          currentEmail,
          proposedEmail,
          reverificationActionId: action.id,
          oldProofHash: secretHash(oldProofToken),
          newProofHash: secretHash(newProofToken),
          expiresAt,
          updatedAt: now,
        })
        .returning();
      if (!created) {
        throw new Error("email change insert returned no row");
      }
      await audit(transaction, {
        userId: values.userId,
        changeId: created.id,
        actionId: action.id,
        event: "start",
        outcome: "success",
      });
      return { result: created };
    });

    if ("refusal" in outcome && outcome.refusal) {
      throw new AccountEmailChangeError(outcome.refusal);
    }
    return {
      change: asView(outcome.result, now),
      oldProofToken,
      newProofToken,
    };
  } catch (error) {
    if (error instanceof AccountEmailChangeError) throw error;
    if (uniqueViolation(error)) {
      throw new AccountEmailChangeError("EMAIL_CHANGE_EMAIL_UNAVAILABLE");
    }
    throw error;
  }
}

async function closeAsConflict(
  transaction: Transaction,
  row: ChangeRow,
  now: Date,
  reason: AccountEmailChangeErrorCode,
) {
  await transaction
    .update(accountEmailChanges)
    .set({ status: "conflicted", closedAt: now, updatedAt: now })
    .where(eq(accountEmailChanges.id, row.id));
  await audit(transaction, {
    userId: row.userId,
    changeId: row.id,
    actionId: row.reverificationActionId,
    event: "complete",
    outcome: "refused",
    reason,
  });
  return { refusal: reason };
}

async function closePendingAfterUniqueConflict(values: {
  userId: string;
  sessionId: string;
  hash: string;
  proof: "old" | "new";
  now: Date;
}) {
  await db.transaction(async (transaction) => {
    const filter = values.proof === "old"
      ? eq(accountEmailChanges.oldProofHash, values.hash)
      : eq(accountEmailChanges.newProofHash, values.hash);
    const [candidate] = await transaction
      .select({
        userId: accountEmailChanges.userId,
        initiatingSessionId: accountEmailChanges.initiatingSessionId,
      })
      .from(accountEmailChanges)
      .where(filter)
      .limit(1);
    if (
      !candidate
      || candidate.userId !== values.userId
      || candidate.initiatingSessionId !== values.sessionId
    ) {
      return;
    }
    await lockUser(transaction, values.userId);
    const [row] = await transaction
      .select()
      .from(accountEmailChanges)
      .where(filter)
      .for("update")
      .limit(1);
    if (!row || row.status !== "pending") return;
    await closeAsConflict(
      transaction,
      row,
      values.now,
      "EMAIL_CHANGE_EMAIL_UNAVAILABLE",
    );
  });
}

async function completeIfReady(
  transaction: Transaction,
  row: ChangeRow,
  now: Date,
) {
  if (!row.oldConfirmedAt || !row.newVerifiedAt) {
    return { result: row, completed: false as const };
  }

  await lockEmailAddress(transaction, row.proposedEmail);
  const user = await lockUser(transaction, row.userId);
  if (user.email !== row.currentEmail) {
    return await closeAsConflict(
      transaction,
      row,
      now,
      "EMAIL_CHANGE_ACCOUNT_CHANGED",
    );
  }

  const [conflict] = await transaction
    .select({ id: authUser.id })
    .from(authUser)
    .where(and(
      sql`lower(${authUser.email}) = ${row.proposedEmail}`,
      ne(authUser.id, row.userId),
    ))
    .limit(1);
  if (conflict) {
    return await closeAsConflict(
      transaction,
      row,
      now,
      "EMAIL_CHANGE_EMAIL_UNAVAILABLE",
    );
  }

  const [updatedUser] = await transaction
    .update(authUser)
    .set({
      email: row.proposedEmail,
      emailVerified: true,
      updatedAt: now,
    })
    .where(and(
      eq(authUser.id, row.userId),
      eq(authUser.email, row.currentEmail),
    ))
    .returning({ id: authUser.id });
  if (!updatedUser) {
    return await closeAsConflict(
      transaction,
      row,
      now,
      "EMAIL_CHANGE_ACCOUNT_CHANGED",
    );
  }

  const [completed] = await transaction
    .update(accountEmailChanges)
    .set({ status: "completed", closedAt: now, updatedAt: now })
    .where(and(
      eq(accountEmailChanges.id, row.id),
      eq(accountEmailChanges.status, "pending"),
    ))
    .returning();
  if (!completed) {
    throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_REPLAYED");
  }

  await audit(transaction, {
    userId: row.userId,
    changeId: row.id,
    actionId: row.reverificationActionId,
    event: "complete",
    outcome: "success",
  });

  // Successful rebind revokes every pre-change session and every outstanding
  // Better Auth capability whose value is this stable user id (notably
  // password-reset/delete-account links issued to the old address). Provider
  // account rows, memberships and product data remain keyed by the stable id.
  await transaction
    .delete(authVerification)
    .where(eq(authVerification.value, row.userId));
  await transaction
    .delete(authSession)
    .where(eq(authSession.userId, row.userId));

  return { result: completed, completed: true as const };
}

async function applyAddressProof(values: {
  userId: string;
  sessionId: string;
  token: string;
  proof: "old" | "new";
  now?: Date;
}) {
  if (!validBearerSecret(values.token)) {
    throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_INVALID");
  }
  const now = values.now ?? new Date();
  const hash = secretHash(values.token);

  try {
    const outcome = await db.transaction(async (transaction) => {
      const filter = values.proof === "old"
        ? eq(accountEmailChanges.oldProofHash, hash)
        : eq(accountEmailChanges.newProofHash, hash);
      const [candidate] = await transaction
        .select({
          userId: accountEmailChanges.userId,
          initiatingSessionId: accountEmailChanges.initiatingSessionId,
        })
        .from(accountEmailChanges)
        .where(filter)
        .limit(1);
      if (!candidate) {
        throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_INVALID");
      }
      if (
        candidate.userId !== values.userId
        || candidate.initiatingSessionId !== values.sessionId
      ) {
        throw new AccountEmailChangeError("EMAIL_CHANGE_SESSION_CHANGED");
      }

      // Keep the same lock order as start/replacement: stable user first, then
      // the pending transaction row. This prevents completion racing a fresh
      // start from deadlocking user-row and change-row locks in opposite order.
      await lockUser(transaction, values.userId);
      const [change] = await transaction
        .select()
        .from(accountEmailChanges)
        .where(filter)
        .for("update")
        .limit(1);
      if (!change) {
        throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_INVALID");
      }
      if (change.status === "replaced") {
        throw new AccountEmailChangeError("EMAIL_CHANGE_REPLACED");
      }
      if (change.status === "expired") {
        throw new AccountEmailChangeError("EMAIL_CHANGE_EXPIRED");
      }
      if (change.status === "cancelled") {
        throw new AccountEmailChangeError("EMAIL_CHANGE_CANCELLED");
      }
      if (change.status !== "pending") {
        throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_REPLAYED");
      }
      if (change.expiresAt.getTime() <= now.getTime()) {
        const [expired] = await transaction
          .update(accountEmailChanges)
          .set({ status: "expired", closedAt: now, updatedAt: now })
          .where(eq(accountEmailChanges.id, change.id))
          .returning();
        await audit(transaction, {
          userId: change.userId,
          changeId: change.id,
          actionId: change.reverificationActionId,
          event: "expire",
          outcome: "success",
        });
        return {
          refusal: "EMAIL_CHANGE_EXPIRED" as const,
          result: expired ?? change,
        };
      }

      if (
        (values.proof === "old" && change.oldConfirmedAt)
        || (values.proof === "new" && change.newVerifiedAt)
      ) {
        throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_REPLAYED");
      }

      const patch = values.proof === "old"
        ? { oldConfirmedAt: now, updatedAt: now }
        : { newVerifiedAt: now, updatedAt: now };
      const [proved] = await transaction
        .update(accountEmailChanges)
        .set(patch)
        .where(and(
          eq(accountEmailChanges.id, change.id),
          eq(accountEmailChanges.status, "pending"),
        ))
        .returning();
      if (!proved) {
        throw new AccountEmailChangeError("EMAIL_CHANGE_PROOF_REPLAYED");
      }

      await audit(transaction, {
        userId: change.userId,
        changeId: change.id,
        actionId: change.reverificationActionId,
        event: values.proof === "old" ? "old-confirm" : "new-verify",
        outcome: "success",
      });

      return await completeIfReady(transaction, proved, now);
    });

    if ("refusal" in outcome && outcome.refusal) {
      throw new AccountEmailChangeError(outcome.refusal);
    }
    return {
      change: asView(outcome.result, now),
      completed: outcome.completed,
      notification: outcome.completed
        ? {
          oldEmail: outcome.result.currentEmail,
          newEmail: outcome.result.proposedEmail,
        }
        : null,
    };
  } catch (error) {
    if (error instanceof AccountEmailChangeError) throw error;
    if (uniqueViolation(error)) {
      // A concurrent account registration can win the auth user.email unique
      // constraint after our preflight lookup. The failed transaction rolls
      // back the proof timestamp, so close the still-pending row in a fresh,
      // lock-ordered transaction before returning the conflict.
      await closePendingAfterUniqueConflict({
        userId: values.userId,
        sessionId: values.sessionId,
        hash,
        proof: values.proof,
        now,
      });
      throw new AccountEmailChangeError("EMAIL_CHANGE_EMAIL_UNAVAILABLE");
    }
    throw error;
  }
}

export async function confirmAccountEmailChangeOldAddress(values: {
  userId: string;
  sessionId: string;
  token: string;
  now?: Date;
}) {
  return await applyAddressProof({ ...values, proof: "old" });
}

export async function verifyAccountEmailChangeNewAddress(values: {
  userId: string;
  sessionId: string;
  token: string;
  now?: Date;
}) {
  return await applyAddressProof({ ...values, proof: "new" });
}

export async function cancelAccountEmailChange(values: {
  userId: string;
  sessionId: string;
  now?: Date;
}) {
  const now = values.now ?? new Date();
  const outcome = await db.transaction(async (transaction) => {
    const [change] = await transaction
      .select()
      .from(accountEmailChanges)
      .where(and(
        eq(accountEmailChanges.userId, values.userId),
        eq(accountEmailChanges.status, "pending"),
      ))
      .orderBy(desc(accountEmailChanges.createdAt))
      .for("update")
      .limit(1);
    if (!change) return { result: null };
    if (change.initiatingSessionId !== values.sessionId) {
      throw new AccountEmailChangeError("EMAIL_CHANGE_SESSION_CHANGED");
    }
    if (change.expiresAt.getTime() <= now.getTime()) {
      const [expired] = await transaction
        .update(accountEmailChanges)
        .set({ status: "expired", closedAt: now, updatedAt: now })
        .where(eq(accountEmailChanges.id, change.id))
        .returning();
      await audit(transaction, {
        userId: values.userId,
        changeId: change.id,
        actionId: change.reverificationActionId,
        event: "expire",
        outcome: "success",
      });
      return { result: expired ?? change };
    }
    const [cancelled] = await transaction
      .update(accountEmailChanges)
      .set({ status: "cancelled", closedAt: now, updatedAt: now })
      .where(eq(accountEmailChanges.id, change.id))
      .returning();
    await audit(transaction, {
      userId: values.userId,
      changeId: change.id,
      actionId: change.reverificationActionId,
      event: "cancel",
      outcome: "success",
    });
    return { result: cancelled ?? change };
  });
  return outcome.result ? asView(outcome.result, now) : null;
}

export async function getAccountEmailChangeStatus(
  userId: string,
  now = new Date(),
): Promise<AccountEmailChangeView | null> {
  const outcome = await db.transaction(async (transaction) => {
    const [change] = await transaction
      .select()
      .from(accountEmailChanges)
      .where(eq(accountEmailChanges.userId, userId))
      .orderBy(desc(accountEmailChanges.createdAt))
      .for("update")
      .limit(1);
    if (!change) return null;
    if (
      change.status === "pending"
      && change.expiresAt.getTime() <= now.getTime()
    ) {
      const [expired] = await transaction
        .update(accountEmailChanges)
        .set({ status: "expired", closedAt: now, updatedAt: now })
        .where(eq(accountEmailChanges.id, change.id))
        .returning();
      await audit(transaction, {
        userId,
        changeId: change.id,
        actionId: change.reverificationActionId,
        event: "expire",
        outcome: "success",
      });
      return expired ?? change;
    }
    return change;
  });
  return outcome ? asView(outcome, now) : null;
}
