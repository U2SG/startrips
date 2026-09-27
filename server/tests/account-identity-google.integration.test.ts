import { execFile } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * #349 (ST-132): Google sign-in and explicit binding, against a fake OAuth
 * transport.
 *
 * Two things make this file look unlike its siblings.
 *
 * The credentials are set BEFORE the app is imported, and the app is therefore
 * imported dynamically: `server/config.ts` reads the environment exactly once
 * at module load, and a provider that is absent from that read is absent from
 * `betterAuth()` entirely -- which is the behaviour the rest of the suite
 * exercises. Configuring it here is how this file gets the other half.
 *
 * The transport is a global `fetch` stub that answers Google's token endpoint
 * and its JWKS document, and THROWS on any other external host, so a
 * regression that reaches the real network fails loudly instead of quietly
 * depending on it. Everything above the transport -- state, PKCE, the
 * authorization URL, the profile mapping -- is the pinned Better Auth 1.6.23
 * adapter doing its own work.
 *
 * The ID tokens are really RS256-signed against a keypair generated here and
 * published through that JWKS document, because the claims are not believed on
 * the strength of the TLS channel: `social-providers.ts` runs the adapter's
 * `verifyIdToken()` first. A test issuing unsigned tokens would therefore
 * prove nothing, and the wrong-signature/audience/issuer cases below are the
 * regressions for that check.
 */
const TEST_CLIENT_ID = "st132-test-client.apps.googleusercontent.test";
process.env.GOOGLE_CLIENT_ID = TEST_CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = "st132-test-client-secret";

const { createEmailVerificationToken } = await import("better-auth/api");
const { app } = await import("../app");
const { auth } = await import("../auth");
const { serverConfig } = await import("../config");
const {
  atlases,
  accountIdentityAudit,
  accountIdentityOwnerships,
  providerIdTokenConsumptions,
} = await import("../db/app-schema");
const { GOOGLE_PROVIDER_ID } = await import("../account-identities/social-providers");
const { consumeVerifiedIdToken, idTokenDigest } = await import(
  "../account-identities/id-token-consumption"
);
const {
  account: authAccount,
  member: authMember,
  organization: authOrganization,
  rateLimit,
  session: authSession,
  user: authUser,
} = await import("../db/auth-schema");
const { db, pool } = await import("../db/client");

const ORIGIN = serverConfig.appOrigin;
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const PASSWORD = "st132-test-password-349";
const SIGNING_KEY_ID = "st132-test-key";

/** The key Google publishes, and one it does not. */
const signingKeys = {
  published: generateKeyPairSync("rsa", { modulusLength: 2048 }),
  unpublished: generateKeyPairSync("rsa", { modulusLength: 2048 }),
};

/** What an ID token may claim other than the truth, one case per regression. */
type TokenClaimOverrides = {
  audience?: string;
  issuer?: string;
  signWith?: keyof typeof signingKeys;
  /**
   * #528. `issuedAt` is what makes two tokens for one subject distinguishable
   * -- a different `iat` is a different string and therefore a different
   * consumption digest -- and, moved far enough back, what makes a token stale
   * past the adapter's own one-hour maximum age. `nonce` is the claim the
   * pinned adapter compares against the one the caller presents.
   */
  issuedAt?: number;
  nonce?: string;
};

type TokenAnswer =
  | {
    kind: "tokens";
    subject: string;
    email: string;
    emailVerified: boolean;
    overrides?: TokenClaimOverrides;
  }
  | { kind: "unavailable" };

let tokenAnswer: TokenAnswer | null = null;
const createdUserIds: string[] = [];
const createdOrganizationIds: string[] = [];

const realFetch = globalThis.fetch;

function fakeIdToken(
  subject: string,
  email: string,
  emailVerified: boolean,
  overrides: TokenClaimOverrides = {},
): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = overrides.issuedAt ?? Math.floor(Date.now() / 1000);
  const signingInput = [
    segment({ alg: "RS256", kid: SIGNING_KEY_ID }),
    segment({
      iss: overrides.issuer ?? "https://accounts.google.com",
      aud: overrides.audience ?? TEST_CLIENT_ID,
      sub: subject,
      email,
      email_verified: emailVerified,
      name: "Startrips tester",
      picture: "https://example.test/avatar.png",
      iat: issuedAt,
      exp: issuedAt + 3600,
      ...(overrides.nonce ? { nonce: overrides.nonce } : {}),
    }),
  ].join(".");
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(signingKeys[overrides.signWith ?? "published"].privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Google's published signing keys, as the adapter's JWKS fetch expects them. */
function jwksDocument(): Response {
  const jwk = signingKeys.published.publicKey.export({ format: "jwk" });
  return Response.json({
    keys: [{ ...jwk, kid: SIGNING_KEY_ID, alg: "RS256", use: "sig" }],
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL ? input.toString() : input.url;
  // Answered unconditionally: it is a public document, and every ID token the
  // pinned adapter verifies needs it.
  if (url.startsWith(JWKS_ENDPOINT)) return jwksDocument();
  if (!url.startsWith(TOKEN_ENDPOINT)) {
    throw new Error(`ST-132 test reached an unexpected external host: ${url}`);
  }
  if (!tokenAnswer) throw new Error("ST-132 test exchanged a code with no configured answer");
  if (tokenAnswer.kind === "unavailable") {
    return new Response("upstream unavailable", { status: 503 });
  }
  const body = String(init?.body ?? "");
  expect(body).toContain("grant_type=authorization_code");
  // PKCE is the adapter's, not ours: the verifier has to arrive at the token
  // endpoint or the exchange was built wrong.
  expect(body).toContain("code_verifier=");
  return Response.json({
    access_token: `st132-access-${randomUUID()}`,
    id_token: fakeIdToken(
      tokenAnswer.subject,
      tokenAnswer.email,
      tokenAnswer.emailVerified,
      tokenAnswer.overrides,
    ),
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid email profile",
  });
}) as typeof fetch;

function cookieHeader(...values: string[]): string {
  return values.filter(Boolean).join("; ");
}

function jarFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .filter((entry) => !entry.endsWith("="))
    .join("; ");
}

function bindCookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .find((entry) => entry.startsWith("startrips.identity_bind=")) ?? "";
}

