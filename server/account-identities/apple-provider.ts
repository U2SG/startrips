import { and, eq } from "drizzle-orm";
import type { OAuth2Tokens } from "better-auth/oauth2";
import { apple, type AppleOptions } from "better-auth/social-providers";
import { serverConfig, type ServerConfig } from "../config";
import { db } from "../db/client";
import { account as authAccount, user as authUser } from "../db/auth-schema";
import {
  appleSigningCredential,
  createAppleClientSecretSource,
} from "./apple-client-secret";
import { consumeVerifiedIdToken } from "./id-token-consumption";
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
 * #350: the account this Apple subject is ALREADY bound to, if any.
 *
 * Apple sends `email` only on the very first authorization. Every later one
 * carries the stable `sub` and nothing else, and the pinned 1.6.23
 * `api/routes/callback.mjs` refuses `!userInfo.email` with `email_not_found`
 * BEFORE it looks the provider account up -- so without this, a returning
 * Apple user could never sign in again, which #350's second acceptance bullet
 * forbids ("後續缺少姓名/郵箱仍可憑既有 subject 登入").
 *
 * The lookup is keyed on the account row `(providerId, accountId)` and on
 * nothing else. It never queries by email, so it cannot become the
 * auto-link-by-email path #345/#350 forbid: an unknown subject finds no row,
 * the claims are returned untouched and `email_not_found` still stands. The
 * email it hands back is the bound user's OWN address, so the identity is
 * resolved by subject and the address only satisfies the library's gate.
 *
 * Only the sign-in resolution needs it. The callback's `link` branch runs
 * earlier and compares the claim to the linking account's own address, but
 * `/link-social` is in `STARTRIPS_DISABLED_IDENTITY_PATHS` and
 * `accountLinking.enabled` is false, so that branch is unreachable here.
 */
async function boundIdentityEmail(
  subject: string,
): Promise<{ email: string; emailVerified: boolean } | null> {
  const [row] = await db
    .select({ email: authUser.email, emailVerified: authUser.emailVerified })
    .from(authAccount)
    .innerJoin(authUser, eq(authUser.id, authAccount.userId))
    .where(and(
      eq(authAccount.providerId, APPLE_PROVIDER_ID),
      eq(authAccount.accountId, subject),
    ))
    .limit(1);
  if (!row?.email) return null;
  // The user's own stored flag, not `true`: `handleOAuthUserInfo` lifts
  // `user.emailVerified` when a verified provider claim arrives for the same
  // address, and this authorization carried no claim at all. Echoing the
  // stored value keeps that comparison a no-op in both directions, so no
  // verification is granted that Apple did not assert.
  return { email: row.email, emailVerified: Boolean(row.emailVerified) };
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
    // #350 owner decision B. This override exists only for the direct
    // `/sign-in/social` `idToken` path: the pinned 1.6.23 router calls
    // `verifyIdToken` there and nowhere else that is reachable here --
    // `api/routes/callback.mjs` calls only `getUserInfo`, and the other caller,
    // `/link-social`, is in `STARTRIPS_DISABLED_IDENTITY_PATHS`. So the
    // authorization-code flow, which is already single-use through its own
    // `code` and `state`, is untouched, and the path that has no such
    // protection gains it.
    //
    // The adapter's own checks run FIRST, through the base provider built
    // without this override, so there is no recursion and a token that fails
    // signature, issuer, audience, age or nonce never reaches the store. That
    // ordering is what keeps a forged token from occupying the digest a
    // genuine one would later need.
    async verifyIdToken(token: string, nonce?: string) {
      let verified = false;
      try {
        verified = await baseProvider.verifyIdToken(token, nonce);
      } catch {
        verified = false;
      }
      if (!verified) return false;
      const consumed = await consumeVerifiedIdToken({
        providerId: APPLE_PROVIDER_ID,
        token,
      });
      if (!consumed) {
        // Either a replay or an unusable replay store. Both are refusals of
        // this token and of nothing else: no session is revoked, no account is
        // marked, and a freshly issued token for the same subject still signs
        // that subject in.
        console.warn("provider_id_token_replayed", { providerId: APPLE_PROVIDER_ID });
      }
      return consumed;
    },
    async getUserInfo(tokens) {
      const info = await verifiedUserInfo(baseProvider, tokens);
      const subject = info?.user?.id === undefined ? "" : String(info.user.id);
      if (info && subject && (info.user.email ?? null) === null) {
        // A returning authorization that carried no email. Recover the bound
        // account by subject, or leave the refusal in place.
        const bound = await boundIdentityEmail(subject);
        if (!bound) return info;
        // Deliberately NO `rememberVerifiedProviderIdentity` here. This
        // callback refreshes the stored tokens of an existing account, which
        // fires `databaseHooks.account.update.after`; a pending identity
        // carrying `email: null, emailVerified: false` would overwrite the
        // ownership row's `providerEmail`/`providerEmailVerified` and
        // downgrade a previously verified method to unusable -- the exact
        // last-usable-fallback protection #345 asks for. Apple retracted
        // nothing by staying silent, so the recorded claim stays as it was:
        // the hook finds no pending identity and writes nothing.
        return {
          ...info,
          user: { ...info.user, email: bound.email, emailVerified: bound.emailVerified },
        };
      }
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
