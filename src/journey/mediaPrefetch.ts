import type { PrivateMediaRead } from "./types";
import { mediaPreviewPrefetchUrls } from "./mediaPreviewLayer";

// #11 slideshow media prefetch — pure window math and a browser decode
// registry, kept separate from the React layer so the window logic is unit
// testable without a DOM.
//
// Layering:
//   ensureMediaRead(assetId)      -> signed read URL (existing cache)
//   ensureImageDecoded(assetId, url) -> browser resource ready (this module)
//
// A URL being ready never implies the image is decoded. The decode registry
// records the browser-side readiness separately so the slideshow can hold the
// current frame until the next one is truly ready.

export function mediaPrefetchUrlsForRead(
  assetId: string,
  readAssetId: string,
  read: Pick<PrivateMediaRead, "url" | "preview">,
): string[] {
  return mediaPreviewPrefetchUrls(assetId, readAssetId, read);
}

export type PrefetchWindow = {
  /** Indices to prefetch ahead of the active index. */
  next: number[];
  /** Indices to prefetch behind the active index. */
  previous: number[];
};

/**
 * Which adjacent media indices to prepare for the active index.
 *
 * Manual browsing needs next 1 + previous 1; autoplay is allowed to run ahead
 * by two so a slow network cannot catch it mid-slide.
 */
export function prefetchWindowFor(
  activeIndex: number,
  length: number,
  autoplay: boolean,
): PrefetchWindow {
  if (length < 2) return { next: [], previous: [] };
  const ahead = autoplay ? 2 : 1;
  const next: number[] = [];
  const previous: number[] = [];
  for (let step = 1; step <= ahead; step += 1) {
    const forward = activeIndex + step;
    if (forward < length) next.push(forward);
  }
  const backward = activeIndex - 1;
  if (backward >= 0) previous.push(backward);
  return { next, previous };
}

/**
 * #489 (ST-159): the bounded, tiered warm set for Story browsing. Physical
 * presentation stays three pages; this decides what is prepared behind them.
 *
 *   reads   -- signed read URLs, the widest and cheapest tier: the requested
 *              media plus STORY_WARM_READS_AHEAD (3) steps ahead of it in the
 *              latest navigation direction and STORY_WARM_READS_BEHIND (2)
 *              behind, plus the shown media and its painted stack neighbours,
 *              capped at STORY_WARM_READ_LIMIT (7) assets.
 *   decode  -- a decoded image or a representative video frame, narrower: the
 *              requested and shown media, one step on either side of the
 *              requested one and the painted neighbours, capped at
 *              STORY_WARM_DECODE_LIMIT (4) assets.
 *   live    -- not a tier here. Only the current or pending video owns the one
 *              live transport StoryMediaPages keeps; a warm video is metadata
 *              plus one still frame.
 *
 * The window is anchored on the latest requested intent, not on the settled
 * media, so A -> B -> C starts warming beyond C before B has landed. It is a
 * pure function of its inputs: reversing direction, changing scope or closing
 * the Story releases everything outside the new sets on the next pass.
 * Autoplay always looks forward.
 */
export const STORY_WARM_READS_AHEAD = 3;
export const STORY_WARM_READS_BEHIND = 2;
/** Hard caps for each tier, including the shown media and its painted neighbours. */
export const STORY_WARM_READ_LIMIT = 7;
export const STORY_WARM_DECODE_LIMIT = 4;

export type StoryWarmWindow = {
  /** Indices whose signed read should be ready, highest priority first. */
  reads: number[];
  /** Indices whose picture should be decoded or have a representative frame. */
  decode: number[];
};

/**
 * `pinned` is what the stack paints behind the shown page. It shares the tier
 * budget instead of being appended after it: when rapid browsing moves the
 * requested intent away from the shown page, the farthest steps behind the
 * intent go first, then the farthest ahead, so a tier never exceeds its cap.
 */
