import { and, eq, ne } from "drizzle-orm";
import { auth } from "../auth";
import { accountIdentityAudit } from "../db/app-schema";
import {
  session as authSession,
  user as authUser,
  verification as authVerification,
} from "../db/auth-schema";
import { db } from "../db/client";
import {
  AccountIdentityError,
  claimPasswordReverificationAction,
  recordIdentityRefusal,
} from "./account-identity-repository";

export type AccountPasswordChangeErrorCode =
  | "PASSWORD_CHANGE_INVALID"
  | "PASSWORD_CHANGE_ACCOUNT_NOT_FOUND"
  | "PASSWORD_CHANGE_REVERIFY_INVALID"
  | "PASSWORD_CHANGE_REVERIFY_EXPIRED"
  | "PASSWORD_CHANGE_REVERIFY_REPLAYED"
  | "PASSWORD_CHANGE_SESSION_CHANGED"
  | "PASSWORD_CHANGE_SESSION_EXPIRED"
  | "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND"
  | "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID"
  | "PASSWORD_CHANGE_PASSWORD_TOO_SHORT"
  | "PASSWORD_CHANGE_PASSWORD_TOO_LONG";

export class AccountPasswordChangeError extends Error {
  constructor(readonly code: AccountPasswordChangeErrorCode) {
    super(code);
    this.name = "AccountPasswordChangeError";
  }
}

export type AccountPasswordChangeResult = {
  /** True when this call performed the credential write. */
  changed: boolean;
  /** True when the exact same grant already performed it. */
  alreadyChanged: boolean;
  /** Sessions other than the calling one that this call revoked. */
  revokedOtherSessions: number;
};

/**
 * Map a Better Auth 1.6.23 refusal onto this service's vocabulary.
 *
 * `APIError.from` puts the stable `BASE_ERROR_CODES` key in `body.code`, so the
 * mapping keys on that rather than on a human message that a locale or a patch
 * release may reword. An unrecognised failure returns null and is re-thrown
 * unchanged: inventing a refusal code for it would tell the caller something
 * the server does not actually know.
 */
function refusalFromAuthError(
  error: unknown,
): AccountPasswordChangeErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  const body = (error as { body?: unknown }).body;
  const code = typeof body === "object" && body !== null
    ? (body as { code?: unknown }).code
    : undefined;
  switch (code) {
    case "INVALID_PASSWORD":
      return "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID";
    case "PASSWORD_TOO_SHORT":
      return "PASSWORD_CHANGE_PASSWORD_TOO_SHORT";
    case "PASSWORD_TOO_LONG":
      return "PASSWORD_CHANGE_PASSWORD_TOO_LONG";
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND";
    case "UNAUTHORIZED":
      return "PASSWORD_CHANGE_SESSION_EXPIRED";
    default:
      break;
  }
  // Better Auth answers a session that is gone, expired or no longer
  // authoritative with an unauthorized status from its sensitive-session
  // middleware. Keep that one class recognisable even if its body shape moves.
  if (status === "UNAUTHORIZED" || status === 401) {
    return "PASSWORD_CHANGE_SESSION_EXPIRED";
  }
  return null;
}

function reverificationRefusal(code: string): AccountPasswordChangeErrorCode {
  switch (code) {
    case "IDENTITY_ACTION_EXPIRED":
      return "PASSWORD_CHANGE_REVERIFY_EXPIRED";
    case "IDENTITY_ACTION_REPLAYED":
      return "PASSWORD_CHANGE_REVERIFY_REPLAYED";
    case "IDENTITY_ACTION_SESSION_CHANGED":
      return "PASSWORD_CHANGE_SESSION_CHANGED";
    default:
      return "PASSWORD_CHANGE_REVERIFY_INVALID";
  }
}

/**
 * Replace the password of the one stable Startrips Account behind this session.
 *
 * The write itself is Better Auth 1.6.23's own `/change-password` handler,
 * called server-side so its current-password verification, configured length
 * policy and password hashing stay the single implementation. Around it this
 * service adds what that handler knows nothing about:
 *
 * - the ST-067 single-use recent-proof grant, consumed before the credential is
 *   touched, so a stolen live session alone cannot rotate the password and a
 *   retry cannot rotate it twice;
 * - a deterministic session rule — every OTHER session of this user is revoked
 *   and the calling session survives. Better Auth's own `revokeOtherSessions`
 *   deletes the current session too and creates a replacement whose
 *   `activeOrganizationId` is null, which would silently drop the caller out of
 *   their Atlas; this service therefore never sets it and revokes explicitly;
 * - invalidation of outstanding capabilities issued against this user id, so a
 *   password-reset link mailed before the change cannot overwrite the new
 *   credential afterwards.
 *
 * Nothing about the passwords, the hash or the grant value is returned, logged
 * or recorded; the audit row carries only the opaque action id.
 */
export async function changeAccountPassword(values: {
  userId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  reverificationToken: string;
  headers: Headers;
  now?: Date;
}): Promise<AccountPasswordChangeResult> {
  const now = values.now ?? new Date();

  const claim = await db.transaction(async (transaction) => {
    // Same lock order as the other sensitive account transactions: the stable
    // user row first, then the grant.
    const [user] = await transaction
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.id, values.userId))
      .for("update")
      .limit(1);
    if (!user) {
      throw new AccountPasswordChangeError("PASSWORD_CHANGE_ACCOUNT_NOT_FOUND");
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
      throw new AccountPasswordChangeError(reverificationRefusal(error.code));
    }

    if (!claimed.alreadyConsumed) {
      return { actionId: claimed.actionId, alreadyChanged: false };
    }

    // A lost response must not force the owner to guess. The receipt is bound
    // to the exact consumed grant, so only a retry of THAT request reports the
    // completed change; any other grant reuse stays a replay refusal.
    const [receipt] = await transaction
      .select({ id: accountIdentityAudit.id })
      .from(accountIdentityAudit)
      .where(and(
        eq(accountIdentityAudit.userId, values.userId),
        eq(accountIdentityAudit.event, "password-change"),
        eq(accountIdentityAudit.outcome, "success"),
        eq(accountIdentityAudit.actionId, claimed.actionId),
      ))
      .limit(1);
    if (!receipt) {
      throw new AccountPasswordChangeError("PASSWORD_CHANGE_REVERIFY_REPLAYED");
    }
    return { actionId: claimed.actionId, alreadyChanged: true };
  });

  if (claim.alreadyChanged) {
    return { changed: false, alreadyChanged: true, revokedOtherSessions: 0 };
  }

  try {
    await auth.api.changePassword({
      body: {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: false,
      },
      headers: values.headers,
    });
  } catch (error) {
    const refusal = refusalFromAuthError(error);
    if (!refusal) throw error;
    await recordIdentityRefusal({
      userId: values.userId,
      event: "password-change",
      reason: refusal,
    });
    throw new AccountPasswordChangeError(refusal);
  }

  const revokedOtherSessions = await db.transaction(async (transaction) => {
    const revoked = await transaction
      .delete(authSession)
      .where(and(
        eq(authSession.userId, values.userId),
        ne(authSession.id, values.sessionId),
      ))
      .returning({ id: authSession.id });
    await transaction
      .delete(authVerification)
      .where(eq(authVerification.value, values.userId));
    await transaction.insert(accountIdentityAudit).values({
      userId: values.userId,
      event: "password-change",
      outcome: "success",
      actionId: claim.actionId,
    });
    return revoked.length;
  });

  return { changed: true, alreadyChanged: false, revokedOtherSessions };
}
