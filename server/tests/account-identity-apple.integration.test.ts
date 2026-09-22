// FIRST: this configures the Apple credential `../app` is then built with.
import {
  APPLE_KEY_ID,
  APPLE_SERVICE_ID,
  APPLE_TEAM_ID,
  applePrivateKey,
  applePublicKey,
} from "./apple-test-environment";
import { randomUUID, sign } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import {
  completeIdentityLink,
  createIdentityLinkIntent,
  createPasswordReverificationGrant,
  listAccountIdentityMethods,
} from "../account-identities/account-identity-repository";
import { APPLE_PROVIDER_ID } from "../account-identities/apple-provider";
import {
  issueVerifiedProviderIdentityProof,
  verifyProviderIdentityProof,
} from "../account-identities/provider-proof";
import { serverConfig } from "../config";
import {
  accountIdentityAudit,
  accountIdentityOwnerships,
  atlases,
} from "../db/app-schema";
import {
  account as authAccount,
  organization as authOrganization,
  rateLimit,
  session as authSession,
  user as authUser,
} from "../db/auth-schema";
import { db, pool } from "../db/client";

/**
 * #350: Sign in with Apple against a fake Apple, with the real provider.
 *
 * `apple-test-environment` configures a complete Apple credential before
 * `../app` loads, so `auth.ts` registers the pinned Better Auth 1.6.23 `apple`
 * adapter for real. Only the network is fake: `globalThis.fetch` answers
 * Apple's token endpoint and JWKS. Everything the assertions are about --
 * `state`, the token exchange, id-token issuer/audience/age/nonce
 * verification, account linking policy -- is Better Auth's own code running on
 * the app the product ships.
 *
 * Real Apple Developer credentials are an external gate outside CI: no test
 * here proves an approved Service id, a registered return URL or a live
 * authorization. See `docs/architecture/apple-sign-in.md`.
 */

// `../app` has read the credential by now, so take it back out of the
// environment: `config.ts` re-reads `process.env` whenever it is first imported,
// and a worker this file shares with `account-identity-routes` must not find an
// Apple provider configured there.
for (const name of [
  "APPLE_SERVICE_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
]) delete process.env[name];

const TEST_ORIGIN = "http://127.0.0.1:5173";
const AUTH_BASE = `${TEST_ORIGIN}/api/auth`;
const APPLE_ISSUER = "https://appleid.apple.com";
const RUN = randomUUID().slice(0, 8);

/** Authorization codes the fake Apple will exchange, and for what. */
type PendingAuthorization = {
  idToken: string;
  /** Simulates Apple refusing an expired client-secret assertion. */
  rejectClientSecret?: boolean;
};

