import { describe, expect, it, vi } from "vitest";
import {
  consumeVerifiedIdToken,
  idTokenAcceptanceWindowEnd,
  idTokenDigest,
  type IdTokenConsumptionStore,
} from "./id-token-consumption";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

function token(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${segment({ alg: "ES256" })}.${segment(claims)}.signature`;
}

/** A store that records what it was asked to do and always succeeds once. */
function recordingStore() {
  const claimed = new Set<string>();
  const pruned: Date[] = [];
  const store: IdTokenConsumptionStore = {
    async prune(expiredAt) {
      pruned.push(expiredAt);
    },
    async claim(record) {
      if (claimed.has(record.tokenDigest)) return false;
      claimed.add(record.tokenDigest);
      return true;
    },
  };
  return { store, claimed, pruned };
}

describe("id token acceptance window", () => {
  it("ends at the provider's one-hour age limit when that comes first", () => {
    const issuedAt = Math.floor(NOW / 1000);
    const value = token({ iat: issuedAt, exp: issuedAt + 24 * 60 * 60 });
    expect(idTokenAcceptanceWindowEnd(value, NOW)).toBe(NOW + HOUR_MS);
  });

  it("ends at the token's own expiry when that comes first", () => {
    const issuedAt = Math.floor(NOW / 1000);
    const value = token({ iat: issuedAt, exp: issuedAt + 600 });
    expect(idTokenAcceptanceWindowEnd(value, NOW)).toBe(NOW + 600_000);
  });

  it("falls back to the full age limit from now when the claims are unreadable", () => {
    expect(idTokenAcceptanceWindowEnd("not-a-jwt", NOW)).toBe(NOW + HOUR_MS);
    expect(idTokenAcceptanceWindowEnd("header.%%%.signature", NOW)).toBe(NOW + HOUR_MS);
    expect(idTokenAcceptanceWindowEnd(token({ sub: "x" }), NOW)).toBe(NOW + HOUR_MS);
  });
});

describe("consuming a verified id token", () => {
  const issuedAt = Math.floor(NOW / 1000);
  const value = token({ iat: issuedAt, exp: issuedAt + 600, sub: "apple-subject" });

  it("accepts the first presentation and refuses every later one", async () => {
    const { store } = recordingStore();
    expect(await consumeVerifiedIdToken({ providerId: "apple", token: value }, store, NOW))
      .toBe(true);
    expect(await consumeVerifiedIdToken({ providerId: "apple", token: value }, store, NOW))
      .toBe(false);
  });

  it("records a digest and the acceptance window, never the token", async () => {
    const { store, claimed } = recordingStore();
    const records: unknown[] = [];
    const claim = vi.fn(async (record: Parameters<IdTokenConsumptionStore["claim"]>[0]) => {
      records.push(record);
      return store.claim(record);
    });
    await consumeVerifiedIdToken(
      { providerId: "apple", token: value },
      { prune: store.prune, claim },
      NOW,
    );
    expect(records).toEqual([{
      tokenDigest: idTokenDigest("apple", value),
      providerId: "apple",
      expiresAt: new Date(NOW + 600_000),
    }]);
    expect(JSON.stringify(records)).not.toContain(value);
    expect([...claimed][0]).not.toContain(value);
  });

  it("keeps one provider's digest distinct from another's", () => {
    expect(idTokenDigest("apple", value)).not.toBe(idTokenDigest("google", value));
  });

  it("prunes only what the clock has already put past its window", async () => {
    const { store, pruned } = recordingStore();
    await consumeVerifiedIdToken({ providerId: "apple", token: value }, store, NOW);
    expect(pruned).toEqual([new Date(NOW)]);
  });

  it("refuses the token when the replay store cannot be claimed", async () => {
    const failing: IdTokenConsumptionStore = {
      async prune() {},
      async claim() {
        throw new Error("replay store unavailable");
      },
    };
    expect(await consumeVerifiedIdToken({ providerId: "apple", token: value }, failing, NOW))
      .toBe(false);
  });

  it("refuses the token when the replay store cannot even be pruned", async () => {
    const failing: IdTokenConsumptionStore = {
      async prune() {
        throw new Error("replay store unavailable");
      },
      async claim() {
        return true;
      },
    };
    expect(await consumeVerifiedIdToken({ providerId: "apple", token: value }, failing, NOW))
      .toBe(false);
  });
});
