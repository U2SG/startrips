import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  coverRevealDerivatives,
  coverRevealWrites,
} from "../db/app-schema";
import {
  generateCoverRevealLeaseToken,
  generateCoverRevealWorkerToken,
  hashCoverRevealLeaseToken,
  matchesCoverRevealWorkerToken,
  MIN_COVER_REVEAL_WORKER_TOKEN_LENGTH,
  parseWorkerBearerToken,
} from "./worker-credential";

/**
 * The durable secret surface of #368, asserted rather than described.
 *
 * A signed read URL, a signed upload URL, a raw lease token and a storage
 * master credential are the four things this protocol handles that must never
 * become a row. Prose in a schema comment does not stop a later column from
 * being added, so the column set is pinned here: adding one fails this file,
 * which is the point.
 */
const DERIVATIVE_COLUMNS = [
  "id",
  "journeyId",
  "sourceMediaAssetId",
  "sourceContentHash",
  "generationKind",
  "generationVersion",
  "presetId",
  "seed",
  "outputStorageDriver",
  "outputStorageKey",
  "outputMimeType",
  "outputBytes",
  "outputWidth",
  "outputHeight",
  "state",
  "leaseTokenHash",
  "leaseExpiresAt",
  "attempts",
  "lastErrorCode",
  "supersededAt",
  "createdAt",
  "updatedAt",
] as const;

const WRITE_COLUMNS = [
  "id",
  "derivativeId",
  "storageDriver",
  "storageKey",
  "expiresAt",
  "createdAt",
] as const;

/** Every source file that may touch a URL, a credential or a lease token. */
const COVER_REVEAL_SOURCES = [
  "../services/cover-reveal.ts",
  "../routes/cover-reveal.ts",
  "./worker-credential.ts",
  "./eligibility.ts",
] as const;

function sourceOf(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("#368 cover-reveal durable secret surface", () => {
  it("persists no signed URL, no raw lease token and no storage credential", () => {
    const derivativeColumns = Object.keys(
      getTableColumns(coverRevealDerivatives),
    );
    const writeColumns = Object.keys(getTableColumns(coverRevealWrites));

    expect([...derivativeColumns].sort())
      .toEqual([...DERIVATIVE_COLUMNS].sort());
    expect([...writeColumns].sort()).toEqual([...WRITE_COLUMNS].sort());

    // The name-shaped half of the same assertion, so a column added under a
    // new name still has to justify itself: nothing may look like a URL or a
    // credential, and the only lease column is a hash.
    for (const column of [...derivativeColumns, ...writeColumns]) {
      expect(column).not.toMatch(/url/i);
      expect(column).not.toMatch(/secret|credential|password|accesskey/i);
      if (/lease/i.test(column)) {
        expect(column).toMatch(/^lease(TokenHash|ExpiresAt)$/);
      }
    }
    // `storageKey` / `outputStorageKey` are object identity, which is exactly
    // what the contract says may be stored. They are named here so the
    // allowlist above is a deliberate decision rather than an oversight.
    expect(derivativeColumns).toContain("outputStorageKey");
    expect(writeColumns).toContain("storageKey");
  });

  it("logs no token, URL or credential from any cover-reveal module", () => {
    for (const relativePath of COVER_REVEAL_SOURCES) {
      const source = sourceOf(relativePath);
      const logCalls = source.match(/console\.\w+\(([\s\S]*?)\n\s*\);/g) ?? [];
      for (const call of logCalls) {
        // The arguments only; a doc comment above a call is not a log line.
        expect(call).not.toMatch(/token/i);
        expect(call).not.toMatch(/\burl\b/i);
        expect(call).not.toMatch(/credential/i);
        expect(call).not.toMatch(/\bsecret\b/i);
      }
    }
  });

  it("stores only the SHA-256 of a lease token", () => {
    const token = generateCoverRevealLeaseToken();
    const hash = hashCoverRevealLeaseToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(token).not.toContain(hash);
    // Deterministic, because the lookup that resolves a claimant is a lookup
    // by hash rather than a comparison in application code.
    expect(hashCoverRevealLeaseToken(token)).toBe(hash);
    expect(hashCoverRevealLeaseToken(generateCoverRevealLeaseToken()))
      .not.toBe(hash);
  });

  it("mints a worker credential above the configured entropy floor", () => {
    const token = generateCoverRevealWorkerToken();
    expect(token.length).toBeGreaterThanOrEqual(
      MIN_COVER_REVEAL_WORKER_TOKEN_LENGTH,
    );
    expect(matchesCoverRevealWorkerToken(token, token)).toBe(true);
    expect(matchesCoverRevealWorkerToken(token, `${token}x`)).toBe(false);
    // A comparison over fixed-width digests, so a credential of a different
    // length is answered rather than throwing the way a raw `timingSafeEqual`
    // over unequal buffers would.
    expect(matchesCoverRevealWorkerToken("short", token)).toBe(false);
  });

  it("accepts only a well-formed bearer header", () => {
    expect(parseWorkerBearerToken("Bearer abc")).toBe("abc");
    expect(parseWorkerBearerToken("bearer abc")).toBe("abc");
    expect(parseWorkerBearerToken("Basic abc")).toBeNull();
    expect(parseWorkerBearerToken(null)).toBeNull();
    expect(parseWorkerBearerToken("Bearer ")).toBeNull();
  });
});