function fragmentOf(location: string): URLSearchParams {
  return new URLSearchParams(location.slice(location.indexOf("#") + 1));
}

async function postJson(path: string, body: unknown, cookie: string) {
  return await app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Start a native Google sign-in and return what the callback will need. */
async function startSignIn(overrides: Record<string, unknown> = {}) {
  const response = await postJson("/api/auth/sign-in/social", {
    provider: "google",
    callbackURL: "/",
    errorCallbackURL: "/sign-in",
    disableRedirect: true,
    ...overrides,
  }, "");
  // Asserted rather than tolerated: `/sign-in/social` is rate limited, and a
  // throttled start would otherwise reach the callback with an empty state and
  // look exactly like the provider refusals asserted further down.
  expect(response.status).toBe(200);
  const payload = await response.json() as { url: string };
  return {
    response,
    state: new URL(payload.url).searchParams.get("state") ?? "",
    jar: jarFrom(response),
  };
}

async function finishSignIn(state: string, jar: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams({ state, code: `st132-code-${randomUUID()}`, ...query });
  return await app.request(`${ORIGIN}/api/auth/callback/google?${search}`, {
    headers: { cookie: jar },
  });
}

/**
 * #349 keeps registration and sign-in separate intents, and the provider is
 * configured with `disableImplicitSignUp`, so a caller has to say which one it
 * is. These two helpers exist rather than one with a flag so every test below
 * reads as the intent it is actually exercising: only `signUpWithGoogle` may
 * create an Account, and `signInWithGoogle` proves an existing subject still
 * resolves without asking to register.
 */
async function googleCallback(
  subject: string,
  email: string,
  emailVerified: boolean,
  overrides: TokenClaimOverrides | undefined,
  requestSignUp: boolean,
) {
  tokenAnswer = { kind: "tokens", subject, email, emailVerified, overrides };
  const started = await startSignIn(requestSignUp ? { requestSignUp: true } : {});
  const callback = await finishSignIn(started.state, started.jar);
  return { callback, sessionCookie: jarFrom(callback) };
}

function signInWithGoogle(
  subject: string,
  email: string,
  emailVerified = true,
  overrides?: TokenClaimOverrides,
) {
  return googleCallback(subject, email, emailVerified, overrides, false);
}

function signUpWithGoogle(
  subject: string,
  email: string,
  emailVerified = true,
  overrides?: TokenClaimOverrides,
) {
  return googleCallback(subject, email, emailVerified, overrides, true);
}

async function seedPasswordAccount() {
  const email = `st132-${randomUUID()}@example.test`;
  const signUp = await postJson("/api/auth/sign-up/email", {
    name: "ST-132 tester",
    email,
    password: PASSWORD,
  }, "");
  expect(signUp.status).toBe(200);
  const verification = await createEmailVerificationToken(serverConfig.authSecret, email);
  const verified = await app.request(
    `${ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(verification)}`,
  );
  expect(verified.status).toBe(200);
  const signIn = await postJson("/api/auth/sign-in/email", { email, password: PASSWORD }, "");
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0] ?? "";
  expect(cookie).toBeTruthy();
  const [user] = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
  createdUserIds.push(user!.id);
  return { email, userId: user!.id, cookie };
}

/** Walk the ST-067 pipeline up to the point a provider round trip is needed. */
async function openLinkIntent(cookie: string) {
  const reverify = await postJson(
    "/api/account-identities/reverify/password",
    { password: PASSWORD },
    cookie,
  );
  expect(reverify.status).toBe(200);
  const { reverificationToken } = await reverify.json() as { reverificationToken: string };
  const intent = await postJson(
    "/api/account-identities/link-intents",
    { providerId: "google", reverificationToken },
    cookie,
  );
  expect(intent.status).toBe(200);
  return await intent.json() as { actionId: string; intentToken: string };
}

