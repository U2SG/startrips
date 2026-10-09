import { randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { auth } from "../auth";
import { serverConfig } from "../config";
import { session as authSession, user as authUser } from "../db/auth-schema";
import { db, pool } from "../db/client";

// `session.cookieCache` lets a signed copy of the session authenticate for up
// to its maxAge without a database read. That is acceptable for reading an
// Atlas, not for changing how someone signs in: a revoked session must be
// refused by every identity-sensitive route even while its cached copy is
// still valid. This file drives the cached path for real — the session-data
// cookie is the one Better Auth itself issues — rather than only sending the
// session token, which would never touch the cache.

const ORIGIN = serverConfig.appOrigin;
const userIds: string[] = [];

afterAll(async () => {
  if (userIds.length > 0) await db.delete(authUser).where(inArray(authUser.id, userIds));
  await pool.end();
});

async function seedSession() {
  const userId = `cache-revocation-user-${randomUUID()}`;
  const token = `cache-revocation-token-${randomUUID()}`;
  userIds.push(userId);
  await db.insert(authUser).values({
    id: userId,
    name: "Cache revocation",
    email: `cache-revocation-${randomUUID()}@example.test`,
    emailVerified: true,
  });
  await db.insert(authSession).values({
    id: `cache-revocation-session-${randomUUID()}`,
    token,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { userId, token };
}

/** The session token plus the session-data cache cookie Better Auth sets. */
async function cachedSessionCookie(token: string) {
  const context = await auth.$context;
  const tokenCookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, context.secret)}`;
  const response = await app.request(`${ORIGIN}/api/auth/get-session`, {
    headers: { origin: ORIGIN, cookie: tokenCookie },
  });
  expect(response.status).toBe(200);
  const dataCookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .find((entry) => entry.startsWith(`${context.authCookies.sessionData.name}=`)
      && !entry.endsWith("="));
  expect(dataCookie, "cookieCache must be enabled for this test to mean anything").toBeTruthy();
  return `${tokenCookie}; ${dataCookie}`;
}

function sensitiveRequests(cookie: string) {
  const json = { origin: ORIGIN, cookie, "content-type": "application/json" };
  return [
    ["GET /api/account-identities", () => app.request(`${ORIGIN}/api/account-identities`, { headers: json })],
    ["POST /api/account-identities/link-intents", () => app.request(`${ORIGIN}/api/account-identities/link-intents`, {
      method: "POST", headers: json, body: JSON.stringify({ providerId: "google" }),
    })],
    ["GET /api/account-identities/email-change", () => app.request(`${ORIGIN}/api/account-identities/email-change`, { headers: json })],
    ["POST /api/account-identities/email-change", () => app.request(`${ORIGIN}/api/account-identities/email-change`, {
      method: "POST", headers: json, body: JSON.stringify({}),
    })],
    ["POST /api/account-identities/password", () => app.request(`${ORIGIN}/api/account-identities/password`, {
      method: "POST", headers: json, body: JSON.stringify({}),
    })],
    ["POST /api/account-identities/password/enrollment", () => app.request(`${ORIGIN}/api/account-identities/password/enrollment`, {
      method: "POST", headers: json, body: JSON.stringify({}),
    })],
  ] as const;
}

describe("session cookie cache and identity-sensitive routes", () => {
  it("refuses a revoked session on every sensitive route while its cached copy is still valid", async () => {
    const { userId, token } = await seedSession();
    const cookie = await cachedSessionCookie(token);

    const before = await app.request(`${ORIGIN}/api/account-identities`, {
      headers: { origin: ORIGIN, cookie },
    });
    expect(before.status).toBe(200);

    // Revocation: sign-out elsewhere, password reset and revoke-other-sessions
    // all remove the session row.
    await db.delete(authSession).where(eq(authSession.userId, userId));

    // Control: the cached copy is still accepted where the cache is allowed,
    // so the refusals below come from bypassing it, not from a dead cookie.
    const cached = await app.request(`${ORIGIN}/api/auth/get-session`, {
      headers: { origin: ORIGIN, cookie },
    });
    expect(cached.status).toBe(200);
    expect((await cached.json() as { user?: { id?: string } } | null)?.user?.id).toBe(userId);

    for (const [name, send] of sensitiveRequests(cookie)) {
      const response = await send();
      expect(response.status, name).toBe(401);
    }
  });
});
