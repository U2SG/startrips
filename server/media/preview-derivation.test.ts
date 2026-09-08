import { describe, expect, it } from "vitest";
import {
  planPreviewDerivation,
  previewObjectFitsCeiling,
  servablePreview,
  PREVIEW_MIME_TYPE,
  type PreviewCeilings,
} from "./preview-derivation";

/**
 * The deployed defaults from `server/config.ts`. Pinned here rather than read
 * from the live config so a deployment that tightens either knob cannot make
 * these assertions vacuous.
 */
const CEILINGS: PreviewCeilings = {
  maxEdgePixels: 640,
  maxBytes: 512 * 1024,
};

/**
 * One pinned source: a 6000x4000 photograph stored a quarter turn from
 * upright, which is what a phone writes for a portrait shot. It is the input
 * every ceiling assertion below is measured on.
 */
const PINNED_PORTRAIT = {
  mimeType: "image/jpeg",
  sourceWidth: 6000,
  sourceHeight: 4000,
  exifOrientation: 6,
};

describe("#260 preview derivation plan", () => {
  it("keeps the pinned source's produced preview inside both ceilings", () => {
    const planned = planPreviewDerivation(PINNED_PORTRAIT, CEILINGS);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(Math.max(planned.spec.width, planned.spec.height))
      .toBeLessThanOrEqual(CEILINGS.maxEdgePixels);
    expect(planned.spec.maxBytes).toBe(CEILINGS.maxBytes);
    // Exact, not merely bounded: the plan is a spec a producer must match.
    expect(planned.spec.width).toBe(427);
    expect(planned.spec.height).toBe(640);
    expect(planned.spec.mimeType).toBe(PREVIEW_MIME_TYPE);
  });

  it("applies EXIF orientation to the display size before scaling", () => {
    const rotated = planPreviewDerivation(PINNED_PORTRAIT, CEILINGS);
    const upright = planPreviewDerivation(
      { ...PINNED_PORTRAIT, exifOrientation: 1 },
      CEILINGS,
    );

    expect(rotated.ok && rotated.spec.displayWidth).toBe(4000);
    expect(rotated.ok && rotated.spec.displayHeight).toBe(6000);
    expect(upright.ok && upright.spec.displayWidth).toBe(6000);
    expect(upright.ok && upright.spec.displayHeight).toBe(4000);
  });

  it("keeps the display aspect ratio of a very wide panorama", () => {
    const planned = planPreviewDerivation(
      { mimeType: "image/jpeg", sourceWidth: 12000, sourceHeight: 900 },
      CEILINGS,
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.spec.width).toBe(640);
    expect(planned.spec.height).toBe(48);
    expect(planned.spec.height).toBeGreaterThanOrEqual(1);
  });

  it("never upscales a source already inside the pixel ceiling", () => {
    const planned = planPreviewDerivation(
      { mimeType: "image/png", sourceWidth: 320, sourceHeight: 200 },
      CEILINGS,
    );

    expect(planned.ok && planned.spec.width).toBe(320);
    expect(planned.ok && planned.spec.height).toBe(200);
  });

  it("plans a video poster from the video's own frame size", () => {
    const planned = planPreviewDerivation(
      { mimeType: "video/mp4", sourceWidth: 1920, sourceHeight: 1080 },
      CEILINGS,
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.spec.width).toBe(640);
    expect(planned.spec.height).toBe(360);
    expect(planned.spec.mimeType).toBe(PREVIEW_MIME_TYPE);
  });

  it("refuses a source no still can be derived from", () => {
    const planned = planPreviewDerivation(
      { mimeType: "audio/mpeg", sourceWidth: 100, sourceHeight: 100 },
      CEILINGS,
    );

    expect(planned).toEqual({ ok: false, reason: "unsupported-source" });
  });

  it.each([
    ["a zero dimension", { sourceWidth: 0, sourceHeight: 100 }],
    ["a fractional dimension", { sourceWidth: 100.5, sourceHeight: 100 }],
    ["a negative dimension", { sourceWidth: 100, sourceHeight: -1 }],
    ["an absurd dimension", { sourceWidth: 100, sourceHeight: 200_000 }],
    ["a non-finite dimension", { sourceWidth: 100, sourceHeight: Number.NaN }],
  ])("refuses %s as undescribable rather than clamping it", (_label, size) => {
    expect(planPreviewDerivation(
      { mimeType: "image/jpeg", ...size },
      CEILINGS,
    )).toEqual({ ok: false, reason: "invalid-source" });
  });

  it.each([0, 9, 1.5])(
    "refuses EXIF orientation %s rather than assuming upright",
    (exifOrientation) => {
      expect(planPreviewDerivation(
        { ...PINNED_PORTRAIT, exifOrientation },
        CEILINGS,
      )).toEqual({ ok: false, reason: "invalid-source" });
    },
  );

  it("treats an absent orientation as upright", () => {
    const planned = planPreviewDerivation(
      { mimeType: "image/jpeg", sourceWidth: 800, sourceHeight: 600 },
      CEILINGS,
    );

    expect(planned.ok && planned.spec.displayWidth).toBe(800);
    expect(planned.ok && planned.spec.displayHeight).toBe(600);
  });

  it("carries no field derived from the original file", () => {
    const planned = planPreviewDerivation(PINNED_PORTRAIT, CEILINGS);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(Object.keys(planned.spec).sort()).toEqual([
      "displayHeight",
      "displayWidth",
      "height",
      "maxBytes",
      "mimeType",
      "width",
    ]);
  });
});

describe("#260 produced preview byte ceiling", () => {
  it("accepts an object at exactly the ceiling and refuses one past it", () => {
    expect(previewObjectFitsCeiling(CEILINGS.maxBytes, CEILINGS)).toBe(true);
    expect(previewObjectFitsCeiling(CEILINGS.maxBytes + 1, CEILINGS))
      .toBe(false);
  });

  it("refuses an empty or unmeasurable object", () => {
    expect(previewObjectFitsCeiling(0, CEILINGS)).toBe(false);
    expect(previewObjectFitsCeiling(-1, CEILINGS)).toBe(false);
    expect(previewObjectFitsCeiling(Number.NaN, CEILINGS)).toBe(false);
  });
});

describe("#260 servable preview", () => {
  const READY = {
    previewStorageKey: "atlas/journey/previews/object",
    previewMimeType: PREVIEW_MIME_TYPE,
    previewState: "ready",
    displayWidth: 4000,
    displayHeight: 6000,
  };

  it("serves the orientation-corrected display size, not the still's own", () => {
    expect(servablePreview(READY)).toEqual({
      storageKey: "atlas/journey/previews/object",
      mimeType: PREVIEW_MIME_TYPE,
      width: 4000,
      height: 6000,
    });
  });

  it.each(["none", "pending", "failed"])(
    "serves nothing in the %s state",
    (previewState) => {
      expect(servablePreview({ ...READY, previewState })).toBeNull();
    },
  );

  it.each([
    ["a missing key", { previewStorageKey: null }],
    ["a missing MIME type", { previewMimeType: null }],
    ["a missing display width", { displayWidth: null }],
    ["a missing display height", { displayHeight: null }],
  ])("refuses to guess around %s on a ready row", (_label, damage) => {
    expect(servablePreview({ ...READY, ...damage })).toBeNull();
  });
});
