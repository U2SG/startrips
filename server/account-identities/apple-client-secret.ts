import { createPrivateKey, sign } from "node:crypto";
import type { ServerConfig } from "../config";

/**
 * #350: the Apple half of a deployment credential that expires.
 *
 * Every other provider hands a deployment a client secret string. Apple hands
 * it a signing key instead, and the "client secret" the token endpoint wants is
 * an ES256 JWT this server mints: issued by the Team, identified by the Key id,
 * scoped to the Service id, and audienced at Apple. Apple accepts a lifetime of
 * at most six months, which is where the usual failure comes from — a secret
 * minted once at deploy time silently stops working months later, long after
 * anyone connects the outage to the deployment that caused it.
 *
 * Startrips therefore never stores a minted secret. It mints one on the way to
 * the token endpoint and keeps it only long enough to cover a burst of
 * callbacks, so the credential that can actually expire is the .p8 key itself —
 * which expires only when a human revokes it, and whose revocation is a
 * deliberate, documented act rather than a forgotten clock.
 * `docs/architecture/apple-sign-in.md` carries the rotation procedure.
 */

/** Apple refuses a client secret whose lifetime exceeds six months. */
export const APPLE_CLIENT_SECRET_MAX_LIFETIME_SECONDS = 15_777_000;

/**
 * The lifetime actually used. Short enough that a leaked secret is worthless
 * almost immediately, long enough that one authorization's token exchange
 * cannot outlive it.
 */
export const APPLE_CLIENT_SECRET_LIFETIME_SECONDS = 10 * 60;

/** Re-mint this long before expiry so an in-flight exchange never races it. */
export const APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS = 60;

export type AppleSigningCredential = {
  serviceId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Mint one client-secret JWT.
 *
 * `dsaEncoding: "ieee-p1363"` is what makes this a JWS rather than a DER
 * signature: JOSE requires the raw r||s pair, and Node's default ECDSA output
 * is DER, which Apple rejects as malformed.
 */
export function createAppleClientSecret(
  credential: AppleSigningCredential,
  now = Date.now(),
  lifetimeSeconds = APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
): string {
  if (
    !Number.isInteger(lifetimeSeconds)
    || lifetimeSeconds < 1
    || lifetimeSeconds > APPLE_CLIENT_SECRET_MAX_LIFETIME_SECONDS
  ) {
    throw new Error(
      "Apple client secret lifetime must be between 1 second and six months",
    );
  }
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({
    alg: "ES256",
    kid: credential.keyId,
    typ: "JWT",
  }));
  const payload = base64url(JSON.stringify({
    iss: credential.teamId,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    aud: "https://appleid.apple.com",
    sub: credential.serviceId,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(credential.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

export type AppleClientSecretSource = {
  /** The secret to present now, minted or reused. */
  current(now?: number): string;
};

/**
 * A cache of exactly one secret.
 *
 * Minting costs one ECDSA signature, so this is not about speed: it is about
 * the token endpoint seeing a stable value across the two or three requests one
 * sign-in burst makes, which keeps a rejected exchange attributable to one
 * secret rather than to whichever one happened to be minted for that request.
 */
export function createAppleClientSecretSource(
  credential: AppleSigningCredential,
  lifetimeSeconds = APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
): AppleClientSecretSource {
  let cached: { secret: string; renewAt: number } | null = null;
  return {
    current(now = Date.now()) {
      if (cached && now < cached.renewAt) return cached.secret;
      const secret = createAppleClientSecret(credential, now, lifetimeSeconds);
      cached = {
        secret,
        renewAt: now
          + (lifetimeSeconds - APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS) * 1000,
      };
      return secret;
    },
  };
}

/**
 * The complete Apple credential, or null when this deployment has none.
 * `config.ts` already refused a partially named one at startup.
 */
export function appleSigningCredential(
  config: ServerConfig,
): AppleSigningCredential | null {
  if (
    !config.appleServiceId
    || !config.appleTeamId
    || !config.appleKeyId
    || !config.applePrivateKey
  ) return null;
  return {
    serviceId: config.appleServiceId,
    teamId: config.appleTeamId,
    keyId: config.appleKeyId,
    privateKey: config.applePrivateKey,
  };
}
