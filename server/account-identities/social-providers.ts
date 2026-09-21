import type { OAuth2Tokens } from "better-auth/oauth2";
import { google, type GoogleOptions } from "better-auth/social-providers";
import { serverConfig, type ServerConfig } from "../config";
import type { VerifiedProviderIdentity } from "./provider-proof";

export const GOOGLE_PROVIDER_ID = "google";

/**
 * #349: the provider half of the ST-067 identity contract.
 *
 * Better Auth owns every OIDC check for the pinned 1.6.23 Google adapter --
 * issuer, audience, state, PKCE and the token exchange. This module only
 * decides WHETHER that adapter exists for a deployment, and carries the
 * verified identity the adapter already produced across to Startrips' own
 * `account_identity_ownerships` row.
 *
 * Scopes are deliberately not configured. The adapter's own defaults are
 * `email`, `profile` and `openid`, which is exactly the identity material
 * sign-in needs; adding `scope` here would only ever widen them.
 */
function googleBaseOptions(config: ServerConfig): GoogleOptions | null {
  if (!config.googleClientId || !config.googleClientSecret) return null;
  return {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  };
}

/**
 * Identities Better Auth verified during a sign-in callback that is still in
 * flight, keyed by the provider subject the callback is about.
 *
 * `databaseHooks.account.create.after` runs after the creating transaction
 * commits and receives only the persisted account row, which carries no email
 * or verification claim. Rather than decoding the stored id token a second
 * time, the wrapped `getUserInfo` below hands the claim set Better Auth itself
 * produced to the hook, which consumes it by that same subject. The entry is
 * short-lived and single-use: a hook that finds nothing records no ownership,
 * so the method reads as unusable rather than as verified-by-assumption.
 */
const PENDING_IDENTITY_TTL_MS = 60_000;

type PendingIdentity = { identity: VerifiedProviderIdentity; recordedAt: number };

const pendingIdentities = new Map<string, PendingIdentity>();

function pendingKey(providerId: string, subject: string): string {
  return JSON.stringify([providerId, subject]);
}

function prunePendingIdentities(now: number) {
  for (const [key, entry] of pendingIdentities) {
    if (now - entry.recordedAt > PENDING_IDENTITY_TTL_MS) pendingIdentities.delete(key);
  }
}

export function rememberVerifiedProviderIdentity(
  identity: VerifiedProviderIdentity,
  now = Date.now(),
) {
  prunePendingIdentities(now);
  pendingIdentities.set(pendingKey(identity.providerId, identity.subject), {
    identity,
    recordedAt: now,
  });
}

export function takeVerifiedProviderIdentity(
  providerId: string,
  subject: string,
  now = Date.now(),
): VerifiedProviderIdentity | null {
  prunePendingIdentities(now);
  const key = pendingKey(providerId, subject);
  const entry = pendingIdentities.get(key);
  if (!entry) return null;
  pendingIdentities.delete(key);
  return entry.identity;
}

/**
 * The options handed to `betterAuth({ socialProviders })`.
 *
 * `getUserInfo` wraps rather than replaces the pinned adapter's own
 * implementation, so the profile mapping and hosted-domain rule stay Better
 * Auth's; the wrapper only remembers the result. The base adapter is built
 * from options WITHOUT `getUserInfo`, which is what keeps the delegation from
 * recursing into itself.
 */
export function googleSignInOptions(config: ServerConfig = serverConfig): GoogleOptions | null {
  const base = googleBaseOptions(config);
  if (!base) return null;
  const baseProvider = google(base);
  return {
    ...base,
    async getUserInfo(tokens) {
      const info = await baseProvider.getUserInfo(tokens);
      const subject = info?.user?.id === undefined ? "" : String(info.user.id);
      if (info && subject) {
        const email = info.user.email ?? null;
        rememberVerifiedProviderIdentity({
          providerId: GOOGLE_PROVIDER_ID,
          subject,
          email,
          // An unverified or absent provider email must never present as a
          // verified one: `accountIdentityUsable` reads this flag directly.
          emailVerified: Boolean(info.user.emailVerified) && email !== null,
        });
      }
      return info;
    },
  };
}

/**
 * The three operations the explicit bind flow needs from a provider adapter.
 * Narrower than the pinned adapter on purpose: it is the seam a fake OAuth
 * transport substitutes in CI, and it cannot express a sign-in.
 */
export type IdentityBindProvider = {
  createAuthorizationURL(input: {
    state: string;
    codeVerifier: string;
    redirectURI: string;
  }): Promise<URL>;
  validateAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectURI: string;
  }): Promise<OAuth2Tokens | null>;
  getUserInfo(tokens: OAuth2Tokens): Promise<{
    user: { id: string | number; email?: string | null; emailVerified: boolean };
  } | null>;
};

/**
 * The adapter the explicit bind flow drives directly. It is built from the
 * plain options, so a bind never writes a pending sign-in identity: that path
 * carries its verified identity in an ST-067 provider proof instead.
 */
export function createBindProvider(
  providerId: string,
  config: ServerConfig = serverConfig,
): IdentityBindProvider | null {
  if (providerId !== GOOGLE_PROVIDER_ID) return null;
  const base = googleBaseOptions(config);
  return base ? google(base) : null;
}

export function configuredSocialProviderIds(
  config: ServerConfig = serverConfig,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (googleBaseOptions(config)) ids.add(GOOGLE_PROVIDER_ID);
  return ids;
}

/**
 * The bind flow's redirect target. It is a SECOND redirect URI a deployment
 * must register with Google, distinct from Better Auth's own
 * `/api/auth/callback/google` sign-in target; `deploy/README.md` says so.
 */
export function identityBindRedirectUri(
  providerId: string,
  config: ServerConfig = serverConfig,
): string {
  return `${config.appOrigin}/api/account-identities/providers/${providerId}/callback`;
}
