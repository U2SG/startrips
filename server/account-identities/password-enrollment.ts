import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { accountIdentityAudit } from "../db/app-schema";
import { account as authAccount, user as authUser } from "../db/auth-schema";
import { db } from "../db/client";
import {
  AccountIdentityError,
  claimPasswordReverificationAction,
  recordIdentityRefusal,
} from "./account-identity-repository";
import { CREDENTIAL_PROVIDER_ID } from "./identity-policy";

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
 * Record the completed enrollment against the grant that authorized it. One
 * grant enrolls one credential, so the receipt is written at most once even
 * when the original call and a recovery retry overlap; the stable user row is
 * the serialization point, as everywhere else in this module family.
 */
async function recordEnrollmentReceipt(userId: string, actionId: string) {
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
 *   credential on the ST-092 change-password path instead of mutating it here.
 *
 * Unlike a password CHANGE this service does NOT revoke the user's other
 * sessions. Enrollment adds a login method; it does not rotate a secret that
 * another session may be holding, and those sessions were authorized by the
 * provider identity that is still present and still valid. Revoking them would
 * sign the owner out of their other devices for adding a password.
 *
 * Exactly one durable record makes a retry safe to answer: a success receipt
 * written against the consumed grant once the credential was linked. A retry of
 * the same request then reports the completed enrollment instead of enrolling
 * again. A consumed grant carrying NO receipt fails closed, for the reason
 * `changeAccountPassword` documents at length: the stored credential can only
 * answer whether it accepts the RETRY's own password, and a retry is free to
 * change that body, so trusting it would let a second request manufacture a
 * receipt for a password the owner never enrolled. Nothing is left dangling by
 * such an interruption — the owner either signs in with the first password or
 * proves recent control again.
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
      const [receipt] = await transaction
        .select({ id: accountIdentityAudit.id })
        .from(accountIdentityAudit)
        .where(and(
          eq(accountIdentityAudit.userId, values.userId),
          eq(accountIdentityAudit.event, "password-enroll"),
          eq(accountIdentityAudit.outcome, "success"),
          eq(accountIdentityAudit.actionId, claimed.actionId),
        ))
        .limit(1);
      return {
        actionId: claimed.actionId,
        alreadyConsumed: true,
        hasReceipt: Boolean(receipt),
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
      hasReceipt: false,
      refusal,
    };
  });

  if (claim.alreadyConsumed) {
    if (claim.hasReceipt) return { enrolled: false, alreadyEnrolled: true };
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

  await recordEnrollmentReceipt(values.userId, claim.actionId);
  return { enrolled: true, alreadyEnrolled: false };
}