async function authorizeBind(cookie: string, actionId: string, returnPath = "/account") {
  const response = await postJson(
    "/api/account-identities/providers/google/authorize",
    { actionId, returnPath },
    cookie,
  );
  if (response.status !== 200) return { response, state: "", bindCookie: "" };
  const { authorizationUrl } = await response.json() as { authorizationUrl: string };
  const authorize = new URL(authorizationUrl);
  expect(authorize.origin).toBe("https://accounts.google.com");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("redirect_uri"))
    .toBe(`${ORIGIN}/api/account-identities/providers/google/callback`);
  // Minimal scopes: identity only, nothing that reaches Drive or Photos.
  expect((authorize.searchParams.get("scope") ?? "").split(" ").sort())
    .toEqual(["email", "openid", "profile"]);
  // #504: the bind cookie is `SameSite=None; Secure` for every provider, so
  // Apple's cross-site form_post can carry it; this GET return keeps working
  // with it, which every bind case below exercises.
  const issued = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("startrips.identity_bind="));
  expect(issued).toMatch(/;\s*SameSite=None(?:;|$)/i);
  expect(issued).toMatch(/;\s*Secure(?:;|$)/i);
  return { response, state: authorize.searchParams.get("state") ?? "", bindCookie: bindCookieFrom(response) };
}

async function bindCallback(cookie: string, state: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams({ state, code: `st132-bind-${randomUUID()}`, ...query });
  return await app.request(
    `${ORIGIN}/api/account-identities/providers/google/callback?${search}`,
    { headers: { cookie }, redirect: "manual" },
  );
}

async function countAccounts(subject: string) {
  const rows = await db
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(and(eq(authAccount.providerId, "google"), eq(authAccount.accountId, subject)));
  return rows;
}

async function countOwnerships(subject: string) {
  return await db
    .select({ userId: accountIdentityOwnerships.userId, verified: accountIdentityOwnerships.providerEmailVerified })
    .from(accountIdentityOwnerships)
    .where(and(
      eq(accountIdentityOwnerships.providerId, "google"),
      eq(accountIdentityOwnerships.providerSubject, subject),
    ));
}

async function googleMethodUsable(sessionCookie: string): Promise<boolean | undefined> {
  const response = await app.request(`${ORIGIN}/api/account-identities`, {
    headers: { cookie: sessionCookie },
  });
  expect(response.status).toBe(200);
  const listed = await response.json() as { methods: { providerId: string; usable: boolean }[] };
  return listed.methods.find((method) => method.providerId === "google")?.usable;
}

async function trackGoogleUser(email: string) {
  const [user] = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
  if (user) createdUserIds.push(user.id);
  return user;
}

// Per test, not once: this file drives more sign-in starts and more email
// sign-ups than one rate-limit window allows, and a throttled request is a
// refusal for the wrong reason.
beforeEach(async () => {
  await db.delete(rateLimit);
});

