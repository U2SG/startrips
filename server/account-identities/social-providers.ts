import type { OAuth2Tokens } from "better-auth/oauth2";
import { google, type GoogleOptions } from "better-auth/social-providers";
import { serverConfig, type ServerConfig } from "../config";
import { appleSigningCredential } from "./apple-client-secret";
import { consumeVerifiedIdToken } from "./id-token-consumption";
import type { VerifiedProviderIdentity } from "./provider-proof";

export const GOOGLE_PROVIDER_ID = "google";
// #350: declared here rather than in `apple-provider.ts` so this module stays
// the one provider registry. `apple-provider.ts` re-exports it and imports the
// pending-identity bridge from here, which keeps the dependency one-way.
export const APPLE_PROVIDER_ID = "apple";

/**
 * #349: the provider half of the ST-067 identity contract.
 *
 * Better Auth owns the authorization request, state, PKCE and the token
 * exchange. It does NOT own the ID-token checks by itself: the pinned 1.6.23
 * adapter splits them in two, and `api/routes/callback.mjs` calls only the
 * half that skips them. This module decides WHETHER that adapter exists for a
 * deployment, runs the other half before any claim is believed, and carries
 * the verified identity across to Startrips' own
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

type GoogleAdapter = ReturnType<typeof google>;

/**
 * The adapter's ID-token claims, but only once the adapter has verified them.
 *
 * In the pinned Better Auth 1.6.23, `verifyIdToken()` runs `jwtVerify()`
 * against Google's JWKS with Google's issuer, this client as the audience and
 * a one-hour maximum token age, while `getUserInfo()` merely `decodeJwt()`s
 * the same string -- and `api/routes/callback.mjs` calls just `getUserInfo()`
 * after the code exchange. Everything Startrips then persists comes from those
 * claims: the subject an ownership row is keyed by, and the verified-email flag
 * `accountIdentityUsable` reads. So both entries -- the native sign-in wrapper
 * below and the explicit bind adapter further down -- run the verification
 * half first and refuse the callback when it fails, per #349's requirement
 * that issuer/audience/subject be validated by the pinned library.
 */
async function verifiedUserInfo(adapter: GoogleAdapter, tokens: OAuth2Tokens) {
  const idToken = tokens.idToken;
  if (!idToken || typeof adapter.verifyIdToken !== "function") return null;
  let verified = false;
  try {
    // No nonce: the pinned adapter's authorization request does not send one,
    // so there is none to bind the token back to.
    verified = await adapter.verifyIdToken(idToken, undefined);
  } catch {
    verified = false;
  }
  if (!verified) {
    // The token is itself a bearer credential, so only the provider it
    // belonged to is safe to record.
    console.error("provider_id_token_verification_failed", {
      providerId: GOOGLE_PROVIDER_ID,
    });
    return null;
  }
  return await adapter.getUserInfo(tokens);
}

/**
 * The options handed to `betterAuth({ socialProviders })`.
 *
 * `getUserInfo` wraps rather than replaces the pinned adapter's own
 * implementation, so the profile mapping and hosted-domain rule stay Better
 * Auth's; the wrapper only remembers the result. The base adapter is built
 * from options WITHOUT `getUserInfo`, which is what keeps the delegation from
 * recursing into itself.
 *
 * `disableImplicitSignUp` is what keeps #349's three intents three. Without
 * it, the pinned 1.6.23 callback computes
 * `disableSignUp = provider.disableImplicitSignUp && !requestSignUp`, which is
 * falsy, so an unrecognised Google subject arriving through the SIGN-IN button
 * silently registers a new Startrips user and Atlas. With it, registration
 * happens only when the caller asked for it: `/sign-in/social` carries
 * `requestSignUp` into the OAuth state, and the callback reads it back out.
 * Not `disableSignUp`, which would refuse registration outright and leave
 * Google sign-up impossible.
 */
