import { describe, expect, it } from "vitest";
import { clampPhoto, fitPhoto, panPhoto, pinchPhoto, zoomPhotoAt, PHOTO_FIT, PHOTO_ZOOM_MAX } from "./photoViewport";

const bounds = fitPhoto({ width: 600, height: 400 }, { width: 1800, height: 1200 })!;
describe("photo-local viewport", () => {
  it("fits natural dimensions without inventing geometry for unready images", () => {
    expect(bounds.fitted).toEqual({ width: 600, height: 400 });
    expect(fitPhoto({ width: 0, height: 10 }, { width: 10, height: 10 })).toBeNull();
    expect(fitPhoto({ width: 10, height: 10 }, { width: Infinity, height: 10 })).toBeNull();
    expect(fitPhoto({ width: 10, height: 10 }, { width: 10, height: NaN })).toBeNull();
  });
  it("keeps the content under the pointer invariant until a real bound is reached", () => {
    const start = { scale: 1.5, x: 30, y: -10 };
    const anchor = { x: 100, y: 60 };
    const result = zoomPhotoAt(start, 2.5, anchor, bounds);
    expect((anchor.x - result.x) / result.scale).toBeCloseTo((anchor.x - start.x) / start.scale);
    expect((anchor.y - result.y) / result.scale).toBeCloseTo((anchor.y - start.y) / start.scale);
  });
  it("derives pan from the original snapshot instead of cumulatively adding total movement", () => {
    const start = { scale: 2, x: 0, y: 0 };
    expect(panPhoto(start, { x: 5, y: 0 }, bounds).x).toBe(5);
    expect(panPhoto(start, { x: 10, y: 0 }, bounds).x).toBe(10);
    expect(panPhoto(start, { x: -5, y: 0 }, bounds).x).toBe(-5);
  });
  it("translates a pinch midpoint and scales around its original content point", () => {
    const start = { scale: 2, x: 20, y: 10 };
    const from = { x: 60, y: 30 }, to = { x: 90, y: 50 };
    const next = pinchPhoto(start, from, to, 3, bounds);
    expect((to.x - next.x) / 3).toBeCloseTo((from.x - start.x) / 2);
    expect((to.y - next.y) / 3).toBeCloseTo((from.y - start.y) / 2);
  });
  it("does not allow pan into letterboxing on an axis with no image overflow", () => {
    const portrait = fitPhoto({ width: 600, height: 400 }, { width: 400, height: 800 })!;
    expect(clampPhoto({ scale: 2, x: 100, y: 900 }, portrait)).toEqual({ scale: 2, x: 0, y: 200 });
    expect(clampPhoto({ scale: 4, x: 900, y: -900 }, portrait)).toEqual({ scale: 4, x: 100, y: -600 });
  });
  it("reclamps after a viewport change and resets to a centred fit", () => {
    const resized = fitPhoto({ width: 300, height: 600 }, { width: 1800, height: 1200 })!;
    expect(clampPhoto({ scale: 2, x: 250, y: 200 }, resized)).toEqual({ scale: 2, x: 150, y: 0 });
    expect(zoomPhotoAt({ scale: 3, x: 90, y: 80 }, 1, { x: 120, y: 80 }, bounds)).toEqual(PHOTO_FIT);
  });
  it("bounds scale and rejects nonfinite input", () => {
    expect(clampPhoto({ scale: 100, x: 0, y: 0 }, bounds).scale).toBe(PHOTO_ZOOM_MAX);
    expect(clampPhoto({ scale: -10, x: NaN, y: Infinity }, bounds)).toEqual(PHOTO_FIT);
    expect(clampPhoto({ scale: NaN, x: 0, y: 0 }, bounds)).toEqual(PHOTO_FIT);
  });
});
