import { describe, expect, it, vi } from "vitest";
import {
  createDecodeRegistry,
  decodeImageUrl,
  mediaPrefetchUrlsForRead,
  prefetchWindowFor,
  storyWarmWindow,
} from "./mediaPrefetch";

describe("same-asset preview prefetch (#264)", () => {
  it("warms this asset's preview before the original and refuses a foreign read", () => {
    const read = {
      url: "https://media.example/original",
      preview: {
        url: "https://media.example/preview",
        expiresAt: "2026-09-10T04:00:00.000Z",
        mimeType: "image/jpeg",
        width: 960,
        height: 540,
      },
    };
    expect(mediaPrefetchUrlsForRead("asset-a", "asset-a", read)).toEqual([
      "https://media.example/preview",
      "https://media.example/original",
    ]);
    expect(mediaPrefetchUrlsForRead("asset-a", "asset-b", read)).toEqual([]);
  });
});

describe("storyWarmWindow (#489 ST-159)", () => {
  const base = { length: 12, wrap: false, autoplay: false } as const;

  it("reads 3 ahead and 2 behind the requested intent, nearest-ahead first", () => {
    expect(storyWarmWindow({ ...base, shownIndex: 4, requestedIndex: 4, direction: 1 })).toEqual({
      reads: [4, 5, 3, 6, 2, 7],
      decode: [4, 5, 3],
    });
  });

  it("follows the latest requested media, keeping the shown one warm", () => {
    const window = storyWarmWindow({ ...base, shownIndex: 4, requestedIndex: 6, direction: 1 });
    expect(window.reads).toEqual([6, 7, 5, 8, 4, 9]);
    expect(window.decode).toEqual([6, 7, 5, 4]);
  });

  it("biases toward the last direction and evicts the old lead on reversal", () => {
    const forward = storyWarmWindow({ ...base, shownIndex: 6, requestedIndex: 6, direction: 1 });
    const reversed = storyWarmWindow({ ...base, shownIndex: 6, requestedIndex: 6, direction: -1 });
    expect(reversed.reads).toEqual([6, 5, 7, 4, 8, 3]);
    expect(forward.reads).toContain(9);
    expect(reversed.reads).not.toContain(9);
  });

  it("stays bounded: at most 7 reads and 4 decodes on a long Journey", () => {
    for (let requested = 0; requested < 100; requested += 1) {
      const window = storyWarmWindow({ length: 100, wrap: false, autoplay: false,
        shownIndex: Math.max(0, requested - 5), requestedIndex: requested, direction: 1 });
      expect(window.reads.length).toBeLessThanOrEqual(7);
      expect(window.decode.length).toBeLessThanOrEqual(4);
    }
  });

  it("clamps at a Journey edge and wraps inside a Route Point scope", () => {
    expect(storyWarmWindow({ ...base, shownIndex: 11, requestedIndex: 11, direction: 1 }).reads)
      .toEqual([11, 10, 9]);
    expect(storyWarmWindow({ length: 5, wrap: true, autoplay: false,
      shownIndex: 4, requestedIndex: 4, direction: 1 }).reads).toEqual([4, 0, 3, 1, 2]);
  });

  it("looks forward during autoplay whatever the last manual direction was", () => {
    expect(storyWarmWindow({ ...base, autoplay: true, shownIndex: 2, requestedIndex: 2, direction: -1 }).reads)
      .toEqual([2, 3, 1, 4, 0, 5]);
  });

  it("has nothing to warm without a valid requested media", () => {
    expect(storyWarmWindow({ ...base, shownIndex: 0, requestedIndex: -1, direction: 1 }))
      .toEqual({ reads: [], decode: [] });
  });
});

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
    expect(registry.readiness("bad")?.status).toBe("error");

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

  it("notifies onSettle listeners when a pending decode settles (review P1)", async () => {
    const registry = createDecodeRegistry(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const settled = vi.fn();
    const unsubscribe = registry.onSettle(settled);

    registry.ensure("a", "url-a");
    expect(settled).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(registry.isDecoded("a")).toBe(true);

    // Unsubscribe stops future notifications.
    unsubscribe();
    registry.ensure("b", "url-b");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("notifies listeners on decode errors too (review P1)", async () => {
    const registry = createDecodeRegistry(async () => {
      throw new Error("boom");
    });
    const settled = vi.fn();
    registry.onSettle(settled);
    registry.ensure("bad", "url-bad");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(registry.ensure("bad", "url-bad").status).toBe("error");
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
