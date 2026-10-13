/** Bounded status reads for one pending creative-cover selection. */
export const COVER_REVEAL_POLL_INTERVAL_MS = 5000;
export const COVER_REVEAL_POLL_LIMIT = 60;

type VisibilitySource = EventTarget & { readonly hidden: boolean };

export function startCoverRevealStatusPolling(
  readStatus: () => Promise<void>,
  onError: () => void,
  visibility: VisibilitySource = document,
): () => void {
  let stopped = false;
  let inFlight = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (!stopped && !visibility.hidden && !inFlight && attempts < COVER_REVEAL_POLL_LIMIT) {
      timer = setTimeout(() => { timer = undefined; void poll(); }, COVER_REVEAL_POLL_INTERVAL_MS);
    }
  };
  const poll = async () => {
    if (stopped || visibility.hidden || inFlight || attempts >= COVER_REVEAL_POLL_LIMIT) return;
    // Only an actual status request spends budget; hidden time spends nothing.
    attempts += 1;
    inFlight = true;
    try { await readStatus(); }
    catch { if (!stopped) onError(); }
    finally { inFlight = false; schedule(); }
  };
  const onVisibilityChange = () => {
    // Park without background wake-ups. Returning resumes immediately, but
    // never starts a second read or resets the real-request budget.
    clearTimer();
    if (!visibility.hidden) void poll();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  schedule();
  return () => {
    stopped = true;
    clearTimer();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
