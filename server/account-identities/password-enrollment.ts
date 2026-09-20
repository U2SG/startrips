import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { accountIdentityAudit } from "../db/app-schema";
import {
  account as authAccount,
  user as authUser,
  verification as authVerification,
} from "../db/auth-schema";
import { db } from "../db/client";
import {
  AccountIdentityError,
  claimPasswordReverificationAction,
  recordIdentityRefusal,
} from "./account-identity-repository";
import { CREDENTIAL_PROVIDER_ID } from "./identity-policy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AccountPasswordEnrollmentErrorCode =
  | "PASSWORD_ENROLL_INVALID"
  | "PASSWORD_ENROLL_ACCOUNT_NOT_FOUND"
  | "PASSWORD_ENROLL_REVERIFY_INVALID"
  | "PASSWORD_ENROLL_REVERIFY_EXPIRED"
  | "PASSWORD_ENROLL_REVERIFY_REPLAYED"
  | "PASSWORD_ENROLL_SESSION_CHANGED"
  | "PASSWORD_ENROLL_SESSION_EXPIRED"
  | "PASSWORD_ENROLL_RECOVERY_REQUIRED"
  | "PASSWORD_ENROLL_ALREADY_SET"
  | "PASSWORD_ENROLL_PASSWORD_TOO_SHORT"
  | "PASSWORD_ENROLL_PASSWORD_TOO_LONG";

export class AccountPasswordEnrollmentError extends Error {
  constructor(readonly code: AccountPasswordEnrollmentErrorCode) {
    super(code);
    this.name = "AccountPasswordEnrollmentError";
  }
}

export type AccountPasswordEnrollmentResult = {
  /** True when this call linked the credential. */
  enrolled: boolean;
  /** True when the exact same grant already linked it. */
  alreadyEnrolled: boolean;
};

/**
 * Map a Better Auth 1.6.23 refusal onto this service's vocabulary, keying on
 * the stable `BASE_ERROR_CODES` value in `body.code` rather than on a message
 * a locale or a patch release may reword. An unrecognised failure returns null
 * and is re-thrown unchanged.
 */
function refusalFromAuthError(
  error: unknown,
): AccountPasswordEnrollmentErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  const body = (error as { body?: unknown }).body;
  const code = typeof body === "object" && body !== null
    ? (body as { code?: unknown }).code
    : undefined;
  switch (code) {
    case "PASSWORD_ALREADY_SET":
      return "PASSWORD_ENROLL_ALREADY_SET";
    case "PASSWORD_TOO_SHORT":
      return "PASSWORD_ENROLL_PASSWORD_TOO_SHORT";
    case "PASSWORD_TOO_LONG":
      return "PASSWORD_ENROLL_PASSWORD_TOO_LONG";
    case "UNAUTHORIZED":
      return "PASSWORD_ENROLL_SESSION_EXPIRED";
    default:
      break;
  }
  if (status === "UNAUTHORIZED" || status === 401) {
    return "PASSWORD_ENROLL_SESSION_EXPIRED";
  }
  return null;
}

/**
 * True for a PostgreSQL unique violation anywhere in the error chain.
 *
 * Better Auth links the credential with a plain insert, so the
 * `account_provider_subject_unique` index (migration 0021) answers a losing
 * racer with a raw driver error rather than an `APIError` carrying a stable
 * code. That collision is not a bug to guard against with a pre-flight read
 * (#198 rule 17): it is the database reporting that this user's
 * `credential`/user-id identity already exists, which is exactly the
 * already-enrolled refusal.
 */
function uniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    if (typeof cursor !== "object") return false;
    if ((cursor as { code?: unknown }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

function reverificationRefusal(
  code: string,
): AccountPasswordEnrollmentErrorCode {
  switch (code) {
    case "IDENTITY_ACTION_EXPIRED":
      return "PASSWORD_ENROLL_REVERIFY_EXPIRED";
    case "IDENTITY_ACTION_REPLAYED":
      return "PASSWORD_ENROLL_REVERIFY_REPLAYED";
    case "IDENTITY_ACTION_SESSION_CHANGED":
      return "PASSWORD_ENROLL_SESSION_CHANGED";
    default:
      return "PASSWORD_ENROLL_REVERIFY_INVALID";
  }
}

/**
 * Invalidate every outstanding Better Auth capability keyed to this user id.
 *
 * `request-password-reset` resolves its subject by email alone and never asks
 * whether that user holds a credential, so a credential-less user can already
 * have a live `reset-password:*` verification value. Enrollment would otherwise
 * leave it usable, and its bearer could then overwrite the password the owner
 * just enrolled and revoke their sessions. This is the same hazard
 * `changeAccountPassword` clears before replacing a credential, and it is
 * cleared here for the same reason and in the same fail-safe order: before the
 * write, so an interruption can only have invalidated links the owner is free
 * to request again.
 */
async function invalidateOutstandingCapabilities(userId: string) {
  await db.delete(authVerification).where(eq(authVerification.value, userId));
}

/**
 * Declare, durably and before the credential is touched, that THIS grant is
 * about to enroll a password.
 *
 * Without it the credential a retry reads is anonymous: it proves that the
 * account now has a password, not that this grant's write is what produced it.
 * The intent row is what makes the authoritative account-method read
 * attributable, so a grant that never reached the write path can never be
 * reconciled into a success. It carries the opaque action id only.
 */
async function recordEnrollmentIntent(userId: string, actionId: string) {
  await db.insert(accountIdentityAudit).values({
    userId,
    event: "password-enroll-intent",
    outcome: "success",
    actionId,
  });
}

/**
 * The user's authoritative password login method, as Better Auth itself
 * resolves it: a `credential` account row whose password is set. A row without
 * one is not a usable credential to `setPassword` either.
 */
async function readUsableCredential(
  transaction: Transaction,
  userId: string,
): Promise<{ id: string } | null> {
  const rows = await transaction
    .select({ id: authAccount.id, password: authAccount.password })
    .from(authAccount)
    .where(and(
      eq(authAccount.userId, userId),
      eq(authAccount.providerId, CREDENTIAL_PROVIDER_ID),
    ));
  const usable = rows.find((row) => Boolean(row.password));
  return usable ? { id: usable.id } : null;
}

/**
 * Record the completed enrollment against the grant that authorized it, naming
 * the credential row it produced. One grant enrolls one credential, so the
 * receipt is written at most once even when the original call and a recovery
 * retry overlap; the stable user row is the serialization point, as everywhere
 * else in this module family.
 *
 * `accountRecordId` is what lets a later grant tell "the credential I wrote"
 * from "a credential somebody else's grant wrote", so an already-attributed
 * credential is refused rather than claimed twice.
 */
async function recordEnrollmentReceipt(
  userId: string,
  actionId: string,
  accountRecordId: string | null,
) {
  await db.transaction(async (transaction) => {
    await transaction
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.id, userId))
      .for("update")
      .limit(1);
    const [existing] = await transaction
      .select({ id: accountIdentityAudit.id })
      .from(accountIdentityAudit)
      .where(and(
        eq(accountIdentityAudit.userId, userId),
        eq(accountIdentityAudit.event, "password-enroll"),
        eq(accountIdentityAudit.outcome, "success"),
        eq(accountIdentityAudit.actionId, actionId),
      ))
      .limit(1);
    if (existing) return;
    await transaction.insert(accountIdentityAudit).values({
      userId,
      event: "password-enroll",
      outcome: "success",
      actionId,
      accountRecordId,
    });
  });
}

