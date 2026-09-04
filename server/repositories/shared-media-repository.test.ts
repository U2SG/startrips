import { describe, expect, it } from "vitest";
import { capShareMediaTtlSeconds } from "./shared-media-repository";

const LIMITS = { shareTtlSeconds: 90, ownerTtlSeconds: 900 };
const NOW = new Date("2026-09-04T12:00:00.000Z");

function inSeconds(seconds: number): Date {
  return new Date(NOW.valueOf() + seconds * 1000);
}

/**
 * #200 phase C, the TTL cap. A presigned storage URL cannot be revoked, so the
 * only promise the server can keep is that it never issues one that outlives
 * the grant it came from. That promise is entirely this function.
 */
describe("share media TTL cap", () => {
  it("uses the share ceiling while the grant has plenty of time left", () => {
    expect(capShareMediaTtlSeconds(LIMITS, inSeconds(3600), NOW)).toBe(90);
  });

  it("caps the TTL at the grant's remaining lifetime", () => {
    expect(capShareMediaTtlSeconds(LIMITS, inSeconds(30), NOW)).toBe(30);
  });

  it("never issues a URL that outlives the grant, at any remaining lifetime", () => {
    // The whole invariant as one sweep rather than one hand-picked instant.
    for (let remaining = 1; remaining <= 600; remaining += 1) {
      const expiresAt = inSeconds(remaining);
      const ttl = capShareMediaTtlSeconds(LIMITS, expiresAt, NOW);
      expect(NOW.valueOf() + ttl * 1000).toBeLessThanOrEqual(expiresAt.valueOf());
    }
  });

  it("floors a fractional remaining lifetime rather than rounding it up", () => {
    // 45.9s left must issue 45s, not 46s: rounding up would sign a URL valid
    // past the grant's own expiry.
    const expiresAt = new Date(NOW.valueOf() + 45_900);
    expect(capShareMediaTtlSeconds(LIMITS, expiresAt, NOW)).toBe(45);
  });

  it("caps the TTL at the owner ceiling when a deployment shortens it", () => {
    // A guest is never handed a longer-lived credential than a member of the
    // atlas would get, even when the guest knob is configured higher.
    expect(capShareMediaTtlSeconds(
      { shareTtlSeconds: 300, ownerTtlSeconds: 60 },
      inSeconds(3600),
      NOW,
    )).toBe(60);
  });

  it("returns zero for the final sub-second of a grant", () => {
    // `evaluateShareGrant` still calls this grant active, so the caller — not
    // the clock — has to refuse. Zero is the signal for that.
    expect(capShareMediaTtlSeconds(LIMITS, new Date(NOW.valueOf() + 400), NOW))
      .toBe(0);
  });

  it("returns zero rather than a negative TTL for an expired grant", () => {
    expect(capShareMediaTtlSeconds(LIMITS, inSeconds(-120), NOW)).toBe(0);
  });
});