afterEach(() => {
  tokenAnswer = null;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (createdOrganizationIds.length > 0) {
    await db.delete(atlases).where(inArray(atlases.organizationId, createdOrganizationIds));
    await db.delete(authMember).where(inArray(authMember.organizationId, createdOrganizationIds));
    await db.delete(authOrganization).where(inArray(authOrganization.id, createdOrganizationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(accountIdentityAudit).where(inArray(accountIdentityAudit.userId, createdUserIds));
    await db.delete(authUser).where(inArray(authUser.id, createdUserIds));
  }
  await pool.end();
});

describe("google sign-in", () => {
  it("creates one user, one account and one ownership, and initializes one atlas", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    const { callback, sessionCookie } = await signUpWithGoogle(subject, email);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    const user = await trackGoogleUser(email);
    expect(user).toBeTruthy();

    const accounts = await countAccounts(subject);
    expect(accounts).toHaveLength(1);
    // The ownership row is what every ST-067 usability decision reads. Without
    // it the method the person just signed in with would report unusable.
    const ownerships = await countOwnerships(subject);
    expect(ownerships).toHaveLength(1);
    expect(ownerships[0]!.userId).toBe(user!.id);
    expect(ownerships[0]!.verified).toBe(true);

    const identities = await app.request(`${ORIGIN}/api/account-identities`, {
      headers: { cookie: sessionCookie },
    });
    expect(identities.status).toBe(200);
    const listed = await identities.json() as {
      methods: { providerId: string; usable: boolean }[];
      availableLinkProviders: string[];
    };
    expect(listed.methods.find((method) => method.providerId === "google")?.usable).toBe(true);
    expect(listed.availableLinkProviders).toContain("google");

    // Onboarding is the client's existing organization -> atlas walk. It must
    // run once for a provider sign-up exactly as it does for an email one, and
    // a repeated bootstrap must not produce a second Atlas.
    const organization = await postJson("/api/auth/organization/create", {
      name: "ST-132 Atlas",
      slug: `st132-${randomUUID()}`,
    }, sessionCookie);
    expect(organization.status).toBe(200);
    const { id: organizationId } = await organization.json() as { id: string };
    createdOrganizationIds.push(organizationId);
    const activated = await postJson("/api/auth/organization/set-active", { organizationId }, sessionCookie);
    expect(activated.status).toBe(200);
    const activeCookie = cookieHeader(sessionCookie, jarFrom(activated));

    const first = await postJson("/api/atlases/bootstrap", {
      title: "ST-132",
      dedication: "",
    }, activeCookie);
    expect(first.status).toBe(201);
    const second = await postJson("/api/atlases/bootstrap", {
      title: "ST-132 again",
      dedication: "",
    }, activeCookie);
    expect(second.status).toBe(200);
    expect((await second.json() as { created: boolean }).created).toBe(false);
    const atlasRows = await db
      .select({ id: atlases.id })
      .from(atlases)
      .where(eq(atlases.organizationId, organizationId));
    expect(atlasRows).toHaveLength(1);
  });

  it("refuses to register an unrecognised subject that arrives through sign-in", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    // The sign-in button's call: no request to register.
    const refused = await signInWithGoogle(subject, email);

    expect(refused.callback.status).toBe(302);
    // The exact code `link-account.mjs` emits when the sign-up gate closes, so
    // this cannot pass on some other refusal that would also leave no rows.
    expect(refused.callback.headers.get("location") ?? "").toContain("error=signup_disabled");
    // Nothing was created and nothing half-created: no Startrips user, no
    // provider account row, and no ownership row the ST-067 layer could later
    // read as a usable method.
    expect(await countAccounts(subject)).toHaveLength(0);
    expect(await countOwnerships(subject)).toHaveLength(0);
    expect(
      await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email)),
    ).toHaveLength(0);
    expect(refused.sessionCookie).not.toContain("session_token");

    // The same subject through the sign-up button does register, exactly once,
    // which is what makes the two intents distinct rather than one disabled.
    const registered = await signUpWithGoogle(subject, email);
    expect(registered.callback.status).toBe(302);
    const user = await trackGoogleUser(email);
    expect(user).toBeTruthy();
    expect(await countAccounts(subject)).toHaveLength(1);
    expect(await countOwnerships(subject)).toHaveLength(1);
  });

  it("returns the same user for a later sign-in with the same subject", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    await signUpWithGoogle(subject, email);
    const user = await trackGoogleUser(email);

    // Plain sign-in, no request to register: an already known subject must
    // resolve back to the same user without the sign-up intent.
    const again = await signInWithGoogle(subject, email);
    expect(again.callback.status).toBe(302);
    const accounts = await countAccounts(subject);
    expect(accounts).toHaveLength(1);
    const ownerships = await countOwnerships(subject);
    expect(ownerships).toHaveLength(1);
    expect(ownerships[0]!.userId).toBe(user!.id);
    const users = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
    expect(users).toHaveLength(1);
  });

  it("leaves one identity behind when the callback is delivered twice", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    tokenAnswer = { kind: "tokens", subject, email, emailVerified: true };
    const started = await startSignIn({ requestSignUp: true });
    const first = await finishSignIn(started.state, started.jar);
    expect(first.status).toBe(302);
    await trackGoogleUser(email);

    // The same authorization state arriving a second time: the single-use
    // state Better Auth issued is already spent.
    const replay = await finishSignIn(started.state, started.jar);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("error=");
    expect(await countAccounts(subject)).toHaveLength(1);
    expect(await countOwnerships(subject)).toHaveLength(1);
    const users = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
    expect(users).toHaveLength(1);
  });

  it("creates one identity when two callbacks for the same subject race", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    tokenAnswer = { kind: "tokens", subject, email, emailVerified: true };
    const [left, right] = await Promise.all([
      startSignIn({ requestSignUp: true }),
      startSignIn({ requestSignUp: true }),
    ]);
    await Promise.all([
      finishSignIn(left.state, left.jar),
      finishSignIn(right.state, right.jar),
    ]);
    await trackGoogleUser(email);
    const users = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
    expect(users).toHaveLength(1);
    expect(await countAccounts(subject)).toHaveLength(1);
    expect(await countOwnerships(subject)).toHaveLength(1);
  });

  it("refuses a same-email subject that is not bound to the account", async () => {
    const existing = await seedPasswordAccount();
    const subject = `st132-sub-${randomUUID()}`;
    tokenAnswer = { kind: "tokens", subject, email: existing.email, emailVerified: true };
    const started = await startSignIn();
    const callback = await finishSignIn(started.state, started.jar);

    expect(callback.status).toBe(302);
    const location = callback.headers.get("location") ?? "";
    expect(location).toContain("error=account_not_linked");
    // No silent link, no second Startrips user for the same person.
    expect(await countAccounts(subject)).toHaveLength(0);
    expect(await countOwnerships(subject)).toHaveLength(0);
    const users = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, existing.email));
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(existing.userId);
  });

  // The pinned adapter's `getUserInfo` only decodes the ID token, so these
  // three cases are the whole reason `social-providers.ts` calls
  // `verifyIdToken` before anything believes a subject. Each one is a token
  // the token endpoint really returned over the transport; only the claims or
  // the signing key are wrong.
  for (const [name, overrides] of [
    ["is signed by a key Google does not publish", { signWith: "unpublished" }],
    ["names another audience", { audience: "st132-other-client.apps.googleusercontent.test" }],
    ["names another issuer", { issuer: "https://accounts.evil.test" }],
  ] as [string, TokenClaimOverrides][]) {
    it(`refuses a sign-in whose id token ${name}`, async () => {
      const subject = `st132-sub-${randomUUID()}`;
      const email = `st132-${randomUUID()}@example.test`;
      const { callback } = await signUpWithGoogle(subject, email, true, overrides);

      expect(callback.status).toBe(302);
      // The exact code, not merely "some error": it is the one
      // `callback.mjs` emits when `getUserInfo` returns null, so it is what
      // distinguishes the adapter refusing this token from any other refusal
      // that would also leave no rows behind.
      expect(callback.headers.get("location") ?? "")
        .toContain("error=unable_to_get_user_info");
      expect(await countAccounts(subject)).toHaveLength(0);
      expect(await countOwnerships(subject)).toHaveLength(0);
      const users = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
      expect(users).toHaveLength(0);
    });
  }

  it("lifts the google method once a later callback reports the email verified", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    const first = await signUpWithGoogle(subject, email, false);
    expect(first.callback.status).toBe(302);
    const user = await trackGoogleUser(email);
    expect(user).toBeTruthy();
    const unverified = await countOwnerships(subject);
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.verified).toBe(false);
    expect(await googleMethodUsable(first.sessionCookie)).toBe(false);

    // Better Auth creates that account row exactly once, so a recovery that
    // only ran on creation could never lift the method again.
    const second = await signInWithGoogle(subject, email, true);
    expect(second.callback.status).toBe(302);
    const verified = await countOwnerships(subject);
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verified).toBe(true);
    expect(verified[0]!.userId).toBe(user!.id);
    expect(await googleMethodUsable(second.sessionCookie)).toBe(true);
    // Recovered in place: no second user, no second account row.
    expect(await countAccounts(subject)).toHaveLength(1);
    const users = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(user!.id);
  });

  it("trusts only this deployment's own origin as a return target", async () => {
    // Better Auth validates `callbackURL` / `errorCallbackURL` with exactly this
    // predicate before it issues an authorization URL. Asserting the predicate
    // rather than a request is deliberate: 1.6.23 skips the URL half of its
    // origin middleware whenever `NODE_ENV=test`, so a request-level assertion
    // here would pass for the wrong reason and prove nothing about production.
    const context = await auth.$context;
    expect(context.isTrustedOrigin("/", { allowRelativePaths: true })).toBe(true);
    expect(context.isTrustedOrigin(`${ORIGIN}/account`, { allowRelativePaths: true })).toBe(true);
    expect(context.isTrustedOrigin("https://evil.test/collect", { allowRelativePaths: true })).toBe(false);
    expect(context.isTrustedOrigin(`${ORIGIN}.evil.test/collect`, { allowRelativePaths: true })).toBe(false);
  });
});

