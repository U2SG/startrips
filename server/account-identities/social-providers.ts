import type { OAuth2Tokens } from "better-auth/oauth2";
import {
  apple,
  google,
  type AppleOptions,
  type GoogleOptions,
} from "better-auth/social-providers";
import { serverConfig, type ServerConfig } from "../config";
import {
  appleSigningCredential,
  createAppleClientSecretSource,
} from "./apple-client-secret";
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
 * #350: the Apple adapter options, shared by `apple-provider.ts`'s sign-in
 * wrapper and the #504 bind adapter below. It lives here rather than in
 * `apple-provider.ts` because that module imports this one and the bind
 * registry needs it too; keeping it here keeps the dependency one-way.
 */
export function appleBaseOptions(config: ServerConfig): AppleOptions | null {
  const credential = appleSigningCredential(config);
  if (!credential) return null;
  const secrets = createAppleClientSecretSource(credential);
  // The audience an id token is checked against. The Service id is the web
  // client; the bundle identifier is listed alongside it only when a
  // deployment names one, so an unconfigured native app can never widen what
  // this server accepts.
  const audience = config.appleAppBundleIdentifier
    ? [credential.serviceId, config.appleAppBundleIdentifier]
    : [credential.serviceId];
  return {
    clientId: credential.serviceId,
    audience,
    // A getter, not a value. The pinned adapter reads `options.clientSecret`
    // at the moment it builds the token request (see
    // `oauth2/validate-authorization-code`), and neither the adapter nor
    // `createAuthContext` copies the options object, so every exchange gets a
    // secret minted against the current clock. A field assigned once at
    // startup would instead expire while the process kept running -- exactly
    // the failure #350 asks to be designed out rather than documented around.
    get clientSecret() {
      return secrets.current();
    },
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

/** The two halves of a pinned adapter that `verifiedUserInfo` joins. */
type IdTokenAdapter<Info> = {
  verifyIdToken?: (token: string, nonce?: string) => Promise<boolean>;
  getUserInfo: (tokens: OAuth2Tokens) => Promise<Info>;
};

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
 * that issuer/audience/subject be validated by the pinned library. The pinned
 * `apple` adapter splits them the same way, so `apple-provider.ts` and the
 * #504 Apple bind adapter run this same function.
 */
export async function verifiedUserInfo<Info>(
  adapter: IdTokenAdapter<Info>,
  providerId: string,
  tokens: OAuth2Tokens,
): Promise<Info | null> {
  const idToken = tokens.idToken;
  if (!idToken || typeof adapter.verifyIdToken !== "function") return null;
  let verified = false;
  try {
    // No nonce: neither pinned adapter's authorization request sends one, so
    // there is none to bind the token back to. `verifyIdToken` still checks
    // issuer, audience and token age, and compares a nonce whenever one IS
    // supplied.
    verified = await adapter.verifyIdToken(idToken, undefined);
  } catch {
    verified = false;
  }
  if (!verified) {
    // The token is itself a bearer credential, so only the provider it
    // belonged to is safe to record.
    console.error("provider_id_token_verification_failed", { providerId });
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
      const info = await verifiedUserInfo(baseProvider, GOOGLE_PROVIDER_ID, tokens);
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
 *
 * #504: `pkce` is the per-provider PKCE opt-out. The route mints, stores and
 * forwards a code verifier only when it is true. The pinned `apple`
 * `createAuthorizationURL` never sends a `code_challenge`, while the shared
 * token exchange writes `code_verifier` whenever it is handed one, so a
 * verifier sent to Apple is one Apple has no challenge to check it against.
 * Apple's code is bound instead by `state` and by the client-secret assertion
 * only this server can mint.
 */
export type IdentityBindProvider = {
  pkce: boolean;
  createAuthorizationURL(input: {
    state: string;
    codeVerifier?: string;
    redirectURI: string;
  }): Promise<URL>;
  validateAuthorizationCode(input: {
    code: string;
    codeVerifier?: string;
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
 *
 * #504: the Apple adapter is `apple(base)` over the getter-carrying options,
 * never a spread of them, so every exchange mints its own client secret. It
 * verifies through the base adapter's own `verifyIdToken`, NOT the consuming
 * override `appleSignInOptions` adds: that one-time spend guards the direct
 * `idToken` sign-in path, and this authorization-code round trip is already
 * single-use through its `code`, its `state` and the one-round-trip cookie.
 */
export function createBindProvider(
  providerId: string,
  config: ServerConfig = serverConfig,
): IdentityBindProvider | null {
  if (providerId === GOOGLE_PROVIDER_ID) {
    const base = googleBaseOptions(config);
    if (!base) return null;
    const adapter = google(base);
    return {
      pkce: true,
      createAuthorizationURL: adapter.createAuthorizationURL,
      validateAuthorizationCode: adapter.validateAuthorizationCode,
      getUserInfo: (tokens) => verifiedUserInfo(adapter, GOOGLE_PROVIDER_ID, tokens),
    };
  }
  if (providerId === APPLE_PROVIDER_ID) {
    const base = appleBaseOptions(config);
    if (!base) return null;
    const adapter = apple(base);
    return {
      pkce: false,
      createAuthorizationURL: adapter.createAuthorizationURL,
      validateAuthorizationCode: adapter.validateAuthorizationCode,
      getUserInfo: (tokens) => verifiedUserInfo(adapter, APPLE_PROVIDER_ID, tokens),
    };
  }
  return null;
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
 * The providers an EXISTING account may additionally bind.
 *
 * #504: the same set as the one above again, but for its own reason rather
 * than by coincidence. Apple's authorization returns with
 * `response_mode=form_post`, a cross-site POST, and the bind round trip now
 * receives it: the callback route accepts a POST body, `IDENTITY_BIND_COOKIE`
 * is `SameSite=None; Secure` so the browser sends it on that POST, and the
 * Apple bind adapter opts out of PKCE. A provider added later belongs here
 * only once `createBindProvider` can complete its round trip.
 */
export function bindableSocialProviderIds(
  config: ServerConfig = serverConfig,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (googleBaseOptions(config)) ids.add(GOOGLE_PROVIDER_ID);
  if (appleSigningCredential(config)) ids.add(APPLE_PROVIDER_ID);
  return ids;
}

/**
 * The bind flow's redirect target. It is a SECOND redirect URI a deployment
 * must register with the provider, distinct from Better Auth's own
 * `/api/auth/callback/<provider>` sign-in target: an authorized redirect URI
 * on the Google OAuth client, a Return URL on the Apple Service id.
 * `deploy/README.md` and `docs/architecture/apple-sign-in.md` say so.
 */
export function identityBindRedirectUri(
  providerId: string,
  config: ServerConfig = serverConfig,
): string {
  return `${config.appOrigin}/api/account-identities/providers/${providerId}/callback`;
}
