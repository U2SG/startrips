import { describe, expect, it } from "vitest";
import {
  MEDIA_READ_REFRESH_MARGIN_MS,
  mediaReadIsFresh,
  mediaReadRefreshAt,
  mediaReadRefreshDelayMs,
} from "./mediaReadRefresh";
import { playbackReadIsReusable } from "./JourneyPlaybackOverlay";

const OWNER_TTL_MS = 900_000;
const SHARE_TTL_MS = 90_000;
const ISSUED = 1_000_000;

describe("mediaReadRefreshAt", () => {
  it("keeps the previous owner behaviour: one margin before expiry", () => {
    expect(mediaReadRefreshAt(ISSUED, ISSUED + OWNER_TTL_MS))
      .toBe(ISSUED + OWNER_TTL_MS - MEDIA_READ_REFRESH_MARGIN_MS);
  });

  it("refreshes a share-scoped read at half its life, not on arrival", () => {
    // The default guest read lives 90 s. A fixed 60 s story margin would call
    // it stale 30 s in and a 30 s margin would give it only one refresh
    // window; half-life is the rule that scales with either.
    expect(mediaReadRefreshAt(ISSUED, ISSUED + SHARE_TTL_MS, 60_000))
      .toBe(ISSUED + SHARE_TTL_MS / 2);
  });

  it("never declares a read stale before it was issued", () => {
    // The floor case #200 makes reachable: a grant with seconds left caps the
    // presign below any margin.
    const shortTtlMs = 15_000;
    const refreshAt = mediaReadRefreshAt(ISSUED, ISSUED + shortTtlMs);
    expect(refreshAt).toBe(ISSUED + shortTtlMs / 2);
    expect(refreshAt).toBeGreaterThan(ISSUED);
  });

  it("handles an already-expired read without going backwards past issue", () => {
    expect(mediaReadRefreshAt(ISSUED, ISSUED)).toBe(ISSUED);
    expect(mediaReadRefreshAt(ISSUED, ISSUED - 5_000)).toBe(ISSUED);
  });
});

describe("mediaReadIsFresh", () => {
  it("reuses an owner read for almost its whole life", () => {
    const expiresAt = ISSUED + OWNER_TTL_MS;
    expect(mediaReadIsFresh(ISSUED, expiresAt, ISSUED + 1_000)).toBe(true);
    expect(mediaReadIsFresh(ISSUED, expiresAt, expiresAt - 60_000)).toBe(true);
    expect(mediaReadIsFresh(ISSUED, expiresAt, expiresAt - 1_000)).toBe(false);
  });

  it("stops reusing a share-scoped read before it expires", () => {
    const expiresAt = ISSUED + SHARE_TTL_MS;
    expect(mediaReadIsFresh(ISSUED, expiresAt, ISSUED + 30_000)).toBe(true);
    expect(mediaReadIsFresh(ISSUED, expiresAt, ISSUED + 61_000)).toBe(false);
    // The point of the change: the read is replaced BEFORE the URL dies, so
    // playback re-signs the asset instead of failing to load it.
    expect(mediaReadIsFresh(ISSUED, expiresAt, expiresAt)).toBe(false);
  });

  it("treats a read as fresh the instant it arrives, whatever its lifetime", () => {
    for (const ttl of [15_000, 60_000, 90_000, 600_000, OWNER_TTL_MS]) {
      expect(mediaReadIsFresh(ISSUED, ISSUED + ttl, ISSUED)).toBe(true);
    }
  });
});

describe("mediaReadRefreshDelayMs", () => {
  it("schedules the owner refresh where the fixed margin used to put it", () => {
    expect(mediaReadRefreshDelayMs(ISSUED, ISSUED + OWNER_TTL_MS, ISSUED))
      .toBe(OWNER_TTL_MS - MEDIA_READ_REFRESH_MARGIN_MS);
  });

  it("never schedules a zero or negative timer", () => {
    // A caller loops on this, so a non-positive delay would spin.
    expect(mediaReadRefreshDelayMs(ISSUED, ISSUED - 10_000, ISSUED)).toBe(1_000);
    expect(mediaReadRefreshDelayMs(ISSUED, ISSUED, ISSUED)).toBe(1_000);
  });

  it("falls back when the server sent an expiry this browser cannot parse", () => {
    expect(mediaReadRefreshDelayMs(ISSUED, Number.NaN, ISSUED)).toBe(5 * 60_000);
  });
});

describe("playbackReadIsReusable (#200 phase D)", () => {
  it("reuses a read that is still well inside its own lifetime", () => {
    expect(playbackReadIsReusable(
      { status: "ready", url: "signed", issuedAt: ISSUED, expiresAt: ISSUED + OWNER_TTL_MS },
      ISSUED + 60_000,
    )).toBe(true);
  });

  it("re-signs a share-scoped read that a long playback outlived", () => {
    // The overlay used to reuse a ready read forever. A 90 s guest URL
    // prefetched at the head of the window would then be handed to a chapter
    // minutes later, and the media element would fail to load it.
    expect(playbackReadIsReusable(
      { status: "ready", url: "signed", issuedAt: ISSUED, expiresAt: ISSUED + SHARE_TTL_MS },
      ISSUED + 120_000,
    )).toBe(false);
  });

  it("never reuses a missing, loading or failed read", () => {
    expect(playbackReadIsReusable(undefined, ISSUED)).toBe(false);
    expect(playbackReadIsReusable({ status: "loading" }, ISSUED)).toBe(false);
    expect(playbackReadIsReusable(
      { status: "error", message: "read failed" },
      ISSUED,
    )).toBe(false);
  });

  it("reuses the prefetched soundtrack read, which carries no lifetime", () => {
    // The soundtrack is seeded from the prefetch cache and deliberately never
    // replaced while it plays; its sentinel lifetime says so.
    expect(playbackReadIsReusable({
      status: "ready",
      url: "signed",
      issuedAt: Number.NEGATIVE_INFINITY,
      expiresAt: Number.POSITIVE_INFINITY,
    }, ISSUED)).toBe(true);
  });
});
