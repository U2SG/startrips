import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { atlases, shareGrants } from "../db/app-schema";
import { db } from "../db/client";

/** 256 bits, well above the 128-bit floor #200 asks for. */
export const SHARE_TOKEN_BYTES = 32;

/** base64url of 32 bytes: 43 characters, no padding. */
export const SHARE_TOKEN_LENGTH = 43;

/** A share link may not outlive one year, so `永久有效` stays an explicit product decision. */
export const MAX_SHARE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A guest presented a token that does not authorize anything right now.
 *
 * Deliberately one status and one message for every cause: unknown token,
 * revoked grant, expired grant, and an Atlas that started deleting all look
 * identical from outside, so a token probe learns nothing beyond "unavailable".
 * `message` is a fixed string because `app.ts` logs `error.message`.
 */
export class ShareAccessError extends Error {
  constructor(
    readonly status: 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function shareUnavailable(): ShareAccessError {
  return new ShareAccessError(
    404,
    "SHARE_UNAVAILABLE",
    "Share link unavailable",
  );
}

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/**
 * The token carries 256 bits of entropy, so a single SHA-256 is enough — a
 * slow KDF protects low-entropy secrets, which this is not.
 */
export function hashShareToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * The amendment on #200 puts the token in the URL fragment, which never
 * reaches a server, and the SPA replays it as `Authorization: Bearer <token>`.
 * Caddy redacts `Authorization` by default, so no edge log ever sees it.
 */
export function parseBearerToken(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue) return null;
  const match = /^Bearer +(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

export type ShareGrantState = {
  expiresAt: Date;
  revokedAt: Date | null;
  atlasDeletionStartedAt: Date | null;
};

export type ShareGrantStatus =
  | "active"
  | "revoked"
  | "expired"
  | "atlas-unavailable";

/**
 * The whole expiry/revocation contract as one pure decision, so the server
 * clock is the only authority and the rules are unit-testable without a
 * database. An explicit revoke outranks a later expiry because that is the
 * more informative state for the owner-facing list.
 */
export function evaluateShareGrant(
  grant: ShareGrantState,
  now: Date,
): ShareGrantStatus {
  if (grant.revokedAt) return "revoked";
  if (grant.atlasDeletionStartedAt) return "atlas-unavailable";
  // `expiresAt <= now` is expired: the instant of expiry is already too late.
  if (grant.expiresAt.valueOf() <= now.valueOf()) return "expired";
  return "active";
}

export type ActiveShareGrant = {
  id: string;
  atlasId: string;
  expiresAt: Date;
};

/**
 * Resolve the bearer token to an active grant, or fail with the one generic
 * unavailable error.
 *
 * A share grant is not an Atlas member: it carries no role, no `AtlasAction`,
 * and `requireAtlasAccess()` never accepts it. The row is found by the stored
 * hash, so no secret-dependent comparison happens in application code. The
 * Atlas is joined and its `deletionStartedAt` is *selected* rather than
 * filtered, which keeps the decision in `evaluateShareGrant`.
 */
export async function requireActiveShareGrant(
  request: Request,
  now: Date = new Date(),
): Promise<ActiveShareGrant> {
  const rawToken = parseBearerToken(request.headers.get("authorization"));
  if (!rawToken) throw shareUnavailable();

  const [grant] = await db
    .select({
      id: shareGrants.id,
      atlasId: shareGrants.atlasId,
      expiresAt: shareGrants.expiresAt,
      revokedAt: shareGrants.revokedAt,
      atlasDeletionStartedAt: atlases.deletionStartedAt,
    })
    .from(shareGrants)
    .innerJoin(atlases, eq(atlases.id, shareGrants.atlasId))
    .where(eq(shareGrants.tokenHash, hashShareToken(rawToken)))
    .limit(1);

  if (!grant || evaluateShareGrant(grant, now) !== "active") {
    throw shareUnavailable();
  }
  return { id: grant.id, atlasId: grant.atlasId, expiresAt: grant.expiresAt };
}
