import { describe, expect, it } from "vitest";
import { playbackChapterOpeningUrl, playbackHoldReason, playbackMediaGate } from "./playbackMediaPresentation";

describe("playbackMediaGate (PR #24 review)", () => {
  it("keeps pending media held but treats signed-read failures as settled errors", () => {
    expect(playbackMediaGate(undefined, undefined, true)).toBe("waiting");
    expect(playbackMediaGate({ status: "loading" }, undefined, true)).toBe("waiting");
    expect(playbackMediaGate({ status: "error", message: "read failed" }, undefined, true))
      .toBe("error");
  });

  it("treats decode failure as settled and decoded images as ready", () => {
    const ready = {
      status: "ready" as const,
      url: "signed-image",
      issuedAt: 0,
      expiresAt: 900_000,
    };
    expect(playbackMediaGate(ready, { status: "error", message: "decode failed" }, true))
      .toBe("error");
    expect(playbackMediaGate(ready, { status: "decoded" }, true)).toBe("ready");
  });
});

describe("playbackChapterOpeningUrl (#456 review)", () => {
  const ready = {
    status: "ready" as const,
    url: "signed-image",
    issuedAt: 0,
    expiresAt: 900_000,
  };
  const image = { mimeType: "image/jpeg" };

  it("reveals the opening still only after the first image is decoded", () => {
    expect(playbackChapterOpeningUrl("stop", image, ready, { status: "pending" })).toBeNull();
    expect(playbackChapterOpeningUrl("stop", image, ready, { status: "decoded" })).toBe("signed-image");
  });

  it("renders no opening still after decode failure or outside the arrival beat", () => {
    expect(playbackChapterOpeningUrl("stop", image, ready, { status: "error", message: "decode failed" }))
      .toBeNull();
    expect(playbackChapterOpeningUrl("media", image, ready, { status: "decoded" })).toBeNull();
    expect(playbackChapterOpeningUrl("stop", { mimeType: "video/mp4" }, ready, undefined)).toBeNull();
  });
});

describe("playbackHoldReason (#197)", () => {
  const image = {
    id: "asset-image",
    journeyId: "journey",
    routePointId: "point",
    storageDriver: "qa",
    storageKey: "qa/image",
    fileName: "image.png",
    mimeType: "image/png",
    bytes: 68,
    sortOrder: 0,
    uploadedByUserId: "user",
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  const video = { ...image, id: "asset-video", fileName: "clip.mp4", mimeType: "video/mp4" };
  const base = {
    stepKind: "media" as const,
    asset: image,
    gate: "ready" as const,
    videoPlaybackFailed: false,
    trimStatus: null,
  };

  it("reports a decode hold only while an image beat is still waiting", () => {
    expect(playbackHoldReason({ ...base, gate: "waiting" })).toBe("decode");
    expect(playbackHoldReason({ ...base, gate: "ready" })).toBe("none");
    // A settled read/decode failure releases the beat so the media step can
    // render its recoverable error state instead of deadlocking.
    expect(playbackHoldReason({ ...base, gate: "error" })).toBe("none");
  });

  it("reports a stop beat's wait on its first image, and nothing for other phases", () => {
    expect(playbackHoldReason({ ...base, stepKind: "stop", gate: "waiting" })).toBe("decode");
    expect(playbackHoldReason({ ...base, stepKind: "stop", gate: "ready" })).toBe("none");
    // A stop step with no image to wait on, and every non-media phase, are free.
    expect(playbackHoldReason({ ...base, stepKind: "stop", asset: null, gate: "waiting" }))
      .toBe("none");
    expect(playbackHoldReason({ ...base, stepKind: "travel", gate: "waiting" })).toBe("none");
    expect(playbackHoldReason({ ...base, stepKind: "intro", gate: "waiting" })).toBe("none");
    expect(playbackHoldReason({ ...base, stepKind: undefined, asset: null })).toBe("none");
  });

  it("ignores a stale read settling behind the post-seek hold target", () => {
    const currentRead = { status: "loading" as const };
    const staleCompletion = {
      status: "ready" as const,
      url: "stale-signed-image",
      issuedAt: 0,
      expiresAt: 900_000,
    };
    const before = playbackHoldReason({
      ...base,
      gate: playbackMediaGate(currentRead, undefined, true),
    });
    // The old asset may populate its cache entry, but that entry is not an input
    // to the CURRENT step's hold decision after the seek.
    expect(staleCompletion.status).toBe("ready");
    const afterStaleCompletion = playbackHoldReason({
      ...base,
      gate: playbackMediaGate(currentRead, undefined, true),
    });

    expect(before).toBe("decode");
    expect(afterStaleCompletion).toBe(before);
  });

  it("separates a video beat's own runtime and a trim's positioning from a decode hold", () => {
    // An untrimmed video beat is held until `ended`: that is the element owning
    // its runtime, not a lookahead that ran out, so #197's capture must not
    // count it as a decode hold.
    expect(playbackHoldReason({ ...base, asset: video })).toBe("video");
    expect(playbackHoldReason({ ...base, asset: video, videoPlaybackFailed: true })).toBe("none");
    expect(playbackHoldReason({ ...base, asset: video, trimStatus: "positioning" })).toBe("trim");
    expect(playbackHoldReason({ ...base, asset: video, trimStatus: "buffering" })).toBe("trim");
    expect(playbackHoldReason({ ...base, asset: video, trimStatus: "playing" })).toBe("none");
  });
});
