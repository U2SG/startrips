import { describe, expect, it } from "vitest";
import {
  IDENTITY_BIND_STATE_MAX_AGE_MS,
  issueIdentityBindState,
  readIdentityBindState,
} from "./identity-bind-state";

const SECRET = "st132-identity-bind-secret";
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function bind(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "google",
    actionId: "11111111-2222-3333-4444-555555555555",
    userId: "user-1",
    sessionId: "session-1",
    state: "s".repeat(43),
    codeVerifier: "v".repeat(86),
    returnPath: "/account",
    ...overrides,
  } as Parameters<typeof issueIdentityBindState>[1];
}

describe("identity bind state", () => {
  it("round-trips the fields the callback trusts", () => {
    const token = issueIdentityBindState(SECRET, bind(), NOW);
    const parsed = readIdentityBindState(SECRET, token, NOW + 1_000);
    expect(parsed?.userId).toBe("user-1");
    expect(parsed?.sessionId).toBe("session-1");
    expect(parsed?.actionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(parsed?.codeVerifier).toBe("v".repeat(86));
    expect(parsed?.returnPath).toBe("/account");
  });

  it("refuses a token signed with another secret", () => {
    const token = issueIdentityBindState("another-secret", bind(), NOW);
    expect(readIdentityBindState(SECRET, token, NOW)).toBeNull();
  });

  it("refuses a payload edited after signing", () => {
    const token = issueIdentityBindState(SECRET, bind(), NOW);
    const [payload, signature] = token.split(".");
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    edited.userId = "user-2";
    const forged = `${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
    expect(readIdentityBindState(SECRET, forged, NOW)).toBeNull();
  });

  it("expires with the authorization round trip", () => {
    const token = issueIdentityBindState(SECRET, bind(), NOW);
    expect(readIdentityBindState(SECRET, token, NOW + IDENTITY_BIND_STATE_MAX_AGE_MS - 1)).not.toBeNull();
    expect(readIdentityBindState(SECRET, token, NOW + IDENTITY_BIND_STATE_MAX_AGE_MS + 1)).toBeNull();
  });

  it("refuses a return target that leaves the origin", () => {
    const token = issueIdentityBindState(SECRET, bind({ returnPath: "//evil.test/" }), NOW);
    expect(readIdentityBindState(SECRET, token, NOW)).toBeNull();
  });

  it("refuses a code verifier outside the PKCE length range", () => {
    const short = issueIdentityBindState(SECRET, bind({ codeVerifier: "v".repeat(42) }), NOW);
    expect(readIdentityBindState(SECRET, short, NOW)).toBeNull();
  });
});