export function storyWarmWindow({ shownIndex, requestedIndex, length, direction, wrap, autoplay, pinned = [] }: {
  shownIndex: number;
  requestedIndex: number;
  length: number;
  direction: -1 | 1;
  wrap: boolean;
  autoplay: boolean;
  pinned?: readonly number[];
}): StoryWarmWindow {
  if (length < 1 || requestedIndex < 0 || requestedIndex >= length) return { reads: [], decode: [] };
  const forward = autoplay ? 1 : direction;
  const step = (offset: number) => {
    const raw = requestedIndex + offset * forward;
    if (wrap) return ((raw % length) + length) % length;
    return raw >= 0 && raw < length ? raw : null;
  };
  const valid = (index: number | null): index is number => index !== null && index >= 0 && index < length;
  const shown = valid(shownIndex) ? shownIndex : null;
  const painted = pinned.filter(valid);
  const take = (candidates: Array<number | null>, limit: number) =>
    [...new Set(candidates.filter(valid))].slice(0, limit);
  // Ahead of the intent outranks behind it beyond the first step each way.
  const readOffsets = [1, -1];
  for (let offset = 2; offset <= STORY_WARM_READS_AHEAD; offset += 1) readOffsets.push(offset);
  for (let offset = 2; offset <= STORY_WARM_READS_BEHIND; offset += 1) readOffsets.push(-offset);
  return {
    reads: take([step(0), shown, ...painted, ...readOffsets.map(step)], STORY_WARM_READ_LIMIT),
    decode: take([step(0), shown, step(1), ...painted, step(-1)], STORY_WARM_DECODE_LIMIT),
  };
}

/** Browser-side readiness of one media asset's image element. */
export type DecodedReadiness =
  | { status: "pending" }
  | { status: "decoded" }
  | { status: "error"; message: string };

export type DecodeRegistry = {
  ensure(assetId: string, url: string): DecodedReadiness;
  isDecoded(assetId: string): boolean;
  /** Read the current terminal/pending state without starting a decode. */
  readiness(assetId: string): DecodedReadiness | undefined;
  /** Register a listener called whenever any asset's decode settles (the
   *  pending → decoded/error transition). Used to wake React effects that
   *  gate navigation on decode readiness (review P1). */
  onSettle(listener: () => void): () => void;
  release(assetId: string): void;
  reset(): void;
};

/**
 * Create a decode registry keyed by asset id. `ensure` is idempotent: the
 * first call for an asset starts a background `decode()` and records the
 * outcome; later calls for the same asset return the recorded readiness.
 * `decode()` is required (modern browsers); a missing implementation falls
 * back to `onload`/`onerror` via the Image element.
 *
 * The registry is observable: when a pending decode settles, every `onSettle`
 * listener fires, so UI code can re-check `isDecoded` without polling.
 */
export function createDecodeRegistry(
  decodeImage: (url: string) => Promise<void>,
): DecodeRegistry {
  const state = new Map<string, DecodedReadiness>();
  const listeners = new Set<() => void>();

  function notifySettled() {
    for (const listener of listeners) listener();
  }

  function ensure(assetId: string, url: string): DecodedReadiness {
    const existing = state.get(assetId);
    if (existing && existing.status !== "pending") return existing;
    if (existing?.status === "pending") return existing;

    const readiness: DecodedReadiness = { status: "pending" };
    state.set(assetId, readiness);
    void decodeImage(url).then(
      () => {
        state.set(assetId, { status: "decoded" });
        notifySettled();
      },
      (error: unknown) => {
        state.set(assetId, {
          status: "error",
          message: error instanceof Error ? error.message : "图片解码失败",
        });
        notifySettled();
      },
    );
    return readiness;
  }

  return {
    ensure,
    isDecoded(assetId: string) {
      return state.get(assetId)?.status === "decoded";
    },
    readiness(assetId: string) {
      return state.get(assetId);
    },
    onSettle(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release(assetId: string) {
      state.delete(assetId);
    },
    reset() {
      state.clear();
    },
  };
}

/**
 * Decode an image in the browser, waiting for the decoded frame rather than
 * just the resource. Falls back to load/error events where `decode()` is
 * unsupported.
 */
export function decodeImageUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (typeof image.decode === "function") {
      image.src = url;
      image.decode().then(resolve, reject);
      return;
    }
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}