const pendingAuthorizations = new Map<string, PendingAuthorization>();
let realFetch: typeof globalThis.fetch;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Sign an id token exactly as Apple would, with the key the fake JWKS serves. */
function signIdToken(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({
    alg: "ES256",
    kid: APPLE_KEY_ID,
    typ: "JWT",
  }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: applePrivateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

function appleIdToken(values: {
  subject: string;
  email?: string | null;
  emailVerified?: boolean | "true" | "false";
  audience?: string;
  issuedAt?: number;
  nonce?: string;
  isPrivateEmail?: boolean;
}): string {
  const issuedAt = values.issuedAt ?? Math.floor(Date.now() / 1000);
  return signIdToken({
    iss: APPLE_ISSUER,
    aud: values.audience ?? APPLE_SERVICE_ID,
    sub: values.subject,
    iat: issuedAt,
    exp: issuedAt + 600,
    ...(values.email === undefined ? {} : values.email === null
      ? {}
      : { email: values.email }),
    ...(values.emailVerified === undefined
      ? {}
      : { email_verified: values.emailVerified }),
    ...(values.isPrivateEmail === undefined
      ? {}
      : { is_private_email: values.isPrivateEmail }),
    ...(values.nonce ? { nonce: values.nonce } : {}),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * What the fake Apple actually received. Recorded rather than asserted inside
 * the stub: an expectation thrown from `fetch` would surface as a generic
 * `invalid_code` redirect instead of a readable failure.
 */
type TokenRequest = { clientId: string | null; clientSecret: string | null };

const tokenRequests: TokenRequest[] = [];

beforeAll(() => {
  realFetch = globalThis.fetch;
  const jwk = applePublicKey.export({ format: "jwk" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(`${APPLE_ISSUER}/auth/keys`)) {
      return jsonResponse({
        keys: [{ ...jwk, kid: APPLE_KEY_ID, alg: "ES256", use: "sig" }],
      });
    }
    if (url.startsWith(`${APPLE_ISSUER}/auth/token`)) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      tokenRequests.push({
        clientId: body.get("client_id"),
        clientSecret: body.get("client_secret"),
      });
      const authorization = pendingAuthorizations.get(body.get("code") ?? "");
      if (!authorization) return jsonResponse({ error: "invalid_grant" }, 400);
      if (authorization.rejectClientSecret) {
        return jsonResponse({ error: "invalid_client" }, 400);
      }
      return jsonResponse({
        access_token: `apple-access-${randomUUID()}`,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: authorization.idToken,
      });
    }
    throw new Error(`unexpected outbound request in Apple tests: ${url}`);
  }) as typeof globalThis.fetch;
});

// One Apple authorization costs two `/api/auth/*` requests, and this file
// drives a couple of dozen of them inside Better Auth's 60-second window
// (`rateLimit.max` is 100, shared across every request the whole `core` suite
// has already made). Clearing the budget is what
// `account-identity-routes.integration.test.ts` does for the same reason: it
// keeps these assertions about Apple rather than about whichever file ran
// first. Nothing here asserts anything about rate limiting.
beforeEach(async () => {
  await db.delete(rateLimit);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  const created = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(like(authUser.email, `%${RUN}%`));
  const ids = created.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(accountIdentityAudit)
      .where(inArray(accountIdentityAudit.userId, ids));
    await db.delete(accountIdentityOwnerships)
      .where(inArray(accountIdentityOwnerships.userId, ids));
  }
  await db.delete(authOrganization).where(like(authOrganization.slug, `st133-${RUN}%`));
  if (ids.length > 0) await db.delete(authUser).where(inArray(authUser.id, ids));
  await pool.end();
});

/**
 * Begin one authorization the way the browser does, and hand back the state
 * plus the cookies Better Auth expects on the callback. The state is minted by
 * Better Auth, never by the test.
 */
async function beginAuthorization(authorization: PendingAuthorization) {
  const response = await app.request(`${AUTH_BASE}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_ORIGIN },
    body: JSON.stringify({
      provider: APPLE_PROVIDER_ID,
      callbackURL: `${TEST_ORIGIN}/`,
      errorCallbackURL: `${TEST_ORIGIN}/auth-error`,
      disableRedirect: true,
    }),
  });
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  const authorizationUrl = new URL(url);
  expect(authorizationUrl.origin + authorizationUrl.pathname)
    .toBe(`${APPLE_ISSUER}/auth/authorize`);
  expect(authorizationUrl.searchParams.get("client_id")).toBe(APPLE_SERVICE_ID);
  expect(authorizationUrl.searchParams.get("response_mode")).toBe("form_post");
  const state = authorizationUrl.searchParams.get("state") as string;
  expect(state).toBeTruthy();
  const code = `apple-code-${randomUUID()}`;
  pendingAuthorizations.set(code, authorization);
  const cookies = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  return { state, code, cookies };
}

type CallbackOutcome = {
  location: string;
  error: string | null;
  sessionCookie: string | null;
};

function readCallback(response: Response): CallbackOutcome {
  const location = response.headers.get("location") ?? "";
  const parsed = location ? new URL(location, TEST_ORIGIN) : null;
  const sessionCookie = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0])
    .find((entry): entry is string => Boolean(entry)) ?? null;
  return {
    location,
    error: parsed?.searchParams.get("error") ?? null,
    sessionCookie,
  };
}

/** Drive one complete Apple authorization through Better Auth's callback. */
async function completeAuthorization(authorization: PendingAuthorization) {
  const { state, code, cookies } = await beginAuthorization(authorization);
  const response = await app.request(
    `${AUTH_BASE}/callback/apple?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { headers: cookies ? { cookie: cookies } : {}, redirect: "manual" },
  );
  return { ...readCallback(response), state, code, cookies };
}

async function usersFor(subject: string) {
  return await db
    .select({ id: authAccount.userId, accountRecordId: authAccount.id })
    .from(authAccount)
    .where(and(
      eq(authAccount.providerId, APPLE_PROVIDER_ID),
      eq(authAccount.accountId, subject),
    ));
}

async function userCountForEmail(email: string) {
  const rows = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email.toLowerCase()));
  return rows.length;
}

