import { describe, expect, it } from "vitest";
import {
  fitMediaPreview,
  orientedSourceDimensions,
  photoSourceDimensions,
  videoSourceDimensions,
} from "./mediaPreviewProduction";

describe("mediaPreviewProduction (#264)", () => {
  it("keeps a portrait photo orientation and fits within the issued spec", () => {
    const source = photoSourceDimensions({ naturalWidth: 1200, naturalHeight: 1800 });
    expect(source).toEqual({ width: 1200, height: 1800 });
    expect(fitMediaPreview(source, { width: 640, height: 960 })).toEqual({ width: 640, height: 960 });
  });

  it("keeps a landscape video aspect ratio and never exceeds the issued spec", () => {
    const source = videoSourceDimensions({ videoWidth: 1920, videoHeight: 1080 });
    const fitted = fitMediaPreview(source, { width: 960, height: 540 });
    expect(fitted).toEqual({ width: 960, height: 540 });
    expect(fitted.width).toBeLessThanOrEqual(960);
    expect(fitted.height).toBeLessThanOrEqual(540);
    expect(fitted.width / fitted.height).toBeCloseTo(16 / 9, 4);
  });

  it("transposes EXIF quarter-turn orientations without changing other orientations", () => {
    expect(orientedSourceDimensions({ width: 4032, height: 3024 }, 6)).toEqual({ width: 3024, height: 4032 });
    expect(orientedSourceDimensions({ width: 4032, height: 3024 }, 1)).toEqual({ width: 4032, height: 3024 });
  });

  it("fits a mismatched source inside the rectangle without distorting it", () => {
    expect(fitMediaPreview({ width: 1000, height: 500 }, { width: 600, height: 600 })).toEqual({ width: 600, height: 300 });
  });
});
