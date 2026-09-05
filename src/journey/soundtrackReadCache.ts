// Review P1: a module-level cache of journey soundtrack signed reads.
//
// The Journey Playback overlay needs the soundtrack URL to be READY when the
// user clicks 播放旅程, so `audio.play()` can run synchronously inside the
// click gesture (browser user-activation policy). We prefetch the soundtrack
// read while the active card is on screen, then seed the overlay from this
// cache — no async wait between the click and the first play().

import type { AtlasMediaRead } from "./atlasView";
import { mediaReadIsFresh } from "./mediaReadRefresh";
import { journeySoundtrack } from "./journeyModel";
import type { Journey } from "./types";

type CachedRead = { url: string; issuedAt: number; expiresAt: number };

const cache = new Map<string, CachedRead>();
const pending = new Map<string, Promise<void>>();

const CACHE_TTL_MS = 8 * 60 * 1000;
const SIGNED_READ_FRESHNESS_MARGIN_MS = 30_000;

/**
 * Freshness is measured against the read's own lifetime, not a fixed margin:
 * a share-scoped read can be capped below 30 s by the remaining grant, and a
 * fixed margin would then discard every copy on arrival, leaving the overlay
 * with no cached soundtrack to start inside the click gesture.
 */
function isFreshSignedRead(read: CachedRead, now = Date.now()) {
  return mediaReadIsFresh(
    read.issuedAt,
    read.expiresAt,
    now,
    SIGNED_READ_FRESHNESS_MARGIN_MS,
  );
}

/**
 * Prefetch (and cache) the soundtrack signed read for one journey.
 *
 * The reader is passed in rather than imported: in shared mode the only route
 * that may sign this asset is the guest one, and a module-level owner import
 * would be a second, unauthorized way to reach the same media.
 */
export async function prefetchSoundtrackRead(
  journey: Journey,
  readMedia: AtlasMediaRead,
): Promise<string | null> {
  const soundtrack = journeySoundtrack(journey);
  if (!soundtrack) return null;
  const existing = cache.get(soundtrack.id);
  if (existing && isFreshSignedRead(existing)) return existing.url;

  const inFlight = pending.get(soundtrack.id);
  if (inFlight) {
    await inFlight;
    return cache.get(soundtrack.id)?.url ?? null;
  }
  const task = (async () => {
    const issuedAt = Date.now();
    const read = await readMedia(soundtrack.id);
    const parsedExpiresAt = Date.parse(read.expiresAt);
    const cachedRead = {
      url: read.url,
      issuedAt,
      expiresAt: Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : issuedAt + CACHE_TTL_MS,
    };
    if (isFreshSignedRead(cachedRead)) cache.set(soundtrack.id, cachedRead);
    else cache.delete(soundtrack.id);
  })();
  pending.set(soundtrack.id, task);
  try {
    await task;
  } finally {
    pending.delete(soundtrack.id);
  }
  return cache.get(soundtrack.id)?.url ?? null;
}

/**
 * The currently cached soundtrack read URL for one journey, or null when it
 * has not been prefetched (or has expired). Synchronous — safe to call from a
 * click handler before opening the overlay.
 */
export function cachedSoundtrackRead(journey: Journey): { url: string } | null {
  const soundtrack = journeySoundtrack(journey);
  if (!soundtrack) return null;
  const existing = cache.get(soundtrack.id);
  if (!existing || !isFreshSignedRead(existing)) return null;
  return { url: existing.url };
}
