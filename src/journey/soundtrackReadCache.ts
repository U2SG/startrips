// Review P1: a module-level cache of journey soundtrack signed reads.
//
// The Journey Playback overlay needs the soundtrack URL to be READY when the
// user clicks 播放旅程, so `audio.play()` can run synchronously inside the
// click gesture (browser user-activation policy). We prefetch the soundtrack
// read while the active card is on screen, then seed the overlay from this
// cache — no async wait between the click and the first play().

import { getPrivateMediaRead } from "./journeyApi";
import { journeySoundtrack } from "./journeyModel";
import type { Journey } from "./types";

type CachedRead = { url: string; expiresAt: number };

const cache = new Map<string, CachedRead>();
const pending = new Map<string, Promise<void>>();

const CACHE_TTL_MS = 8 * 60 * 1000;
const SIGNED_READ_FRESHNESS_MARGIN_MS = 30_000;

function isFreshSignedRead(read: CachedRead, now = Date.now()) {
  return read.expiresAt - now > SIGNED_READ_FRESHNESS_MARGIN_MS;
}

/** Prefetch (and cache) the soundtrack signed read for one journey. */
export async function prefetchSoundtrackRead(journey: Journey): Promise<string | null> {
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
    const read = await getPrivateMediaRead(soundtrack.id);
    const parsedExpiresAt = Date.parse(read.expiresAt);
    const cachedRead = {
      url: read.url,
      expiresAt: Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : Date.now() + CACHE_TTL_MS,
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
