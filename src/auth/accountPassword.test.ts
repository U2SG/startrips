import { describe, expect, it } from "vitest";
import {
  AccountPasswordRefusal,
  accountPasswordRefusalText,
  loadAccountIdentityMethods,
  passwordWriteRevokesOtherSessions,
  resolveAccountPasswordState,
  submitAccountPasswordChange,
  submitAccountPasswordEnrollment,
  type AccountIdentityMethod,
} from "./accountPassword";

const REVERIFY_URL = "/api/account-identities/reverify/password";
const CHANGE_URL = "/api/account-identities/password";
const ENROLLMENT_URL = "/api/account-identities/password/enrollment";

function method(overrides: Partial<AccountIdentityMethod> = {}): AccountIdentityMethod {
  return {
    id: "account-1",
    type: "password",
    providerId: "credential",
    emailHint: "tr…@startrips.test",
    verified: true,
    usable: true,
    canUnlink: false,
    ...overrides,
  };
}

type Reply = { status?: number; body: unknown };

function stubFetch(replies: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request: ${url}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("account password state", () => {
  it("offers a change only while a usable credential exists", () => {
    expect(resolveAccountPasswordState([method()], { email: "a@b.test", emailVerified: true }))
      .toEqual({ kind: "change" });
  });

  it("offers enrollment to a credential-less Account with a verified address", () => {
    expect(resolveAccountPasswordState([], { email: "a@b.test", emailVerified: true }))
      .toEqual({ kind: "enroll" });
    // A credential row whose password is unset reads as unusable, not as a
    // password the person could type into a current-password field.
    expect(resolveAccountPasswordState(
      [method({ usable: false })],
      { email: "a@b.test", emailVerified: true },
    )).toEqual({ kind: "enroll" });
  });

  it("asks for recovery instead of an enrollment form without a usable address", () => {
    expect(resolveAccountPasswordState([], { email: "a@b.test", emailVerified: false }))
      .toEqual({ kind: "recover", reason: "email-unverified" });
    expect(resolveAccountPasswordState([], { email: null, emailVerified: true }))
      .toEqual({ kind: "recover", reason: "email-missing" });
    // A password that exists but cannot be recovered is still not a change
    // surface: the address that would recover it is unverified.
    expect(resolveAccountPasswordState(
      [method({ usable: false, verified: false })],
      { email: "a@b.test", emailVerified: false },
    )).toEqual({ kind: "recover", reason: "email-unverified" });
  });

  it("reads the authoritative identity list rather than the session user", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/api/account-identities": { body: { methods: [method()] } },
    });
    expect(await loadAccountIdentityMethods({ fetchImpl })).toEqual([method()]);
    expect(calls[0]?.init?.credentials).toBe("include");
  });
});

describe("account password writes", () => {
  it("claims a grant and spends it on the change route", async () => {
    const { fetchImpl, calls } = stubFetch({
      [REVERIFY_URL]: { body: { reverificationToken: "grant-1", expiresAt: "2026-09-20T00:05:00Z" } },
      [CHANGE_URL]: { body: { status: true, changed: true, alreadyChanged: false, revokedOtherSessions: 2 } },
    });
    let refreshed = 0;
    const result = await submitAccountPasswordChange(
      { currentPassword: "old-password-1", newPassword: "new-password-1" },
      { fetchImpl, refreshSession: async () => { refreshed += 1; } },
    );

    expect(calls.map((call) => call.url)).toEqual([REVERIFY_URL, CHANGE_URL]);
    expect(sentBody(calls[0].init)).toEqual({ password: "old-password-1" });
    expect(sentBody(calls[1].init)).toEqual({
      currentPassword: "old-password-1",
      newPassword: "new-password-1",
      reverificationToken: "grant-1",
    });
    expect(result).toEqual({ applied: true, alreadyApplied: false, revokedOtherSessions: 2 });
    expect(refreshed).toBe(1);
  });

  it("sends a credential-less Account to the enrollment route, which revokes nothing", async () => {
    const { fetchImpl, calls } = stubFetch({
      [REVERIFY_URL]: { body: { reverificationToken: "grant-2" } },
      [ENROLLMENT_URL]: { body: { status: true, enrolled: true, alreadyEnrolled: false } },
    });
    let refreshed = 0;
    const result = await submitAccountPasswordEnrollment(
      { newPassword: "first-password-1", reverification: { kind: "password", password: "proof-1" } },
      { fetchImpl, refreshSession: async () => { refreshed += 1; } },
    );

    expect(calls.map((call) => call.url)).toEqual([REVERIFY_URL, ENROLLMENT_URL]);
    expect(sentBody(calls[1].init)).toEqual({
      newPassword: "first-password-1",
      reverificationToken: "grant-2",
    });
    expect(result).toEqual({ applied: true, alreadyApplied: false, revokedOtherSessions: 0 });
    expect(refreshed).toBe(1);
    // The server's documented asymmetry: a change rotates a shared secret and
    // revokes other sessions, enrollment adds a method and keeps them.
    expect(passwordWriteRevokesOtherSessions("change")).toBe(true);
    expect(passwordWriteRevokesOtherSessions("enroll")).toBe(false);
  });

  it("reports the same grant's completed write instead of repeating it", async () => {
    const { fetchImpl } = stubFetch({
      [REVERIFY_URL]: { body: { reverificationToken: "grant-3" } },
      [CHANGE_URL]: { body: { status: true, changed: false, alreadyChanged: true, revokedOtherSessions: 0 } },
    });
    expect(await submitAccountPasswordChange(
      { currentPassword: "old-password-1", newPassword: "new-password-1" },
      { fetchImpl },
    )).toEqual({ applied: false, alreadyApplied: true, revokedOtherSessions: 0 });
  });

  it("surfaces the typed refusal of either leg and never refreshes on failure", async () => {
    const refused = stubFetch({
      [REVERIFY_URL]: { body: { reverificationToken: "grant-4" } },
      [CHANGE_URL]: { status: 403, body: { error: "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID" } },
    });
    let refreshed = 0;
    await expect(submitAccountPasswordChange(
      { currentPassword: "wrong-password", newPassword: "new-password-1" },
      { fetchImpl: refused.fetchImpl, refreshSession: async () => { refreshed += 1; } },
    )).rejects.toMatchObject({ code: "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID" });
    expect(refreshed).toBe(0);

    const rateLimited = stubFetch({
      [REVERIFY_URL]: { status: 429, body: { error: "IDENTITY_REVERIFY_RATE_LIMITED" } },
    });
    await expect(submitAccountPasswordChange(
      { currentPassword: "old-password-1", newPassword: "new-password-1" },
      { fetchImpl: rateLimited.fetchImpl },
    )).rejects.toBeInstanceOf(AccountPasswordRefusal);
  });

  it("keeps every password, grant and token out of URLs and returned state", async () => {
    const { fetchImpl, calls } = stubFetch({
      [REVERIFY_URL]: { body: { reverificationToken: "grant-5" } },
      [CHANGE_URL]: { body: { status: true, changed: true, alreadyChanged: false, revokedOtherSessions: 0 } },
    });
    const result = await submitAccountPasswordChange(
      { currentPassword: "old-password-1", newPassword: "new-password-1" },
      { fetchImpl },
    );

    for (const call of calls) {
      expect(call.url).not.toContain("old-password-1");
      expect(call.url).not.toContain("new-password-1");
      expect(call.url).not.toContain("grant-5");
      expect(call.url.includes("?")).toBe(false);
    }
    const snapshot = JSON.stringify(result);
    expect(snapshot).not.toContain("grant-5");
    expect(snapshot).not.toContain("password-1");
  });
});