export function googleSignInOptions(config: ServerConfig = serverConfig): GoogleOptions | null {
  const base = googleBaseOptions(config);
  if (!base) return null;
  const baseProvider = google(base);
  return {
    ...base,
    disableImplicitSignUp: true,
    // #528: the same one-time consumption `apple-provider.ts` runs, for the
    // same reason and on the same single path. The pinned 1.6.23
    // `api/routes/sign-in.mjs` calls `verifyIdToken` for the direct
    // `/sign-in/social` `idToken` body and nowhere else reachable here:
    // `api/routes/callback.mjs` calls only `getUserInfo`, and `/link-social`
    // is in `STARTRIPS_DISABLED_IDENTITY_PATHS`. So the authorization-code
    // flow keeps being single-use through its own `code` and `state`, and the
    // path that has no such protection stops accepting the same still-valid
    // token twice.
    //
    // The adapter's own checks run FIRST, through the base provider built
    // without this override -- which is also what keeps the pinned adapter
    // from short-circuiting into this function (it prefers
    // `options.verifyIdToken` over its own implementation). A token that
    // fails signature, issuer, audience, age or nonce therefore never reaches
    // the store, so it cannot occupy the digest a genuine one would need.
    //
    // `nonce` is forwarded rather than dropped: the pinned adapter compares it
    // to the token's own claim whenever a caller supplies one, and swallowing
    // it here would silently retire that check on the very path this override
    // exists to harden.
    async verifyIdToken(token: string, nonce?: string) {
      let verified = false;
      try {
        verified = await baseProvider.verifyIdToken(token, nonce);
      } catch {
        verified = false;
      }
      if (!verified) return false;
      const consumed = await consumeVerifiedIdToken({
        providerId: GOOGLE_PROVIDER_ID,
        token,
      });
      if (!consumed) {
        // Either a replay or an unusable replay store. Both refuse this token
        // and nothing else: no session is revoked, no account is marked, and a
        // freshly issued token for the same subject still signs that subject
        // in.
        console.warn("provider_id_token_replayed", { providerId: GOOGLE_PROVIDER_ID });
      }
      return consumed;
    },
    async getUserInfo(tokens) {
      const info = await verifiedUserInfo(baseProvider, tokens);
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
 * carries its verified identity in an ST-067 provider proof instead. Its
 * `getUserInfo` is the verifying one for the same reason the sign-in wrapper's
 * is -- the bind proof names a subject, so an unverified subject would be a
 * bind of whoever authored the token.
 */
export function createBindProvider(
  providerId: string,
  config: ServerConfig = serverConfig,
): IdentityBindProvider | null {
  if (providerId !== GOOGLE_PROVIDER_ID) return null;
  const base = googleBaseOptions(config);
  if (!base) return null;
  const adapter = google(base);
  return {
    createAuthorizationURL: adapter.createAuthorizationURL,
    validateAuthorizationCode: adapter.validateAuthorizationCode,
    getUserInfo: (tokens) => verifiedUserInfo(adapter, tokens),
  };
}

/**
 * Every provider this deployment can complete a SIGN-IN with.
 *
 * Derived from the same credentials the adapters are derived from, so the
 * identity surface can never advertise a login with no provider behind it.
 * Binding is a strictly narrower question -- see `createBindProvider`.
 */
export function configuredSocialProviderIds(
  config: ServerConfig = serverConfig,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (googleBaseOptions(config)) ids.add(GOOGLE_PROVIDER_ID);
  if (appleSigningCredential(config)) ids.add(APPLE_PROVIDER_ID);
  return ids;
}

/**
 * The providers an EXISTING account may additionally bind, which is not the
 * same set as the one above.
 *
 * Apple is deliberately absent. Its authorization returns with
 * `response_mode=form_post`, i.e. a cross-site POST, and three things in the
 * #349 bind flow assume a same-site GET: the callback route is a GET reading
 * `context.req.query`, `IDENTITY_BIND_COOKIE` is `SameSite=Lax` and so is not
 * sent on a cross-site POST at all, and the pinned `apple`
 * `createAuthorizationURL` never forwards `codeVerifier` while the shared
 * exchange sends `code_verifier` whenever one is present. Advertising apple
 * here would render a bind button that cannot succeed, so it stays out until
 * that path is built.
 */
export function bindableSocialProviderIds(
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
