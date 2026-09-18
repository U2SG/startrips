import { and, eq, ne } from "drizzle-orm";
import { auth } from "../auth";
import { accountIdentityAudit } from "../db/app-schema";
import {
  account as authAccount,
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
import { CREDENTIAL_PROVIDER_ID } from "./identity-policy";

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
 * Does the credential this account signs in with already accept this password?
 *
 * Only ever used to decide whether an interrupted operation already committed
 * its write. It reads the stored hash through Better Auth's own verifier and
 * never reveals it.
 */
async function storedPasswordAccepts(
  userId: string,
  password: string,
): Promise<boolean> {
  const [credential] = await db
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(and(
      eq(authAccount.userId, userId),
      eq(authAccount.providerId, CREDENTIAL_PROVIDER_ID),
    ))
    .limit(1);
  if (!credential?.password) return false;
  const context = await auth.$context;
  return await context.password.verify({
    hash: credential.password,
    password,
  });
}

/**
 * Revoke every session of this user except the calling one and invalidate every
 * outstanding Better Auth capability keyed to the user id. Idempotent, so a
 * retry that finishes an interrupted change may run it again.
 */
async function revokeOtherAccess(values: {
  userId: string;
  sessionId: string;
}): Promise<number> {
  return await db.transaction(async (transaction) => {
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
    return revoked.length;
  });
}

/**
 * Record the completed change against the grant that authorized it. One grant
 * authorizes one change, so the receipt is written at most once even when the
 * original call and a recovery retry overlap; the stable user row is the
 * serialization point, as everywhere else in this module.
 */
async function recordChangeReceipt(userId: string, actionId: string) {
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
        eq(accountIdentityAudit.event, "password-change"),
        eq(accountIdentityAudit.outcome, "success"),
        eq(accountIdentityAudit.actionId, actionId),
      ))
      .limit(1);
    if (existing) return;
    await transaction.insert(accountIdentityAudit).values({
      userId,
      event: "password-change",
      outcome: "success",
      actionId,
    });
  });
}

async function finishChange(
  values: { userId: string; sessionId: string },
  actionId: string,
): Promise<number> {
  const revoked = await revokeOtherAccess(values);
  await recordChangeReceipt(values.userId, actionId);
  return revoked;
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
 * Better Auth owns the credential write in its own transaction, so the write
 * and this revocation cannot share one. The order therefore makes every
 * interruption fail SAFE rather than fail open: revocation runs FIRST, so a
 * process that dies mid-operation can only have revoked access the owner still
 * holds the password for — never left a stale session or a live reset link
 * beside a rotated credential. A refused write consequently still costs the
 * other sessions, which is the conservative side of that trade and is only
 * reachable by a caller who proved the current password minutes ago.
 *
 * The consumed grant is the durable marker for the rest, and BOTH outcomes are
 * recorded against it. A success receipt answers a retry of the same request
 * with the completed change; a recorded refusal makes that grant terminal, so
 * the retry is a replay refusal. Only when the grant carries neither is the
 * outcome genuinely unknown — the attempt may have committed the credential and
 * died before the revocation and the receipt landed — and only then does the
 * stored credential decide, which finishes the operation without a second
 * rotation. Deciding a KNOWN refusal that way would be unsound: the probe asks
 * whether the credential accepts the retry's own new password, so a retry
 * naming the still-current password would read as an already-completed change.
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
      return {
        actionId: claimed.actionId,
        alreadyConsumed: false,
        hasReceipt: false,
        hasRefusal: false,
      };
    }

    // A lost response must not force the owner to guess. Both records are bound
    // to the exact consumed grant, so only a retry of THAT request learns its
    // outcome; any other grant reuse stays a replay refusal.
    const outcomes = await transaction
      .select({ outcome: accountIdentityAudit.outcome })
      .from(accountIdentityAudit)
      .where(and(
        eq(accountIdentityAudit.userId, values.userId),
        eq(accountIdentityAudit.event, "password-change"),
        eq(accountIdentityAudit.actionId, claimed.actionId),
      ));
    return {
      actionId: claimed.actionId,
      alreadyConsumed: true,
      hasReceipt: outcomes.some((row) => row.outcome === "success"),
      hasRefusal: outcomes.some((row) => row.outcome === "refused"),
    };
  });

  if (claim.alreadyConsumed) {
    if (claim.hasReceipt) {
      return { changed: false, alreadyChanged: true, revokedOtherSessions: 0 };
    }
    // A refusal recorded against this exact grant makes its one authorized
    // attempt terminal: the credential was not touched, and this grant may
    // never authorize another attempt. Fail closed BEFORE the credential is
    // consulted at all. Probing it here would answer a question about the
    // retry's OWN request rather than about the operation that was authorized:
    // a retry naming the still-current password as its new one would find the
    // stored credential accepting it and manufacture a success receipt for a
    // rotation that never happened.
    if (claim.hasRefusal) {
      throw new AccountPasswordChangeError("PASSWORD_CHANGE_REVERIFY_REPLAYED");
    }
    // Nothing at all was recorded against the grant, so the outcome of the
    // attempt it authorized is genuinely unknown: it may have committed the
    // credential and died before the revocation/receipt landed. Only here does
    // the stored credential settle it — if it already accepts the password this
    // retry is asking for, the operation is finishable rather than replayable.
    if (!await storedPasswordAccepts(values.userId, values.newPassword)) {
      throw new AccountPasswordChangeError("PASSWORD_CHANGE_REVERIFY_REPLAYED");
    }
    return {
      changed: false,
      alreadyChanged: true,
      revokedOtherSessions: await finishChange(values, claim.actionId),
    };
  }

  // Fail-safe ordering: revoke before the credential write, never after. See the
  // doc comment — an interruption here can only over-revoke.
  const revokedOtherSessions = await revokeOtherAccess(values);

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
      actionId: claim.actionId,
      reason: refusal,
    });
    throw new AccountPasswordChangeError(refusal);
  }

  await recordChangeReceipt(values.userId, claim.actionId);
  return { changed: true, alreadyChanged: false, revokedOtherSessions };
}