describe("account password refusal text", () => {
  it("gives each typed refusal its own sentence", () => {
    const codes = [
      "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID",
      "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND",
      "PASSWORD_CHANGE_REVERIFY_EXPIRED",
      "PASSWORD_CHANGE_SESSION_CHANGED",
      "PASSWORD_ENROLL_ACCOUNT_NOT_FOUND",
      "PASSWORD_ENROLL_ALREADY_SET",
      "PASSWORD_ENROLL_RECOVERY_REQUIRED",
      "IDENTITY_REVERIFY_RATE_LIMITED",
    ];
    const texts = codes.map(accountPasswordRefusalText);
    expect(new Set(texts).size).toBe(codes.length);
    for (const text of texts) {
      expect(text).not.toMatch(/PASSWORD_|IDENTITY_/);
    }
  });

  it("covers every code the two write routes and the grant route can answer with", () => {
    const fallback = accountPasswordRefusalText("SOMETHING_UNMAPPED");
    const served = [
      "PASSWORD_CHANGE_INVALID",
      "PASSWORD_CHANGE_ACCOUNT_NOT_FOUND",
      "PASSWORD_CHANGE_REVERIFY_INVALID",
      "PASSWORD_CHANGE_REVERIFY_EXPIRED",
      "PASSWORD_CHANGE_REVERIFY_REPLAYED",
      "PASSWORD_CHANGE_SESSION_CHANGED",
      "PASSWORD_CHANGE_SESSION_EXPIRED",
      "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND",
      "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID",
      "PASSWORD_CHANGE_PASSWORD_TOO_SHORT",
      "PASSWORD_CHANGE_PASSWORD_TOO_LONG",
      "PASSWORD_CHANGE_ORIGIN_REQUIRED",
      "PASSWORD_ENROLL_INVALID",
      "PASSWORD_ENROLL_ACCOUNT_NOT_FOUND",
      "PASSWORD_ENROLL_REVERIFY_INVALID",
      "PASSWORD_ENROLL_REVERIFY_EXPIRED",
      "PASSWORD_ENROLL_REVERIFY_REPLAYED",
      "PASSWORD_ENROLL_SESSION_CHANGED",
      "PASSWORD_ENROLL_SESSION_EXPIRED",
      "PASSWORD_ENROLL_RECOVERY_REQUIRED",
      "PASSWORD_ENROLL_ALREADY_SET",
      "PASSWORD_ENROLL_PASSWORD_TOO_SHORT",
      "PASSWORD_ENROLL_PASSWORD_TOO_LONG",
      "PASSWORD_ENROLL_ORIGIN_REQUIRED",
      "IDENTITY_ORIGIN_REQUIRED",
      "INVALID_IDENTITY_REVERIFY",
      "IDENTITY_REVERIFY_FAILED",
      "IDENTITY_REVERIFY_RATE_LIMITED",
      "UNAUTHORIZED",
    ];
    for (const code of served) {
      expect(accountPasswordRefusalText(code)).not.toBe(fallback);
    }
  });
});