describe("Apple sign-in", () => {
  it("registers the provider from the configured credential", () => {
    expect(serverConfig.appleServiceId).toBe(APPLE_SERVICE_ID);
    expect(serverConfig.appleTeamId).toBe(APPLE_TEAM_ID);
    expect(serverConfig.appleKeyId).toBe(APPLE_KEY_ID);
  });

  it("creates exactly one user and one Atlas for a first-time subject", async () => {
    const subject = `apple-subject-first-${RUN}`;
    const email = `apple-first-${RUN}@example.test`;
    const outcome = await completeAuthorization({
      idToken: appleIdToken({ subject, email, emailVerified: true }),
    });
    expect(outcome.error).toBeNull();
    expect(outcome.location).toBe(`${TEST_ORIGIN}/`);
    expect(outcome.sessionCookie).toBeTruthy();
    const accounts = await usersFor(subject);
    expect(accounts).toHaveLength(1);
    expect(await userCountForEmail(email)).toBe(1);

    // One Atlas, even when two bootstraps race each other.
    const headers = {
      "content-type": "application/json",
      origin: TEST_ORIGIN,
      cookie: outcome.sessionCookie as string,
    };
    const organization = await app.request(`${AUTH_BASE}/organization/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Apple Atlas", slug: `st133-${RUN}` }),
    });
    expect(organization.status).toBe(200);
    const body = JSON.stringify({ title: "Apple Atlas", dedication: "" });
    const [first, second] = await Promise.all([
      app.request(`${TEST_ORIGIN}/api/atlases/bootstrap`, { method: "POST", headers, body }),
      app.request(`${TEST_ORIGIN}/api/atlases/bootstrap`, { method: "POST", headers, body }),
    ]);
    expect([first.status, second.status].every((status) => status < 400)).toBe(true);
    const organizationId = (await organization.json() as { id: string }).id;
    const atlasRows = await db
      .select({ id: atlases.id })
      .from(atlases)
      .where(eq(atlases.organizationId, organizationId));
    expect(atlasRows).toHaveLength(1);
  });

  it("resolves a duplicate concurrent callback back to the one stable user", async () => {
    const subject = `apple-subject-duplicate-${RUN}`;
    const email = `apple-duplicate-${RUN}@example.test`;
    const idToken = appleIdToken({ subject, email, emailVerified: true });
    const outcomes = await Promise.all([
      completeAuthorization({ idToken }),
      completeAuthorization({ idToken }),
    ]);
    // Both callbacks are legitimate, so at least one signs in. Whether the
    // other joins it or loses the `account_provider_subject_unique` race is
    // the database's call; what must hold either way is that no second
    // Startrips user exists for this Apple subject.
    expect(outcomes.some((outcome) => outcome.error === null)).toBe(true);
    const accounts = await usersFor(subject);
    expect(accounts).toHaveLength(1);
    expect(await userCountForEmail(email)).toBe(1);

    // And a third, later authorization for the same subject is still that user.
    const returning = await completeAuthorization({
      idToken: appleIdToken({ subject, email, emailVerified: true }),
    });
    expect(returning.error).toBeNull();
    expect(await usersFor(subject)).toEqual(accounts);
  });

  it("refuses a returning authorization that carries no email", async () => {
    const subject = `apple-subject-nomail-${RUN}`;
    const outcome = await completeAuthorization({
      idToken: appleIdToken({ subject }),
    });
    expect(outcome.error).toBe("email_not_found");
    expect(outcome.sessionCookie).toBeNull();
    expect(await usersFor(subject)).toHaveLength(0);
  });

  it("refuses a used state, so a replayed callback cannot mint a second identity", async () => {
    const subject = `apple-subject-replay-${RUN}`;
    const email = `apple-replay-${RUN}@example.test`;
    const idToken = appleIdToken({ subject, email, emailVerified: true });
    const first = await completeAuthorization({ idToken });
    expect(first.error).toBeNull();
    const replay = await app.request(
      `${AUTH_BASE}/callback/apple?state=${encodeURIComponent(first.state)}&code=${encodeURIComponent(first.code)}`,
      { headers: first.cookies ? { cookie: first.cookies } : {}, redirect: "manual" },
    );
    const outcome = readCallback(replay);
    expect(outcome.error).toBeTruthy();
    expect(outcome.sessionCookie).toBeNull();
    expect(await usersFor(subject)).toHaveLength(1);
  });

  it("refuses a rejected client secret without touching the bound account", async () => {
    const subject = `apple-subject-secret-${RUN}`;
    const email = `apple-secret-${RUN}@example.test`;
    const established = await completeAuthorization({
      idToken: appleIdToken({ subject, email, emailVerified: true }),
    });
    expect(established.error).toBeNull();
    const before = await usersFor(subject);

    const refused = await completeAuthorization({
      idToken: appleIdToken({ subject, email, emailVerified: true }),
      rejectClientSecret: true,
    });
    expect(refused.error).toBe("invalid_code");
    expect(refused.sessionCookie).toBeNull();
    // The account and its user survive an expired deployment credential: only
    // the new sign-in failed.
    expect(await usersFor(subject)).toEqual(before);

    const recovered = await completeAuthorization({
      idToken: appleIdToken({ subject, email, emailVerified: true }),
    });
    expect(recovered.error).toBeNull();
    expect(recovered.sessionCookie).toBeTruthy();
    expect(await usersFor(subject)).toEqual(before);
  });

  it("presents a live ES256 assertion for this Team, Key and Service every time", () => {
    expect(tokenRequests.length).toBeGreaterThan(0);
    for (const request of tokenRequests) {
      expect(request.clientId).toBe(APPLE_SERVICE_ID);
      expect(request.clientSecret).toBeTruthy();
      const [header, payload] = (request.clientSecret as string).split(".");
      expect(decodeSegment(header)).toEqual({
        alg: "ES256",
        kid: APPLE_KEY_ID,
        typ: "JWT",
      });
      const claims = decodeSegment(payload) as Record<string, number | string>;
      expect(claims.iss).toBe(APPLE_TEAM_ID);
      expect(claims.sub).toBe(APPLE_SERVICE_ID);
      expect(claims.aud).toBe(APPLE_ISSUER);
      // Minted against the live clock, never a value frozen at startup.
      expect(Number(claims.exp) * 1000).toBeGreaterThan(Date.now());
    }
  });
});

describe("Apple id token verification", () => {
  async function signInWithIdToken(token: string, nonce?: string) {
    return await app.request(`${AUTH_BASE}/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({
        provider: APPLE_PROVIDER_ID,
        callbackURL: `${TEST_ORIGIN}/`,
        idToken: { token, ...(nonce ? { nonce } : {}) },
      }),
    });
  }

  it("rejects an id token minted for another audience", async () => {
    const subject = `apple-subject-audience-${RUN}`;
    const response = await signInWithIdToken(appleIdToken({
      subject,
      email: `apple-audience-${RUN}@example.test`,
      emailVerified: true,
      audience: "com.example.other.service",
    }));
    expect(response.status).toBe(401);
    expect(await usersFor(subject)).toHaveLength(0);
  });

  it("rejects an id token older than the provider's own maximum age", async () => {
    const subject = `apple-subject-stale-${RUN}`;
    const response = await signInWithIdToken(appleIdToken({
      subject,
      email: `apple-stale-${RUN}@example.test`,
      emailVerified: true,
      issuedAt: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
    }));
    expect(response.status).toBe(401);
    expect(await usersFor(subject)).toHaveLength(0);
  });

  it("rejects an id token whose nonce does not match the request", async () => {
    const subject = `apple-subject-nonce-${RUN}`;
    const response = await signInWithIdToken(
      appleIdToken({
        subject,
        email: `apple-nonce-${RUN}@example.test`,
        emailVerified: true,
        nonce: "nonce-from-another-authorization",
      }),
      "nonce-for-this-authorization",
    );
    expect(response.status).toBe(401);
    expect(await usersFor(subject)).toHaveLength(0);
  });

  it("resolves a replayed id token back to the same user rather than a second one", async () => {
    const subject = `apple-subject-idreplay-${RUN}`;
    const email = `apple-idreplay-${RUN}@example.test`;
    const token = appleIdToken({ subject, email, emailVerified: true });
    expect((await signInWithIdToken(token)).status).toBe(200);
    const first = await usersFor(subject);
    expect(first).toHaveLength(1);
    expect((await signInWithIdToken(token)).status).toBe(200);
    expect(await usersFor(subject)).toEqual(first);
    expect(await userCountForEmail(email)).toBe(1);
  });
});

