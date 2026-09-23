import { createHash } from "node:crypto";
import { lte } from "drizzle-orm";
import { db } from "../db/client";
import { providerIdTokenConsumptions } from "../db/app-schema";

/**
 * #350 owner decision B: a provider ID token may be spent exactly once.
 *
 * The signature/issuer/audience/age/nonce checks the pinned Better Auth 1.6.23
 * adapter runs answer "did the provider mint this token for us"; they say
 * nothing about whether it has already been presented. On the direct
 * `/sign-in/social` `idToken` path there is no authorization code and no
 * single-use `state` to fall back on, so the same still-valid token could be
 * posted again -- from another client, without the original request -- and
 * would be a second successful authentication. This module is what makes the
 * second one fail.
 *
 * What is single-use is the TOKEN, not the Apple subject: a fresh token for a
 * subject that already owns an account signs that same account back in. A
 * refused replay neither revokes the session the first use established nor
 * marks the account in any way -- nothing here writes to an identity table.
 */

/**
 * The provider adapter's own maximum token age. `verifyIdToken` passes
 * `maxTokenAge: "1h"` to `jwtVerify`, so a token is refused for being stale one
 * hour after it was issued no matter what `exp` claims.
 */
const PROVIDER_MAX_TOKEN_AGE_MS = 60 * 60 * 1000;

/** Digest only. The raw token never reaches storage, a log or an error. */
export function idTokenDigest(providerId: string, token: string): string {
  return createHash("sha256").update(`${providerId}\n${token}`, "utf8").digest("hex");
}

function claimSeconds(claims: Record<string, unknown>, name: string): number | null {
  const value = claims[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The end of the window in which this token would still be accepted.
 *
 * It is the EARLIER of the token's own `exp` and the adapter's one-hour age
 * limit, because either one alone is enough to refuse the token -- so the
 * record has to survive only until the first of them passes, and pruning at
 * that moment cannot revive anything. A token whose claims cannot be read
 * falls back to the full age limit measured from now, which is the longer,
 * fail-closed direction.
 */
export function idTokenAcceptanceWindowEnd(token: string, now: number): number {
  const segment = token.split(".")[1];
  if (!segment) return now + PROVIDER_MAX_TOKEN_AGE_MS;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as
      Record<string, unknown>;
  } catch {
    return now + PROVIDER_MAX_TOKEN_AGE_MS;
  }
  const issuedAt = claimSeconds(claims, "iat");
  const expiresAt = claimSeconds(claims, "exp");
  const ageLimit = issuedAt === null
    ? now + PROVIDER_MAX_TOKEN_AGE_MS
    : issuedAt * 1000 + PROVIDER_MAX_TOKEN_AGE_MS;
  if (expiresAt === null) return ageLimit;
  return Math.min(ageLimit, expiresAt * 1000);
}

/**
 * The storage this module needs, narrowed to two operations so a test can
 * substitute a failing one. The real implementation is the shared database,
 * which is what makes consumption atomic across instances rather than per
 * process: `on conflict do nothing ... returning` hands the row back to
 * exactly one caller of the same digest, whichever process it ran in, and the
 * record outlives the process that wrote it.
 */
export type IdTokenConsumptionStore = {
  prune(expiredAt: Date): Promise<void>;
  claim(record: {
    tokenDigest: string;
    providerId: string;
    expiresAt: Date;
  }): Promise<boolean>;
};

export const databaseIdTokenConsumptionStore: IdTokenConsumptionStore = {
  async prune(expiredAt) {
    await db
      .delete(providerIdTokenConsumptions)
      .where(lte(providerIdTokenConsumptions.expiresAt, expiredAt));
  },
  async claim(record) {
    const claimed = await db
      .insert(providerIdTokenConsumptions)
      .values(record)
      .onConflictDoNothing({ target: providerIdTokenConsumptions.tokenDigest })
      .returning({ tokenDigest: providerIdTokenConsumptions.tokenDigest });
    return claimed.length > 0;
  },
};

/**
 * Spend one verified ID token, or refuse it because it was already spent.
 *
 * Call this only AFTER the adapter has verified the token: an unverified token
 * must not be able to occupy the digest a genuine one would later claim, which
 * would let anyone who can guess a token string deny its real owner a sign-in.
 *
 * A storage failure returns `false`. The alternative -- treating an
 * unreachable replay store as "probably fine" -- would turn every transient
 * database fault into an open replay window, so the refusal is deliberate and
 * the caller surfaces it as a rejected token.
 */
export async function consumeVerifiedIdToken(
  input: { providerId: string; token: string },
  store: IdTokenConsumptionStore = databaseIdTokenConsumptionStore,
  now = Date.now(),
): Promise<boolean> {
  const expiresAt = new Date(idTokenAcceptanceWindowEnd(input.token, now));
  try {
    // Pruning here rather than from a background reconciler keeps the table
    // bounded by the same window that bounds acceptance, without a fourth
    // periodic task. It can only delete rows whose token is already refused
    // for being too old, so it never restores a replayable token.
    await store.prune(new Date(now));
    return await store.claim({
      tokenDigest: idTokenDigest(input.providerId, input.token),
      providerId: input.providerId,
      expiresAt,
    });
  } catch (error) {
    // The token itself, and its digest, stay out of the log: the first is a
    // live credential and the second is enough to deny its owner a sign-in.
    console.error("provider_id_token_replay_store_failed", {
      providerId: input.providerId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return false;
  }
}
