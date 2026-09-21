import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../app";
import {
  ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_MAX,
  ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX,
} from "../account-identities/reverification-rate-limit";
import { serverConfig } from "../config";
import {
  accountEmailChangeAudit,
  accountIdentityAudit,
} from "../db/app-schema";
import {
  organization as authOrganization,
  rateLimit,
  user as authUser,
} from "../db/auth-schema";
import { db, pool } from "../db/client";
import { createAccountIdentityRoutes } from "../routes/account-identities";

const TEST_ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "test-only-password-345";
let email = "";
let userId = "";
let organizationId = "";
let cookie = "";

function headers(sessionCookie = cookie, origin = TEST_ORIGIN) {
  return {
    "content-type": "application/json",
    origin,
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
  };
}

beforeAll(async () => {
  email = `st067-route-${randomUUID()}@example.test`;
  await db.delete(rateLimit);
  const signUp = await app.request(`${TEST_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: headers(""),
    body: JSON.stringify({ name: "Identity route", email, password: PASSWORD }),
  });
  expect(signUp.status).toBe(200);
  const verificationToken = await createEmailVerificationToken(serverConfig.authSecret, email);
  const verify = await app.request(
    `${TEST_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`,
    { headers: headers("") },
  );
  expect(verify.status).toBe(200);
  const signIn = await app.request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: headers(""),
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(signIn.status).toBe(200);
  cookie = signIn.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0] ?? "";
  expect(cookie).toBeTruthy();
  const [user] = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email));
  userId = user!.id;
  const organizationResponse = await app.request(`${TEST_ORIGIN}/api/auth/organization/create`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: "Identity route Atlas", slug: `st067-${randomUUID()}` }),
  });
  expect(organizationResponse.status).toBe(200);
  organizationId = ((await organizationResponse.json()) as { id: string }).id;
});

afterAll(async () => {
  if (userId) {
    await db.delete(accountEmailChangeAudit).where(eq(accountEmailChangeAudit.userId, userId));
    await db.delete(accountIdentityAudit).where(eq(accountIdentityAudit.userId, userId));
  }
  if (organizationId) await db.delete(authOrganization).where(eq(authOrganization.id, organizationId));
  if (email) await db.delete(authUser).where(eq(authUser.email, email));
  await pool.end();
});

describe("account identity HTTP boundary", () => {
  it("lists only redacted method state for the current user", async () => {
    const response = await app.request(`${TEST_ORIGIN}/api/account-identities`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      methods: Array<Record<string, unknown>>;
      availableLinkProviders: string[];
    };
    expect(body.methods).toHaveLength(1);
    expect(body.availableLinkProviders).toEqual([]);
    expect(body.methods[0]).toMatchObject({
      type: "password",
      providerId: "credential",
      verified: true,
      usable: true,
      canUnlink: false,
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain(PASSWORD);
    expect(encoded).not.toMatch(/passwordHash|accessToken|refreshToken|idToken/i);
    expect(body.methods[0]?.emailHint).not.toBe(email);
  });

  it("requires a matching Origin and the real current password before issuing a re-verification grant", async () => {
    const wrongOrigin = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(cookie, "https://evil.example"),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongPassword = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: "definitely-wrong-password" }),
    });
    expect(wrongPassword.status).toBe(403);

    const valid = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      reverificationToken: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it("rate-limits password reverification by stable user/session before another password check", async () => {
    await db.delete(rateLimit).where(like(
      rateLimit.key,
      `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:%`,
    ));

    for (let attempt = 0; attempt < ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_MAX; attempt += 1) {
      const refused = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
        method: "POST",
        headers: { ...headers(), "x-forwarded-for": "203.0.113.45" },
        body: JSON.stringify({ password: `wrong-password-${attempt}` }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "IDENTITY_REVERIFY_FAILED" });
    }

    const throttled = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: { ...headers(), "x-forwarded-for": "203.0.113.45" },
      body: JSON.stringify({ password: "one-more-wrong-password" }),
    });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await throttled.json()).toEqual({ error: "IDENTITY_REVERIFY_RATE_LIMITED" });

    // The native Better Auth verifier is not an escape hatch around the
    // dedicated identity-management budget. It is server-internal only, so a
    // valid password sent directly to the wildcard auth surface is refused.
    const nativeVerify = await app.request(`${TEST_ORIGIN}/api/auth/verify-password`, {
      method: "POST",
      headers: { ...headers(), "x-forwarded-for": "198.51.100.77" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(nativeVerify.status).toBe(404);
    expect(await nativeVerify.json()).toEqual({ error: "Not found" });

    // Rotating the address does not reopen the oracle: the stable user/session
    // buckets have already reached the same bound.
    const rotatedAddress = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: { ...headers(), "x-forwarded-for": "198.51.100.99" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(rotatedAddress.status).toBe(429);
    expect(await rotatedAddress.json()).toEqual({ error: "IDENTITY_REVERIFY_RATE_LIMITED" });

    await db.delete(rateLimit).where(like(
      rateLimit.key,
      `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:%`,
    ));
  });

  it("keeps native Better Auth identity-management endpoints fail-closed", async () => {
    const nativeList = await app.request(`${TEST_ORIGIN}/api/auth/list-accounts`, {
      headers: headers(),
    });
    expect(nativeList.status).toBe(404);

    const nativeUnlink = await app.request(`${TEST_ORIGIN}/api/auth/unlink-account`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ providerId: "credential" }),
    });
    expect(nativeUnlink.status).toBe(404);

    const nativeLink = await app.request(`${TEST_ORIGIN}/api/auth/link-social`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ provider: "google" }),
    });
    expect(nativeLink.status).toBe(404);

    const nativeVerify = await app.request(`${TEST_ORIGIN}/api/auth/verify-password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(nativeVerify.status).toBe(404);
    expect(await nativeVerify.json()).toEqual({ error: "Not found" });

    const nativeChangeEmail = await app.request(`${TEST_ORIGIN}/api/auth/change-email`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ newEmail: `native-bypass-${randomUUID()}@example.test` }),
    });
    expect(nativeChangeEmail.status).toBe(404);
  });

  it("starts the bounded email-change transaction without exposing proof tokens", async () => {
    const reverify = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(reverify.status).toBe(200);
    const grant = await reverify.json() as { reverificationToken: string };

    const proposedEmail = `st089-next-${randomUUID()}@example.test`;
    const start = await app.request(`${TEST_ORIGIN}/api/account-identities/email-change`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        newEmail: proposedEmail,
        reverificationToken: grant.reverificationToken,
      }),
    });
    expect(start.status).toBe(201);
    const body = await start.json() as { change: Record<string, unknown> };
    expect(body.change).toMatchObject({
      currentEmail: email,
      proposedEmail,
      status: "pending",
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toMatch(/oldProof|newProof|token/i);

    const status = await app.request(`${TEST_ORIGIN}/api/account-identities/email-change`, {
      headers: headers(),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      change: { proposedEmail, status: "pending" },
    });
  });

  it("refuses an old-address-unavailable shortcut before consuming another proof", async () => {
    const reverify = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: PASSWORD }),
    });
    const grant = await reverify.json() as { reverificationToken: string };
    const refused = await app.request(`${TEST_ORIGIN}/api/account-identities/email-change`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        newEmail: `st089-recovery-${randomUUID()}@example.test`,
        reverificationToken: grant.reverificationToken,
        oldAddressAvailable: false,
      }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "EMAIL_CHANGE_RECOVERY_REQUIRED" });
  });

  it("advertises exactly the providers the link-intent write path accepts", async () => {
    await db.delete(rateLimit).where(like(
      rateLimit.key,
      `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:%`,
    ));

    const configured = new Hono();
    configured.route(
      "/api/account-identities",
      createAccountIdentityRoutes({ linkableProviderIds: new Set(["fake-provider"]) }),
    );
    const configuredRead = await configured.request(`${TEST_ORIGIN}/api/account-identities`, {
      headers: headers(),
    });
    expect(configuredRead.status).toBe(200);
    const configuredBody = await configuredRead.json() as {
      methods: Array<Record<string, unknown>>;
      availableLinkProviders: string[];
    };
    expect(configuredBody.availableLinkProviders).toEqual(["fake-provider"]);
    // The method shape stays exactly what #345 shipped; capability discovery is additive.
    expect(configuredBody.methods).toHaveLength(1);
    expect(configuredBody.methods[0]).toMatchObject({
      type: "password",
      providerId: "credential",
      verified: true,
      usable: true,
      canUnlink: false,
    });
    const configuredEncoded = JSON.stringify(configuredBody);
    expect(configuredEncoded).not.toContain(PASSWORD);
    expect(configuredEncoded).not.toMatch(/passwordHash|accessToken|refreshToken|idToken/i);

    // A provider that is only usable for an existing link is never advertised
    // as linkable, because the capability list reads the linkable set alone.
    const split = new Hono();
    split.route(
      "/api/account-identities",
      createAccountIdentityRoutes({
        usableProviderIds: new Set(["usable-only-provider"]),
        linkableProviderIds: new Set(["fake-provider"]),
      }),
    );
    const splitRead = await split.request(`${TEST_ORIGIN}/api/account-identities`, {
      headers: headers(),
    });
    expect(splitRead.status).toBe(200);
    const splitBody = await splitRead.json() as { availableLinkProviders: string[] };
    expect(splitBody.availableLinkProviders).toEqual(["fake-provider"]);

    // One shared effective set: the advertised provider is accepted by the
    // write path and the unadvertised one is refused as not configured. That
    // provider gate runs before any proof is consumed, so the negative case
    // needs no grant of its own.
    const unadvertised = await split.request(`${TEST_ORIGIN}/api/account-identities/link-intents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        providerId: "usable-only-provider",
        reverificationToken: "unused-because-the-provider-gate-runs-first",
      }),
    });
    expect(unadvertised.status).toBe(403);
    expect(await unadvertised.json()).toEqual({ error: "IDENTITY_PROVIDER_NOT_CONFIGURED" });

    const reverify = await split.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(reverify.status).toBe(200);
    const grant = await reverify.json() as { reverificationToken: string };
    const advertised = await split.request(`${TEST_ORIGIN}/api/account-identities/link-intents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        providerId: splitBody.availableLinkProviders[0],
        reverificationToken: grant.reverificationToken,
      }),
    });
    expect(advertised.status).toBe(200);
    expect(await advertised.json()).toMatchObject({
      actionId: expect.any(String),
      intentToken: expect.any(String),
    });

    await db.delete(rateLimit).where(like(
      rateLimit.key,
      `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:%`,
    ));
  });

  it("fails link intent closed while no provider is configured", async () => {
    const reverify = await app.request(`${TEST_ORIGIN}/api/account-identities/reverify/password`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: PASSWORD }),
    });
    const reverifyBody = await reverify.json() as { reverificationToken: string };
    const link = await app.request(`${TEST_ORIGIN}/api/account-identities/link-intents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ providerId: "google", reverificationToken: reverifyBody.reverificationToken }),
    });
    expect(link.status).toBe(403);
    expect(await link.json()).toEqual({ error: "IDENTITY_PROVIDER_NOT_CONFIGURED" });
  });
});