describe("explicit google bind", () => {
  let account: Awaited<ReturnType<typeof seedPasswordAccount>>;

  beforeAll(async () => {
    account = await seedPasswordAccount();
  });

  it("binds a subject through link-intents, the provider round trip and link/complete", async () => {
    const subject = `st132-bind-${randomUUID()}`;
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    expect(authorized.bindCookie).toBeTruthy();

    tokenAnswer = { kind: "tokens", subject, email: account.email, emailVerified: true };
    const callback = await bindCallback(
      cookieHeader(account.cookie, authorized.bindCookie),
      authorized.state,
    );
    expect(callback.status).toBe(302);
    const location = callback.headers.get("location") ?? "";
    expect(location.startsWith(`${ORIGIN}/account#`)).toBe(true);
    const fragment = fragmentOf(location);
    expect(fragment.get("identityLink")).toBe("proof");
    const providerProof = fragment.get("identityLinkProof") ?? "";
    expect(providerProof).toBeTruthy();

    const completed = await postJson("/api/account-identities/link/complete", {
      intentToken: intent.intentToken,
      providerProof,
    }, account.cookie);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: true, linked: true });
    expect(await countAccounts(subject)).toHaveLength(1);
    const ownerships = await countOwnerships(subject);
    expect(ownerships).toHaveLength(1);
    expect(ownerships[0]!.userId).toBe(account.userId);

    // A repeated completion is the same single-use action, so it reports the
    // work it already did rather than binding a second row.
    const repeated = await postJson("/api/account-identities/link/complete", {
      intentToken: intent.intentToken,
      providerProof,
    }, account.cookie);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ alreadyLinked: true });
    expect(await countAccounts(subject)).toHaveLength(1);
  });

  it("refuses an authorization that would return to another origin", async () => {
    const intent = await openLinkIntent(account.cookie);
    const rejected = await postJson(
      "/api/account-identities/providers/google/authorize",
      { actionId: intent.actionId, returnPath: "https://evil.test/collect" },
      account.cookie,
    );
    expect(rejected.status).toBe(400);
    expect(bindCookieFrom(rejected)).toBe("");
  });

  it("reports a cancelled authorization without binding anything", async () => {
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    const callback = await bindCallback(
      cookieHeader(account.cookie, authorized.bindCookie),
      authorized.state,
      { error: "access_denied", code: "" },
    );
    expect(callback.status).toBe(302);
    const fragment = fragmentOf(callback.headers.get("location") ?? "");
    expect(fragment.get("identityLink")).toBe("error");
    expect(fragment.get("identityLinkError")).toBe("IDENTITY_PROVIDER_REFUSED");
  });

  it("reports an interrupted token exchange", async () => {
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    tokenAnswer = { kind: "unavailable" };
    const callback = await bindCallback(
      cookieHeader(account.cookie, authorized.bindCookie),
      authorized.state,
    );
    expect(callback.status).toBe(302);
    const fragment = fragmentOf(callback.headers.get("location") ?? "");
    expect(fragment.get("identityLinkError")).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
  });

  it("refuses a second delivery of the same bind callback", async () => {
    const subject = `st132-bind-${randomUUID()}`;
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    tokenAnswer = { kind: "tokens", subject, email: account.email, emailVerified: true };
    const first = await bindCallback(
      cookieHeader(account.cookie, authorized.bindCookie),
      authorized.state,
    );
    expect(first.status).toBe(302);
    // The browser cleared the one-round-trip cookie on the first return, so a
    // resent redirect arrives without it and finds a spent flow.
    const replay = await bindCallback(account.cookie, authorized.state);
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ error: "IDENTITY_BIND_STATE_INVALID" });
  });

  it("refuses a bind that returns to a different session", async () => {
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    const other = await seedPasswordAccount();
    const callback = await bindCallback(
      cookieHeader(other.cookie, authorized.bindCookie),
      authorized.state,
    );
    expect(callback.status).toBe(302);
    const fragment = fragmentOf(callback.headers.get("location") ?? "");
    expect(fragment.get("identityLinkError")).toBe("IDENTITY_ACTION_SESSION_CHANGED");
  });

  it("refuses a bind whose id token is signed by a key Google does not publish", async () => {
    const subject = `st132-bind-${randomUUID()}`;
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    tokenAnswer = {
      kind: "tokens",
      subject,
      email: account.email,
      emailVerified: true,
      overrides: { signWith: "unpublished" },
    };
    const callback = await bindCallback(
      cookieHeader(account.cookie, authorized.bindCookie),
      authorized.state,
    );
    expect(callback.status).toBe(302);
    const fragment = fragmentOf(callback.headers.get("location") ?? "");
    // An unverifiable token is indistinguishable from no usable answer at all,
    // and both leave the intent unconsumed rather than issuing a proof.
    expect(fragment.get("identityLink")).toBe("error");
    expect(fragment.get("identityLinkProof")).toBeNull();
    expect(fragment.get("identityLinkError")).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    expect(await countOwnerships(subject)).toHaveLength(0);
    expect(await countAccounts(subject)).toHaveLength(0);
  });

  it("refuses a callback whose state does not match the signed flow", async () => {
    const intent = await openLinkIntent(account.cookie);
    const authorized = await authorizeBind(account.cookie, intent.actionId);
    const callback = await bindCallback(
      cookieHeader(account.cookie, authorized.bindCookie),
      "st132-not-the-issued-state",
    );
    expect(callback.status).toBe(302);
    const fragment = fragmentOf(callback.headers.get("location") ?? "");
    expect(fragment.get("identityLinkError")).toBe("IDENTITY_BIND_STATE_INVALID");
  });
});

