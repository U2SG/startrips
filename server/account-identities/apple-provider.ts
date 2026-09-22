import type { OAuth2Tokens } from "better-auth/oauth2";
import { apple, type AppleOptions } from "better-auth/social-providers";
import { serverConfig, type ServerConfig } from "../config";
import {
  appleSigningCredential,
  createAppleClientSecretSource,
} from "./apple-client-secret";
import {
  APPLE_PROVIDER_ID,
  rememberVerifiedProviderIdentity,
} from "./social-providers";

export { APPLE_PROVIDER_ID };

/**
 * #350: the Apple half of the ST-067 identity contract, shaped exactly like
 * #349's Google half in `social-providers.ts`.
 *
 * Better Auth owns the authorization request, `state`, the `form_post`
 * callback and the token exchange. It does NOT own the ID-token checks by
 * itself: the pinned 1.6.23 `apple` adapter splits them the same way the
 * `google` one does -- `verifyIdToken()` runs `jwtVerify()` against Apple's
 * JWKS with Apple's issuer, this audience and a one-hour maximum token age,
 * while `getUserInfo()` merely `decodeJwt()`s the same string, and
 * `api/routes/callback.mjs` calls only `getUserInfo()`. So this module runs the
 * verification half first and refuses the callback when it fails, then carries
 * the verified identity across to Startrips' own `account_identity_ownerships`
 * row through the shared pending-identity bridge.
 *
 * Scopes are left at the adapter's defaults (`email`, `name`). Apple sends the
 * name only on the very first authorization and only as a form field, so
 * widening scopes here would buy nothing the identity contract uses.
 */
function appleBaseOptions(config: ServerConfig): AppleOptions | null {
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

type AppleAdapter = ReturnType<typeof apple>;

/**
 * The adapter's ID-token claims, but only once the adapter has verified them.
 *
 * Everything Startrips then persists comes from those claims: the subject an
 * ownership row is keyed by, and the verified-email flag
 * `accountIdentityUsable` reads.
 */
async function verifiedUserInfo(adapter: AppleAdapter, tokens: OAuth2Tokens) {
  const idToken = tokens.idToken;
  if (!idToken || typeof adapter.verifyIdToken !== "function") return null;
  let verified = false;
  try {
    // No nonce: the pinned adapter's `createAuthorizationURL` does not send
    // one, so there is none to bind the token back to. `verifyIdToken` still
    // checks issuer, audience and token age, and it compares a nonce whenever
    // one IS supplied -- which is what the fake-provider suite exercises.
    verified = await adapter.verifyIdToken(idToken, undefined);
  } catch {
    verified = false;
  }
  if (!verified) {
    // The token is itself a bearer credential, so only the provider it
    // belonged to is safe to record.
    console.error("provider_id_token_verification_failed", {
      providerId: APPLE_PROVIDER_ID,
    });
    return null;
  }
  return await adapter.getUserInfo(tokens);
}

/**
 * The options handed to `betterAuth({ socialProviders })`.
 *
 * The returned object is built field by field rather than spread from `base`:
 * spreading would READ the `clientSecret` getter once and freeze a ten-minute
 * JWT into a process-lifetime field, which is the silent months-later outage
 * `apple-client-secret.ts` exists to prevent. The base adapter is built from
 * options WITHOUT `getUserInfo`, which is what keeps the delegation below from
 * recursing into itself.
 *
 * `disableImplicitSignUp` keeps the three intents three, exactly as #349 does
 * for Google: without it the pinned callback lets an unrecognised Apple subject
 * arriving through the SIGN-IN button silently register a new Startrips user
 * and Atlas. Registration then happens only when the caller asked for it.
 */
export function appleSignInOptions(
  config: ServerConfig = serverConfig,
): AppleOptions | null {
  const base = appleBaseOptions(config);
  if (!base) return null;
  const baseProvider = apple(base);
  return {
    clientId: base.clientId,
    audience: base.audience,
    get clientSecret() {
      return base.clientSecret;
    },
    disableImplicitSignUp: true,
    async getUserInfo(tokens) {
      const info = await verifiedUserInfo(baseProvider, tokens);
      const subject = info?.user?.id === undefined ? "" : String(info.user.id);
      if (info && subject) {
        const email = info.user.email ?? null;
        rememberVerifiedProviderIdentity({
          providerId: APPLE_PROVIDER_ID,
          subject,
          email,
          // An unverified or absent provider email must never present as a
          // verified one: `accountIdentityUsable` reads this flag directly.
          // A Hide My Email relay address is verified BY Apple, so it arrives
          // true here; what must never happen is it matching an existing
          // account by address, which the disabled implicit-linking policy in
          // `auth.ts` is what prevents.
          emailVerified: Boolean(info.user.emailVerified) && email !== null,
        });
      }
      return info;
    },
  };
}
