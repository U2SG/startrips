import { describe, expect, it, vi } from "vitest";
import {
  createDecodeRegistry,
  decodeImageUrl,
  prefetchWindowFor,
} from "./mediaPrefetch";

describe("prefetchWindowFor (#11)", () => {
  it("returns next 1 + previous 1 for manual browsing", () => {
    expect(prefetchWindowFor(2, 5, false)).toEqual({
      next: [3],
      previous: [1],
    });
  });

  it("returns next 2 for autoplay", () => {
    expect(prefetchWindowFor(2, 6, true)).toEqual({
      next: [3, 4],
      previous: [1],
    });
  });

  it("clamps at both ends of the list", () => {
    expect(prefetchWindowFor(0, 4, false)).toEqual({
      next: [1],
      previous: [],
    });
    expect(prefetchWindowFor(3, 4, true)).toEqual({
      next: [],
      previous: [2],
    });
  });

  it("returns empty windows for a single item", () => {
    expect(prefetchWindowFor(0, 1, false)).toEqual({ next: [], previous: [] });
    expect(prefetchWindowFor(0, 1, true)).toEqual({ next: [], previous: [] });
  });
});

describe("createDecodeRegistry (#11)", () => {
  it("records decode readiness per asset and stays idempotent", async () => {
    const decoded = new Set<string>();
    const registry = createDecodeRegistry(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      decoded.add(url);
    });

    expect(registry.isDecoded("a")).toBe(false);
    registry.ensure("a", "url-a");
    expect(registry.isDecoded("a")).toBe(false); // still pending
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.isDecoded("a")).toBe(true);

    // A second ensure for the same asset does not start a new decode.
    const again = registry.ensure("a", "url-a");
    expect(again.status).toBe("decoded");
    expect(decoded.has("url-a")).toBe(true);
  });

  it("reports errors and recovers after release", async () => {
    const registry = createDecodeRegistry(async () => {
      throw new Error("boom");
    });

    registry.ensure("bad", "url-bad");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.isDecoded("bad")).toBe(false);
    expect(registry.ensure("bad", "url-bad").status).toBe("error");

    registry.release("bad");
    registry.ensure("bad", "url-bad");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.ensure("bad", "url-bad").status).toBe("error");
  });

  it("reset clears every asset", () => {
    const registry = createDecodeRegistry(async () => undefined);
    registry.ensure("a", "url-a");
    registry.ensure("b", "url-b");
    registry.reset();
    expect(registry.isDecoded("a")).toBe(false);
    expect(registry.isDecoded("b")).toBe(false);
  });
});

describe("decodeImageUrl (#11)", () => {
  it("uses the image decode API when available", async () => {
    const decodeMock = vi.fn(async () => undefined);
    const originalImage = globalThis.Image;
    (globalThis as { Image: unknown }).Image = class {
      src = "";
      decode = decodeMock;
    };

    try {
      await decodeImageUrl("url");
      expect(decodeMock).toHaveBeenCalled();
    } finally {
      (globalThis as { Image: unknown }).Image = originalImage;
    }
  });

  it("falls back to load events when decode is missing", async () => {
    const originalImage = globalThis.Image;
    let triggerLoad: (() => void) | undefined;
    (globalThis as { Image: unknown }).Image = class {
      src = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor() {
        triggerLoad = () => this.onload?.();
      }
    };

    try {
      const promise = decodeImageUrl("url");
      triggerLoad?.();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      (globalThis as { Image: unknown }).Image = originalImage;
    }
  });
});
