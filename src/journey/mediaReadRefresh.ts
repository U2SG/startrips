import type { MediaPreviewRead } from "./types";

/**
 * When a signed private-media read should be replaced.
 *
 * Every surface that caches a read URL used to compare the expiry against a
 * fixed margin — 60 s in the story dialog, 30 s on the journey card, and the
 * playback overlay simply never re-read an asset once it was ready. That was
 * sound while the only issuer was the owner route, whose URLs live
 * `MEDIA_READ_URL_EXPIRES_IN_SECONDS` (default 900 s) and are therefore always
 * far longer-lived than any margin.
 *
 * #200 phase C changed that dimension: a guest read is capped by
 * `SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS` (default 90 s, floor 15 s) and
 * then capped again by whatever is left of the grant. A fixed margin larger
 * than the whole lifetime declares a URL stale the instant it arrives, which
 * turns a gallery into a refresh loop, and "never re-read" hands playback a
 * URL that expires before the step that needs it.
 *
 * So the decision is expressed against the read's own lifetime instead: never
 * refresh before it is half spent, and never later than `marginMs` before it
 * expires. For an owner read those are the previous numbers unchanged; for a
 * short guest read the half-life rule takes over.
 */
export const MEDIA_READ_REFRESH_MARGIN_MS = 30_000;

/** The instant a read issued at `issuedAt` and expiring at `expiresAt` should be replaced. */
export function mediaReadRefreshAt(
  issuedAt: number,
  expiresAt: number,
  marginMs: number = MEDIA_READ_REFRESH_MARGIN_MS,
): number {
  const lifetimeMs = Math.max(0, expiresAt - issuedAt);
  return Math.max(
    issuedAt + Math.min(marginMs, lifetimeMs / 2),
    expiresAt - marginMs,
  );
}

export function mediaReadIsFresh(
  issuedAt: number,
  expiresAt: number,
  now: number,
  marginMs: number = MEDIA_READ_REFRESH_MARGIN_MS,
): boolean {
  return now < mediaReadRefreshAt(issuedAt, expiresAt, marginMs);
}

/**
 * How long to wait before re-reading, never negative and never zero, so a
 * caller that schedules a timer cannot spin. `fallbackMs` covers an expiry the
 * server sent in a form this browser could not parse.
 */
export function mediaReadRefreshDelayMs(
  issuedAt: number,
  expiresAt: number,
  now: number,
  marginMs: number = MEDIA_READ_REFRESH_MARGIN_MS,
  fallbackMs = 5 * 60_000,
): number {
  if (!Number.isFinite(expiresAt)) return fallbackMs;
  return Math.max(1_000, mediaReadRefreshAt(issuedAt, expiresAt, marginMs) - now);
}

export type MediaReadState =
  | { status: "loading" }
  | { status: "ready"; url: string; preview?: MediaPreviewRead; issuedAt: number; expiresAt: number }
  | { status: "error"; message: string };

/**
 * Whether a cached read may still be reused instead of re-signed.
 *
 * The overlay used to reuse a ready read forever, which was safe while every
 * signed URL lived 900 s: a whole playback ran well inside one lifetime. A
 * share-scoped read is capped at 90 s by default and again by the remaining
 * grant, so a URL prefetched at the head of the window can expire before the
 * chapter that needs it. Reuse is now a lifetime question.
 */
export function playbackReadIsReusable(
  read: MediaReadState | undefined,
  now: number,
): boolean {
  return read?.status === "ready"
    && mediaReadIsFresh(read.issuedAt, read.expiresAt, now);
}

const STORY_MEDIA_READ_REFRESH_MARGIN_MS = 60_000;

/**
 * A cached signed read is replaced once it is past half its own lifetime, and
 * in any case `STORY_MEDIA_READ_REFRESH_MARGIN_MS` before it expires.
 *
 * The margin alone was enough while every read came from the owner route and
 * lived 900 s. A share-scoped read is capped at 90 s by default and further
 * capped by the remaining grant, so a read shorter than the margin would be
 * stale on arrival and this would refresh it on every tick.
 */
export function shouldRefreshStoryMediaRead(
  assetId: string,
  state: { status: string; issuedAt?: number; expiresAt?: number },
  now: number,
  protectedPlaybackAssetId: string | null,
) {
  if (assetId === protectedPlaybackAssetId) return false;
  if (state.status !== "ready") return false;
  if (!Number.isFinite(state.expiresAt)) return false;
  const expiresAt = state.expiresAt as number;
  const issuedAt = Number.isFinite(state.issuedAt)
    ? (state.issuedAt as number)
    : expiresAt - STORY_MEDIA_READ_REFRESH_MARGIN_MS * 2;
  return !mediaReadIsFresh(issuedAt, expiresAt, now, STORY_MEDIA_READ_REFRESH_MARGIN_MS);
}