/**
 * Give the one stable Startrips Account behind this session its FIRST password.
 *
 * #445 is the credential-less sibling of `changeAccountPassword`: that service
 * replaces an existing credential and Better Auth answers a user who has none
 * with `CREDENTIAL_ACCOUNT_NOT_FOUND`. The write here is Better Auth 1.6.23's
 * own server-only `setPassword`, so its configured length policy, password
 * hashing and `linkAccount` stay the single implementation — in particular the
 * credential is linked to the CURRENT user (`accountId = user.id`), never
 * through sign-up, so the Atlas membership, Journeys and preferences of that
 * stable user are untouched.
 *
 * Around it this service adds what that handler knows nothing about:
 *
 * - the ST-067 single-use recent-proof grant, consumed before the credential is
 *   touched, so a merely live old session cannot mint a password and a retry
 *   cannot enroll twice;
 * - the server-side recovery precondition. A credential is only a usable login
 *   method while the account's email is verified (`accountIdentityUsable`), and
 *   an unverified address is also the one that would have to recover it, so an
 *   unverified user is told to verify rather than handed a credential that
 *   cannot be used or recovered. That check runs before any Better Auth call;
 * - the already-enrolled refusal, which keeps a user who still holds a usable
 *   credential on the ST-092 change-password path instead of mutating it here;
 * - invalidation of outstanding capabilities issued against this user id. A
 *   password-reset link can already exist for a credential-less user, because
 *   `request-password-reset` resolves its subject by email alone, and such a
 *   link mailed before enrollment must not overwrite the enrolled credential
 *   afterwards.
 *
 * Unlike a password CHANGE this service does NOT revoke the user's other
 * sessions. Enrollment adds a login method; it does not rotate a secret that
 * another session may be holding, and those sessions were authorized by the
 * provider identity that is still present and still valid. Revoking them would
 * sign the owner out of their other devices for adding a password.
 *
 * Two durable records make a retry safe to answer. An INTENT row is written
 * against the grant immediately before the credential is touched, and a SUCCESS
 * receipt naming the linked credential row once it is. A retry holding the
 * success receipt reports the completed enrollment instead of enrolling again.
 *
 * A consumed grant carrying no receipt is not simply refused: the write may
 * have committed and the response been lost, and #445 requires that window to
 * be reconcilable by re-reading the authoritative account methods. Enrollment
 * can do that soundly where `changeAccountPassword` cannot. Its question is
 * "does a usable credential exist at all", a state only this flow's write can
 * flip; a password CHANGE asks whether a secret rotated, which the stored
 * credential can only answer about the RETRY's own body, so a retry free to
 * change that body could manufacture a receipt there.
 *
 * The read is attributable rather than a bare existence check, which is the
 * part that keeps it sound. Reconciliation requires this grant's own intent row
 * — proof that THIS grant reached the write — and a credential that no other
 * grant's receipt already names. A credential enrolled by a different grant
 * means this one lost the race and is refused as already-set. A consumed grant
 * with no intent, or with no credential to show for it, keeps the unchanged
 * already-spent refusal: nothing is left dangling, and the owner either signs
 * in with the first password or proves recent control again.
 *
 * One window stays open and is accepted deliberately. Two grants can both pass
 * the credential-less precondition before either writes; the loser is answered
 * by Better Auth or by the unique index and records its own already-set
 * refusal. If that loser instead dies before recording, and retries in the
 * interval after the winner's credential commits but before the winner writes
 * its receipt, it will attribute the credential to itself. It cannot corrupt
 * anything — the unique index still permits exactly one credential, and the
 * owner does hold a usable password — it can only misattribute one audit row.
 * Closing it would require the attribution to commit inside Better Auth's own
 * `setPassword` transaction, which this service does not own.
 *
 * Nothing about the password, the hash or the grant value is returned, logged
 * or recorded; the audit row carries only the opaque action id.
 */
