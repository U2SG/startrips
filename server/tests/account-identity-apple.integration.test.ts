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
import { and, eq, inArray, like, not } from "drizzle-orm";
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
  consumeVerifiedIdToken,
  idTokenDigest,
} from "../account-identities/id-token-consumption";
import { ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX } from "../account-identities/reverification-rate-limit";
import {
  issueVerifiedProviderIdentityProof,
  verifyProviderIdentityProof,
} from "../account-identities/provider-proof";
import { serverConfig } from "../config";
import {
  accountIdentityAudit,
  accountIdentityOwnerships,
  atlases,
  providerIdTokenConsumptions,
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
  name?: string;
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
    ...(values.name === undefined ? {} : { name: values.name }),
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
// has already made). Clearing that budget is what
// `account-identity-routes.integration.test.ts` does for the same reason: it
// keeps these assertions about Apple rather than about whichever file ran
// first. Nothing here asserts anything about rate limiting.
//
// The reverification limiter shares this one table, so its rows are left
// alone: that suite asserts its own budget is actually spent, and a blanket
// delete would be a cross-file reset waiting to happen.
beforeEach(async () => {
  await db.delete(rateLimit).where(not(like(
    rateLimit.key,
    `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}%`,
  )));
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
  // The consumption records this run wrote expire on their own, but the two
  // this file inserts by hand carry a readable digest rather than a real one.
  await db.delete(providerIdTokenConsumptions)
    .where(like(providerIdTokenConsumptions.tokenDigest, `st133-${RUN}%`));
  if (ids.length > 0) await db.delete(authUser).where(inArray(authUser.id, ids));
  await pool.end();
});

/**
 * Begin one authorization the way the browser does, and hand back the state
 * plus the cookies Better Auth expects on the callback. The state is minted by
 * Better Auth, never by the test.
 */
async function beginAuthorization(
  authorization: PendingAuthorization,
  // #349/#350: `disableImplicitSignUp` keeps the three intents three, so an
  // unrecognised subject registers only when the caller asked for it. Most
  // cases here are about a first-time Apple subject and therefore carry the
  // sign-up intent; the case that must NOT register omits it deliberately.
  requestSignUp = true,
) {
  const response = await app.request(`${AUTH_BASE}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_ORIGIN },
    body: JSON.stringify({
      provider: APPLE_PROVIDER_ID,
      callbackURL: `${TEST_ORIGIN}/`,
      errorCallbackURL: `${TEST_ORIGIN}/auth-error`,
      disableRedirect: true,
      ...(requestSignUp ? { requestSignUp: true } : {}),
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
async function completeAuthorization(
  authorization: PendingAuthorization,
  requestSignUp = true,
) {
  const { state, code, cookies } = await beginAuthorization(
    authorization,
    requestSignUp,
  );
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

/** The stored profile of one user, so a later callback can be proved not to have touched it. */
async function userRow(userId: string) {
  const [row] = await db
    .select({
      name: authUser.name,
      email: authUser.email,
      emailVerified: authUser.emailVerified,
      image: authUser.image,
    })
    .from(authUser)
    .where(eq(authUser.id, userId));
  return row;
}

/** The ST-067 ownership row `accountIdentityUsable` reads, for one Apple subject. */
async function ownershipFor(subject: string) {
  const [row] = await db
    .select({
      providerEmail: accountIdentityOwnerships.providerEmail,
      providerEmailVerified: accountIdentityOwnerships.providerEmailVerified,
    })
    .from(accountIdentityOwnerships)
    .where(and(
      eq(accountIdentityOwnerships.providerId, APPLE_PROVIDER_ID),
      eq(accountIdentityOwnerships.providerSubject, subject),
    ));
  return row;
}

/** Every live session of one user, so a refused replay can be proved not to have touched them. */
async function sessionIdsFor(userId: string) {
  const rows = await db
    .select({ id: authSession.id })
    .from(authSession)
    .where(eq(authSession.userId, userId));
  return rows.map((row) => row.id).sort();
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

  // #350 keeps Apple's three intents three, exactly as #349 does for Google:
  // without `disableImplicitSignUp` the pinned 1.6.23 callback would let an
  // unrecognised subject arriving through the SIGN-IN button silently register
  // a new Startrips user and Atlas.
  it("refuses to register an unknown subject that arrived without the sign-up intent", async () => {
    const subject = `apple-subject-nosignup-${RUN}`;
    const email = `apple-nosignup-${RUN}@example.test`;
    const outcome = await completeAuthorization(
      { idToken: appleIdToken({ subject, email, emailVerified: true }) },
      false,
    );
    expect(outcome.error).toBe("signup_disabled");
    expect(outcome.sessionCookie).toBeNull();
    expect(await usersFor(subject)).toHaveLength(0);
    expect(await userCountForEmail(email)).toBe(0);
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

  it("refuses an UNKNOWN subject that carries no email", async () => {
    const subject = `apple-subject-nomail-${RUN}`;
    const outcome = await completeAuthorization({
      idToken: appleIdToken({ subject }),
    });
    expect(outcome.error).toBe("email_not_found");
    expect(outcome.sessionCookie).toBeNull();
    expect(await usersFor(subject)).toHaveLength(0);
  });

  // #350: Apple sends `email` only on the FIRST authorization. Every later one
  // carries the stable `sub` alone, and the issue requires that to still sign
  // the same person in -- without clearing the profile Apple did send once and
  // without minting a second user. The pinned callback refuses `!email` before
  // it looks the provider account up, so the subject has to be resolved first.
  it("signs a returning subject back in when Apple omits the email", async () => {
    const subject = `apple-subject-returning-${RUN}`;
    const email = `apple-returning-${RUN}@example.test`;
    const first = await completeAuthorization({
      idToken: appleIdToken({
        subject,
        email,
        emailVerified: true,
        name: "Apple Returning",
      }),
    });
    expect(first.error).toBeNull();
    const established = await usersFor(subject);
    expect(established).toHaveLength(1);
    const userId = established[0].id;
    const before = await userRow(userId);
    const ownershipBefore = await ownershipFor(subject);
    expect(ownershipBefore?.providerEmailVerified).toBe(true);

    const returning = await completeAuthorization({ idToken: appleIdToken({ subject }) });
    expect(returning.error).toBeNull();
    expect(returning.sessionCookie).toBeTruthy();

    // Same user, one account row, no second Startrips user.
    expect(await usersFor(subject)).toEqual(established);
    expect(await userCountForEmail(email)).toBe(1);
    // The profile Apple sent once survives an authorization that sent none.
    expect(await userRow(userId)).toEqual(before);
    // And the recorded provider claim is not downgraded by the silence: the
    // method stays usable per #345's last-usable-fallback rule.
    const ownershipAfter = await ownershipFor(subject);
    expect(ownershipAfter?.providerEmail).toBe(ownershipBefore?.providerEmail);
    expect(ownershipAfter?.providerEmailVerified).toBe(true);
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
  async function signInWithIdToken(
    token: string,
    nonce?: string,
    requestSignUp = true,
  ) {
    return await app.request(`${AUTH_BASE}/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN },
      body: JSON.stringify({
        provider: APPLE_PROVIDER_ID,
        callbackURL: `${TEST_ORIGIN}/`,
        idToken: { token, ...(nonce ? { nonce } : {}) },
        ...(requestSignUp ? { requestSignUp: true } : {}),
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

  /**
   * #350 owner decision B (comment 5786871300). Everything below is about the
   * TOKEN, not the subject and not the account: a spent token is refused, a
   * fresh one for the same subject still works, and a refusal touches neither
   * the session the first use established nor the account itself.
   */
  it("spends a valid id token exactly once", async () => {
    const subject = `apple-subject-idreplay-${RUN}`;
    const email = `apple-idreplay-${RUN}@example.test`;
    const token = appleIdToken({ subject, email, emailVerified: true });

    expect((await signInWithIdToken(token)).status).toBe(200);
    const accounts = await usersFor(subject);
    expect(accounts).toHaveLength(1);
    const established = await sessionIdsFor(accounts[0].id);
    expect(established).toHaveLength(1);

    // Same token, a whole new request. Better Auth's `state` never entered
    // this path, so nothing but the consumption record can refuse it.
    expect((await signInWithIdToken(token)).status).toBe(401);
    expect(await usersFor(subject)).toEqual(accounts);
    expect(await userCountForEmail(email)).toBe(1);
    // The refusal is of the token alone: the first session survives it.
    expect(await sessionIdsFor(accounts[0].id)).toEqual(established);
  });

  it("signs the same subject back in with a freshly minted token", async () => {
    const subject = `apple-subject-idfresh-${RUN}`;
    const email = `apple-idfresh-${RUN}@example.test`;
    expect((await signInWithIdToken(
      appleIdToken({ subject, email, emailVerified: true }),
    )).status).toBe(200);
    const accounts = await usersFor(subject);
    expect(accounts).toHaveLength(1);
    const established = await sessionIdsFor(accounts[0].id);

    // A distinct token for the same Apple subject: a different `iat`, so a
    // different string and a different digest.
    const later = appleIdToken({
      subject,
      email,
      emailVerified: true,
      issuedAt: Math.floor(Date.now() / 1000) - 5,
    });
    expect((await signInWithIdToken(later)).status).toBe(200);
    expect(await usersFor(subject)).toEqual(accounts);
    expect(await userCountForEmail(email)).toBe(1);
    const after = await sessionIdsFor(accounts[0].id);
    expect(after.length).toBe(established.length + 1);
    expect(after).toEqual(expect.arrayContaining(established));
  });

  it("lets at most one of several concurrent presentations of one token succeed", async () => {
    const subject = `apple-subject-idrace-${RUN}`;
    const email = `apple-idrace-${RUN}@example.test`;
    const token = appleIdToken({ subject, email, emailVerified: true });

    // The consumption record lives in the shared database and is claimed with
    // one `insert ... on conflict do nothing ... returning`, so this race is
    // decided by PostgreSQL rather than by any per-process state -- the same
    // decision a second API instance would be subject to.
    const statuses = await Promise.all(
      Array.from({ length: 4 }, () => signInWithIdToken(token).then((r) => r.status)),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(3);
    expect(await usersFor(subject)).toHaveLength(1);
    expect(await userCountForEmail(email)).toBe(1);
    expect(await ownershipFor(subject)).toBeTruthy();
  });

  it("does not let a refused token occupy the record a valid presentation needs", async () => {
    const subject = `apple-subject-idpoison-${RUN}`;
    const email = `apple-idpoison-${RUN}@example.test`;
    const token = appleIdToken({
      subject,
      email,
      emailVerified: true,
      nonce: "nonce-for-this-authorization",
    });

    // Presented against the wrong nonce first: verification fails, so the
    // token must not be marked as spent.
    expect((await signInWithIdToken(token, "nonce-from-another-authorization")).status)
      .toBe(401);
    expect(await usersFor(subject)).toHaveLength(0);

    expect((await signInWithIdToken(token, "nonce-for-this-authorization")).status)
      .toBe(200);
    expect(await usersFor(subject)).toHaveLength(1);
  });

  it("keeps the spent token in shared storage rather than in this process", async () => {
    const subject = `apple-subject-idstore-${RUN}`;
    const token = appleIdToken({
      subject,
      email: `apple-idstore-${RUN}@example.test`,
      emailVerified: true,
    });
    expect((await signInWithIdToken(token)).status).toBe(200);

    const digest = idTokenDigest(APPLE_PROVIDER_ID, token);
    const [record] = await db
      .select()
      .from(providerIdTokenConsumptions)
      .where(eq(providerIdTokenConsumptions.tokenDigest, digest));
    expect(record).toBeTruthy();
    expect(record.providerId).toBe(APPLE_PROVIDER_ID);
    // A digest and a window, never the credential itself.
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(record.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

    // A restarted process holds no memory of the request above and reaches the
    // same verdict, because the verdict is a row: the token is still inside its
    // acceptance window and still refused.
    expect(await consumeVerifiedIdToken({ providerId: APPLE_PROVIDER_ID, token }))
      .toBe(false);
  });

  it("prunes only records whose acceptance window has already closed", async () => {
    const closed = `st133-${RUN}-closed`;
    const open = `st133-${RUN}-open`;
    await db.insert(providerIdTokenConsumptions).values([
      {
        tokenDigest: closed,
        providerId: APPLE_PROVIDER_ID,
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        tokenDigest: open,
        providerId: APPLE_PROVIDER_ID,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    ]);

    const token = appleIdToken({
      subject: `apple-subject-idprune-${RUN}`,
      email: `apple-idprune-${RUN}@example.test`,
      emailVerified: true,
    });
    expect(await consumeVerifiedIdToken({ providerId: APPLE_PROVIDER_ID, token })).toBe(true);

    const remaining = await db
      .select({ tokenDigest: providerIdTokenConsumptions.tokenDigest })
      .from(providerIdTokenConsumptions)
      .where(inArray(providerIdTokenConsumptions.tokenDigest, [closed, open]));
    expect(remaining.map((row) => row.tokenDigest)).toEqual([open]);
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
