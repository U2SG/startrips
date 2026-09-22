import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
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
const { atlases, accountIdentityAudit, accountIdentityOwnerships } = await import("../db/app-schema");
const {
  account: authAccount,
  member: authMember,
  organization: authOrganization,
  rateLimit,
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
  const issuedAt = Math.floor(Date.now() / 1000);
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

async function signInWithGoogle(
  subject: string,
  email: string,
  emailVerified = true,
  overrides?: TokenClaimOverrides,
) {
  tokenAnswer = { kind: "tokens", subject, email, emailVerified, overrides };
  const started = await startSignIn();
  const callback = await finishSignIn(started.state, started.jar);
  return { callback, sessionCookie: jarFrom(callback) };
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
    const { callback, sessionCookie } = await signInWithGoogle(subject, email);
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

  it("returns the same user for a later sign-in with the same subject", async () => {
    const subject = `st132-sub-${randomUUID()}`;
    const email = `st132-${randomUUID()}@example.test`;
    await signInWithGoogle(subject, email);
    const user = await trackGoogleUser(email);

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
    const started = await startSignIn();
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
    const [left, right] = await Promise.all([startSignIn(), startSignIn()]);
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
      const { callback } = await signInWithGoogle(subject, email, true, overrides);

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
    const first = await signInWithGoogle(subject, email, false);
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