export async function enrollAccountPassword(values: {
  userId: string;
  sessionId: string;
  newPassword: string;
  reverificationToken: string;
  headers: Headers;
  now?: Date;
}): Promise<AccountPasswordEnrollmentResult> {
  const now = values.now ?? new Date();

  const claim = await db.transaction(async (transaction) => {
    // Same lock order as the other sensitive account transactions: the stable
    // user row first, then the grant.
    const [user] = await transaction
      .select({ id: authUser.id, emailVerified: authUser.emailVerified })
      .from(authUser)
      .where(eq(authUser.id, values.userId))
      .for("update")
      .limit(1);
    if (!user) {
      throw new AccountPasswordEnrollmentError(
        "PASSWORD_ENROLL_ACCOUNT_NOT_FOUND",
      );
    }

    let claimed: Awaited<ReturnType<typeof claimPasswordReverificationAction>>;
    try {
      claimed = await claimPasswordReverificationAction(transaction, {
        token: values.reverificationToken,
        userId: values.userId,
        sessionId: values.sessionId,
        now,
      });
    } catch (error) {
      if (!(error instanceof AccountIdentityError)) throw error;
      throw new AccountPasswordEnrollmentError(
        reverificationRefusal(error.code),
      );
    }

    if (claimed.alreadyConsumed) {
      // A lost response must not force the owner to guess. The receipt is bound
      // to the exact consumed grant, so only a retry of THAT request reads as
      // the completed enrollment; any other grant reuse stays a replay refusal.
      const receipts = await transaction
        .select({
          actionId: accountIdentityAudit.actionId,
          accountRecordId: accountIdentityAudit.accountRecordId,
        })
        .from(accountIdentityAudit)
        .where(and(
          eq(accountIdentityAudit.userId, values.userId),
          eq(accountIdentityAudit.event, "password-enroll"),
          eq(accountIdentityAudit.outcome, "success"),
        ));
      if (receipts.some((receipt) => receipt.actionId === claimed.actionId)) {
        return {
          actionId: claimed.actionId,
          alreadyConsumed: true,
          alreadyEnrolled: true,
          lostRace: false,
          refusal: null,
        };
      }

      // No receipt. Before refusing, re-read the authoritative account method,
      // which is exactly what a consumed grant CAN be reconciled against here:
      // enrollment answers "does a usable credential exist at all", a state
      // only this flow's write can flip, unlike `changeAccountPassword`, whose
      // question ("did the secret rotate") the stored credential cannot answer
      // about anything but the retry's own body.
      //
      // The reconciliation is attributable, never a bare existence check. It
      // needs this grant's own intent row — proof that THIS grant reached the
      // write — and a credential that no other grant's receipt already names.
      // A credential another grant enrolled means this grant lost the race and
      // is refused as already-set, not reported as a success it never made.
      const [intent] = await transaction
        .select({ id: accountIdentityAudit.id })
        .from(accountIdentityAudit)
        .where(and(
          eq(accountIdentityAudit.userId, values.userId),
          eq(accountIdentityAudit.event, "password-enroll-intent"),
          eq(accountIdentityAudit.actionId, claimed.actionId),
        ))
        .limit(1);
      const credential = intent
        ? await readUsableCredential(transaction, values.userId)
        : null;
      if (!credential) {
        return {
          actionId: claimed.actionId,
          alreadyConsumed: true,
          alreadyEnrolled: false,
          lostRace: false,
          refusal: null,
        };
      }
      if (
        receipts.some((receipt) => receipt.accountRecordId === credential.id)
      ) {
        return {
          actionId: claimed.actionId,
          alreadyConsumed: true,
          alreadyEnrolled: false,
          lostRace: true,
          refusal: null,
        };
      }
      // This grant's interrupted write is the only thing that can have produced
      // this credential. Complete the receipt it never got to write, under the
      // same user-row lock the grant was claimed under.
      await transaction.insert(accountIdentityAudit).values({
        userId: values.userId,
        event: "password-enroll",
        outcome: "success",
        actionId: claimed.actionId,
        accountRecordId: credential.id,
      });
      return {
        actionId: claimed.actionId,
        alreadyConsumed: true,
        alreadyEnrolled: true,
        lostRace: false,
        refusal: null,
      };
    }

    // Preconditions are read under the same user-row lock that the grant was
    // claimed under, and their refusals are returned rather than thrown: a
    // refused attempt is still a completed sensitive action, so the grant's one
    // authorization commits with it (the `unlinkAccountIdentity` precedent).
    // The predicate matches Better Auth's own `setPassword` lookup exactly — a
    // `credential` row whose password is null is not a usable credential to it
    // either, and falls through to the linking path below.
    const credentials = await transaction
      .select({ password: authAccount.password })
      .from(authAccount)
      .where(and(
        eq(authAccount.userId, values.userId),
        eq(authAccount.providerId, CREDENTIAL_PROVIDER_ID),
      ));
    const refusal: AccountPasswordEnrollmentErrorCode | null =
      credentials.some((credential) => Boolean(credential.password))
        ? "PASSWORD_ENROLL_ALREADY_SET"
        : user.emailVerified
          ? null
          : "PASSWORD_ENROLL_RECOVERY_REQUIRED";
    return {
      actionId: claimed.actionId,
      alreadyConsumed: false,
      alreadyEnrolled: false,
      lostRace: false,
      refusal,
    };
  });

  if (claim.alreadyConsumed) {
    if (claim.alreadyEnrolled) return { enrolled: false, alreadyEnrolled: true };
    if (claim.lostRace) {
      await recordIdentityRefusal({
        userId: values.userId,
        event: "password-enroll",
        actionId: claim.actionId,
        reason: "PASSWORD_ENROLL_ALREADY_SET",
      });
      throw new AccountPasswordEnrollmentError("PASSWORD_ENROLL_ALREADY_SET");
    }
    throw new AccountPasswordEnrollmentError("PASSWORD_ENROLL_REVERIFY_REPLAYED");
  }

  if (claim.refusal) {
    await recordIdentityRefusal({
      userId: values.userId,
      event: "password-enroll",
      actionId: claim.actionId,
      reason: claim.refusal,
    });
    throw new AccountPasswordEnrollmentError(claim.refusal);
  }

  await invalidateOutstandingCapabilities(values.userId);

  // Durable intent BEFORE the write, for the same fail-safe reason the
  // capability invalidation runs before it: an interruption may leave an intent
  // with no credential, which reconciles to the unchanged already-spent refusal,
  // but can never leave a credential with no way to attribute it.
  await recordEnrollmentIntent(values.userId, claim.actionId);

  try {
    await auth.api.setPassword({
      body: { newPassword: values.newPassword },
      headers: values.headers,
    });
  } catch (error) {
    const refusal = uniqueViolation(error)
      ? "PASSWORD_ENROLL_ALREADY_SET"
      : refusalFromAuthError(error);
    if (!refusal) throw error;
    await recordIdentityRefusal({
      userId: values.userId,
      event: "password-enroll",
      actionId: claim.actionId,
      reason: refusal,
    });
    throw new AccountPasswordEnrollmentError(refusal);
  }

  const credential = await db.transaction(async (transaction) =>
    await readUsableCredential(transaction, values.userId));
  await recordEnrollmentReceipt(
    values.userId,
    claim.actionId,
    credential?.id ?? null,
  );
  return { enrolled: true, alreadyEnrolled: false };
}