describe("Apple identity is a subject, not an email", () => {
  /**
   * The #350 contract: a Hide My Email relay address, or any address that
   * happens to match an existing account, never links an Apple subject to that
   * account. The only way in is the ST-067 pipeline --
   * `createIdentityLinkIntent` -> `verifyProviderIdentityProof` ->
   * `completeIdentityLink` -- driven by a signed-in owner who re-verified.
   */
  it("refuses to link a relay address to an account that already owns it", async () => {
    const relay = `st133-${RUN}@privaterelay.appleid.test`;
    const password = "test-only-password-350";
    const signUp = await app.request(`${AUTH_BASE}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ name: "Relay owner", email: relay, password }),
    });
    expect(signUp.status).toBe(200);
    const [owner] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, relay.toLowerCase()));
    expect(owner).toBeTruthy();

    const subject = `apple-subject-relay-${RUN}`;
    const outcome = await completeAuthorization({
      idToken: appleIdToken({
        subject,
        email: relay,
        emailVerified: true,
        isPrivateEmail: true,
      }),
    });
    expect(outcome.error).toBe("account_not_linked");
    expect(outcome.sessionCookie).toBeNull();
    expect(await usersFor(subject)).toHaveLength(0);
    expect(await userCountForEmail(relay)).toBe(1);

    // The owner binds it deliberately instead, through ST-067.
    const [session] = await db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.userId, owner.id))
      .limit(1);
    const sessionId = session?.id ?? `st133-session-${randomUUID()}`;
    if (!session) {
      await db.insert(authSession).values({
        id: sessionId,
        token: `st133-token-${randomUUID()}`,
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    }
    const grant = await createPasswordReverificationGrant(owner.id, sessionId);
    const intent = await createIdentityLinkIntent({
      userId: owner.id,
      sessionId,
      providerId: APPLE_PROVIDER_ID,
      reverificationToken: grant.token,
    });
    const proofToken = issueVerifiedProviderIdentityProof(serverConfig.authSecret, {
      actionId: intent.actionId,
      userId: owner.id,
      sessionId,
      identity: {
        providerId: APPLE_PROVIDER_ID,
        subject,
        email: relay,
        emailVerified: true,
      },
    });
    const proof = verifyProviderIdentityProof(serverConfig.authSecret, proofToken);
    expect(proof).not.toBeNull();
    const linked = await completeIdentityLink({
      userId: owner.id,
      sessionId,
      intentToken: intent.token,
      proof: proof!,
    });
    expect(linked.linked).toBe(true);

    // And from here the subject -- not the address -- is the identity: the
    // same Apple authorization now signs in as that one account.
    const accounts = await usersFor(subject);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(owner.id);
    const methods = await listAccountIdentityMethods(
      owner.id,
      new Set([APPLE_PROVIDER_ID]),
    );
    const appleMethod = methods.find((method) => method.providerId === APPLE_PROVIDER_ID);
    expect(appleMethod?.usable).toBe(true);

    const signedIn = await completeAuthorization({
      idToken: appleIdToken({
        subject,
        email: relay,
        emailVerified: true,
        isPrivateEmail: true,
      }),
    });
    expect(signedIn.error).toBeNull();
    expect(signedIn.sessionCookie).toBeTruthy();
    expect(await usersFor(subject)).toEqual(accounts);
    expect(await userCountForEmail(relay)).toBe(1);
  });

  it("offers apple as a sign-in provider but not yet as a bindable one", async () => {
    const email = `apple-surface-${RUN}@example.test`;
    const password = "test-only-password-350";
    const signUp = await app.request(`${AUTH_BASE}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ name: "Surface", email, password }),
    });
    expect(signUp.status).toBe(200);
    const verificationToken = await createEmailVerificationToken(
      serverConfig.authSecret,
      email,
    );
    const verify = await app.request(
      `${AUTH_BASE}/verify-email?token=${encodeURIComponent(verificationToken)}`,
      { headers: { origin: TEST_ORIGIN } },
    );
    expect(verify.status).toBe(200);
    const signIn = await app.request(`${AUTH_BASE}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .get("set-cookie")
      ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0] ?? "";
    expect(cookie).toBeTruthy();
    const response = await app.request(`${TEST_ORIGIN}/api/account-identities`, {
      headers: { origin: TEST_ORIGIN, cookie },
    });
    expect(response.status).toBe(200);
    // #350: the credential is present, so Apple is a login this deployment can
    // actually complete and the sign-in gate may offer it.
    const providers = await app.request(
      `${TEST_ORIGIN}/api/account-identities/providers`,
      { headers: { origin: TEST_ORIGIN } },
    );
    expect(providers.status).toBe(200);
    const offered = await providers.json() as { signInProviders: string[] };
    expect(offered.signInProviders).toEqual([APPLE_PROVIDER_ID]);
    // Binding an Apple identity to an EXISTING account is a different round
    // trip, and Apple's `response_mode=form_post` return cannot carry the
    // SameSite=Lax bind cookie to the GET callback the shared flow exposes.
    // `availableLinkProviders` drives a generic bind button, so it must stay
    // empty rather than render a control that can only fail.
    const body = await response.json() as { availableLinkProviders: string[] };
    expect(body.availableLinkProviders).toEqual([]);
  });
});