/**
 * #528 (ST-150): the direct `/sign-in/social` `idToken` path, which the whole
 * file above never touches.
 *
 * Everything else here drives the authorization-code flow, where `code` and
 * `state` are each single-use and a replay dies on the state. The native path
 * has neither: the pinned 1.6.23 `api/routes/sign-in.mjs` runs
 * `provider.verifyIdToken(token, nonce)` and signs the subject in, and
 * verification answers only "did Google mint this for this audience". So the
 * same still-valid token, posted again from any client, used to be a second
 * successful authentication. `googleSignInOptions` now spends the token
 * through `consumeVerifiedIdToken`, exactly as `apple-provider.ts` does under
 * #350 owner decision B.
 *
 * What is single-use is the TOKEN, not the Google subject.
 */
describe("google id token sign-in", () => {
  /**
   * The same production `consumeVerifiedIdToken`, run by a SECOND Node
   * process. `node --import tsx` gives it its own module registry and its own
   * connection pool, so anything the two processes agree about is agreed
   * through the shared table rather than through memory this one holds. The
   * token goes over stdin, never argv; only the verdict comes back.
   */
  const CONSUMPTION_CHILD = fileURLToPath(
    new URL("./id-token-consumption-child.ts", import.meta.url),
  );

  function consumeInSeparateProcess(token: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ["--import", "tsx", CONSUMPTION_CHILD],
        { timeout: 60_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`consumption process failed: ${error.message}\n${stderr}`));
            return;
          }
          const printed = stdout.trim().split("\n").at(-1) ?? "";
          try {
            resolve((JSON.parse(printed) as { consumed: boolean }).consumed);
          } catch {
            reject(new Error(
              `consumption process printed ${JSON.stringify(printed)}\n${stderr}`,
            ));
          }
        },
      );
      child.stdin?.end(JSON.stringify({ providerId: GOOGLE_PROVIDER_ID, token }));
    });
  }

  async function signInWithIdToken(
    token: string,
    nonce?: string,
    requestSignUp = true,
  ) {
    return await app.request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/",
        idToken: { token, ...(nonce ? { nonce } : {}) },
        ...(requestSignUp ? { requestSignUp: true } : {}),
      }),
    });
  }

  async function usersFor(subject: string) {
    return await db
      .select({ id: authAccount.userId })
      .from(authAccount)
      .where(and(eq(authAccount.providerId, "google"), eq(authAccount.accountId, subject)));
  }

  /** Every live session of one user, so a refused replay can be proved not to have touched them. */
  async function sessionIdsFor(userId: string) {
    const rows = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.userId, userId));
    return rows.map((row) => row.id).sort();
  }

  async function consumptionRecordFor(token: string) {
    const [record] = await db
      .select()
      .from(providerIdTokenConsumptions)
      .where(eq(
        providerIdTokenConsumptions.tokenDigest,
        idTokenDigest(GOOGLE_PROVIDER_ID, token),
      ));
    return record ?? null;
  }

  /** A first sign-in plus the client's own organization -> Atlas walk. */
  async function establishAccount(subject: string, email: string) {
    const response = await signInWithIdToken(fakeIdToken(subject, email, true));
    expect(response.status).toBe(200);
    const user = await trackGoogleUser(email);
    expect(user).toBeTruthy();
    const sessionCookie = jarFrom(response);

    const organization = await postJson("/api/auth/organization/create", {
      name: "ST-150 Atlas",
      slug: `st150-${randomUUID()}`,
    }, sessionCookie);
    expect(organization.status).toBe(200);
    const { id: organizationId } = await organization.json() as { id: string };
    createdOrganizationIds.push(organizationId);
    const activated = await postJson(
      "/api/auth/organization/set-active",
      { organizationId },
      sessionCookie,
    );
    expect(activated.status).toBe(200);
    const bootstrap = await postJson("/api/atlases/bootstrap", {
      title: "ST-150",
      dedication: "",
    }, cookieHeader(sessionCookie, jarFrom(activated)));
    expect(bootstrap.status).toBe(201);
    return { userId: user!.id, organizationId };
  }

  async function atlasIdsFor(organizationId: string) {
    const rows = await db
      .select({ id: atlases.id })
      .from(atlases)
      .where(eq(atlases.organizationId, organizationId));
    return rows.map((row) => row.id).sort();
  }

  it("spends a valid id token exactly once", async () => {
    const subject = `st150-sub-replay-${randomUUID()}`;
    const email = `st150-replay-${randomUUID()}@example.test`;
    const token = fakeIdToken(subject, email, true);

    expect((await signInWithIdToken(token)).status).toBe(200);
    const user = await trackGoogleUser(email);
    expect(user).toBeTruthy();
    const accounts = await usersFor(subject);
    expect(accounts).toHaveLength(1);
    const established = await sessionIdsFor(user!.id);
    expect(established).toHaveLength(1);

    // The same token, a whole new request. No `state` and no `code` ever
    // entered this path, so nothing but the consumption record can refuse it.
    expect((await signInWithIdToken(token)).status).toBe(401);
    expect(await usersFor(subject)).toEqual(accounts);
    expect(await countAccounts(subject)).toHaveLength(1);
    // The refusal is of the token alone: the session the first use established
    // survives it.
    expect(await sessionIdsFor(user!.id)).toEqual(established);
  });

  it("lets at most one of several concurrent presentations of one token succeed", async () => {
    const subject = `st150-sub-race-${randomUUID()}`;
    const email = `st150-race-${randomUUID()}@example.test`;
    const token = fakeIdToken(subject, email, true);

    // The record is claimed with one `insert ... on conflict do nothing ...
    // returning`, so this race is decided by PostgreSQL rather than by any
    // per-process state -- the same decision a second API instance would be
    // subject to. The losers are asserted as 401 rather than merely "not 200",
    // so a throttled request would fail as the throttle it is.
    const statuses = await Promise.all(
      Array.from({ length: 4 }, () => signInWithIdToken(token).then((r) => r.status)),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(3);

    const user = await trackGoogleUser(email);
    expect(user).toBeTruthy();
    expect(await countAccounts(subject)).toHaveLength(1);
    expect(await countOwnerships(subject)).toHaveLength(1);
    expect(await sessionIdsFor(user!.id)).toHaveLength(1);
  });

  it("signs a subject whose token was already spent back into its own user and atlas", async () => {
    const subject = `st150-sub-fresh-${randomUUID()}`;
    const email = `st150-fresh-${randomUUID()}@example.test`;
    const { userId, organizationId } = await establishAccount(subject, email);
    const atlasesBefore = await atlasIdsFor(organizationId);
    expect(atlasesBefore).toHaveLength(1);
    const established = await sessionIdsFor(userId);

    // A distinct token for the same Google subject: a different `iat`, so a
    // different string and a different digest. It carries the sign-IN intent
    // alone, which is what a returning user sends.
    const later = fakeIdToken(subject, email, true, {
      issuedAt: Math.floor(Date.now() / 1000) - 5,
    });
    expect((await signInWithIdToken(later, undefined, false)).status).toBe(200);

    expect(await usersFor(subject)).toEqual([{ id: userId }]);
    expect(await countAccounts(subject)).toHaveLength(1);
    expect(await atlasIdsFor(organizationId)).toEqual(atlasesBefore);
    const after = await sessionIdsFor(userId);
    expect(after.length).toBe(established.length + 1);
    expect(after).toEqual(expect.arrayContaining(established));
  });

  /**
   * The load-bearing poisoning case: ONE token, refused and then accepted, so
   * both presentations carry the SAME digest. A pair of different tokens could
   * not prove anything here -- different strings hash to different records --
   * which is why the nonce mismatch is the shape used. What is under test is
   * the ordering inside the override: verification first, consumption only
   * after it passes.
   */
  it("does not let a refused token occupy the record its own valid presentation needs", async () => {
    const subject = `st150-sub-poison-${randomUUID()}`;
    const email = `st150-poison-${randomUUID()}@example.test`;
    const token = fakeIdToken(subject, email, true, {
      nonce: "st150-nonce-for-this-authorization",
    });

    expect((await signInWithIdToken(token, "st150-nonce-from-another-authorization")).status)
      .toBe(401);
    expect(await usersFor(subject)).toHaveLength(0);
    expect(await consumptionRecordFor(token)).toBeNull();

    expect((await signInWithIdToken(token, "st150-nonce-for-this-authorization")).status)
      .toBe(200);
    expect(await trackGoogleUser(email)).toBeTruthy();
    expect(await usersFor(subject)).toHaveLength(1);
  });

  it("leaves no record behind for a token the adapter itself refuses", async () => {
    const subject = `st150-sub-unverified-${randomUUID()}`;
    const email = `st150-unverified-${randomUUID()}@example.test`;
    const wrongAudience = fakeIdToken(subject, email, true, {
      audience: "st150-other-client.apps.googleusercontent.test",
    });
    const stale = fakeIdToken(subject, email, true, {
      issuedAt: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
    });

    expect((await signInWithIdToken(wrongAudience)).status).toBe(401);
    expect((await signInWithIdToken(stale)).status).toBe(401);
    expect(await consumptionRecordFor(wrongAudience)).toBeNull();
    expect(await consumptionRecordFor(stale)).toBeNull();
    expect(await usersFor(subject)).toHaveLength(0);

    // Neither refusal cost the subject its sign-in.
    expect((await signInWithIdToken(fakeIdToken(subject, email, true))).status).toBe(200);
    expect(await trackGoogleUser(email)).toBeTruthy();
    expect(await usersFor(subject)).toHaveLength(1);
  });

  it("records a spent token as a shared row that refuses it in another process", async () => {
    const subject = `st150-sub-store-${randomUUID()}`;
    const email = `st150-store-${randomUUID()}@example.test`;
    const token = fakeIdToken(subject, email, true);
    expect((await signInWithIdToken(token)).status).toBe(200);
    expect(await trackGoogleUser(email)).toBeTruthy();

    const record = await consumptionRecordFor(token);
    expect(record).toBeTruthy();
    expect(record!.providerId).toBe(GOOGLE_PROVIDER_ID);
    // A digest and a window, never the credential itself.
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(record!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

    // A SECOND Node process, with its own module registry and its own pool,
    // agrees the token is spent -- so the refusal is the row and not memory
    // this process happens to hold. And a token spent over there is refused
    // here, which is the direction a second API instance would exercise.
    expect(await consumeInSeparateProcess(token)).toBe(false);
    const spentThere = fakeIdToken(
      `st150-sub-store-other-${randomUUID()}`,
      `st150-store-other-${randomUUID()}@example.test`,
      true,
    );
    expect(await consumeInSeparateProcess(spentThere)).toBe(true);
    expect(await consumeVerifiedIdToken({ providerId: GOOGLE_PROVIDER_ID, token: spentThere }))
      .toBe(false);
  });
});
