import { describe, expect, it } from "vitest";
import {
  evaluateShareGrant,
  generateShareToken,
  hashShareToken,
  parseBearerToken,
  SHARE_TOKEN_LENGTH,
} from "./share-access";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function grant(overrides: {
  expiresAt?: Date;
  revokedAt?: Date | null;
  atlasDeletionStartedAt?: Date | null;
}) {
  return {
    expiresAt: new Date("2026-09-10T12:00:00.000Z"),
    revokedAt: null,
    atlasDeletionStartedAt: null,
    ...overrides,
  };
}

describe("share token generation", () => {
  it("produces 32 bytes of base64url with no padding", () => {
    const token = generateShareToken();
    expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
  });

  it("never repeats a token", () => {
    const tokens = new Set(
      Array.from({ length: 64 }, () => generateShareToken()),
    );
    expect(tokens.size).toBe(64);
  });
});

describe("share token hashing", () => {
  // A published SHA-256 vector, so this binds the algorithm rather than the
  // wrapper agreeing with itself.
  it("is plain SHA-256 hex", () => {
    expect(hashShareToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and never returns the raw token", () => {
    const token = generateShareToken();
    const digest = hashShareToken(token);
    expect(digest).toBe(hashShareToken(token));
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(token);
  });
});

describe("bearer token parsing", () => {
  it("accepts the scheme case-insensitively", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
    expect(parseBearerToken("bearer abc123")).toBe("abc123");
    expect(parseBearerToken("BEARER abc123")).toBe("abc123");
    expect(parseBearerToken("  Bearer   abc123  ")).toBe("abc123");
  });

  it("rejects a missing header, a wrong scheme, or an empty token", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
    expect(parseBearerToken("Basic abc123")).toBeNull();
    expect(parseBearerToken("abc123")).toBeNull();
    expect(parseBearerToken("Bearer abc 123")).toBeNull();
  });
});

describe("share grant evaluation", () => {
  it("is active strictly before the expiry instant", () => {
    expect(evaluateShareGrant(grant({}), NOW)).toBe("active");
    expect(
      evaluateShareGrant(
        grant({ expiresAt: new Date(NOW.valueOf() + 1) }),
        NOW,
      ),
    ).toBe("active");
  });

  it("treats the expiry instant itself as expired", () => {
    expect(evaluateShareGrant(grant({ expiresAt: NOW }), NOW)).toBe("expired");
    expect(
      evaluateShareGrant(
        grant({ expiresAt: new Date(NOW.valueOf() - 1) }),
        NOW,
      ),
    ).toBe("expired");
  });

  it("reports revocation ahead of a later expiry", () => {
    expect(
      evaluateShareGrant(
        grant({ revokedAt: new Date("2026-09-02T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe("revoked");
    expect(
      evaluateShareGrant(
        grant({
          expiresAt: new Date(NOW.valueOf() - 1),
          revokedAt: new Date("2026-09-02T00:00:00.000Z"),
        }),
        NOW,
      ),
    ).toBe("revoked");
  });

  it("fails an otherwise valid grant once its atlas starts deleting", () => {
    expect(
      evaluateShareGrant(grant({ atlasDeletionStartedAt: NOW }), NOW),
    ).toBe("atlas-unavailable");
  });
});
