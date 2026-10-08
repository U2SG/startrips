import { useEffect, useRef } from "react";
import { autoRouteRefreshDelay } from "./autoRouteSnapping";
import type { Journey } from "./types";

/**
 * While the visible Journey has a segment waiting for automatic road geometry,
 * re-reads it: every 10 s while pending, at the retry time of a retryable
 * failure, never for final failures. Aborts on unmount or when another
 * Journey becomes visible.
 */
export function useAutoRouteRefresh(
  journey: Journey | null,
  readJourney: ((id: string, signal: AbortSignal) => Promise<Journey>) | null | undefined,
  onRefreshed: (journey: Journey) => void,
) {
  const journeyId = journey?.id ?? null;
  // Restart only when the reported statuses change, not on every render.
  const statusKey = journey && autoRouteRefreshDelay(journey, 0) !== null
    ? JSON.stringify(journey.autoRouteSegments) : null;
  const latest = useRef(journey);
  latest.current = journey;
  const refreshed = useRef(onRefreshed);
  refreshed.current = onRefreshed;
  useEffect(() => {
    if (!journeyId || statusKey === null || !readJourney) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = latest.current ? autoRouteRefreshDelay(latest.current, Date.now()) : null;
      if (delay === null) return;
      timer = setTimeout(() => {
        void readJourney(journeyId, controller.signal)
          .then((fetched) => { if (!controller.signal.aborted) refreshed.current(fetched); })
          .catch(() => undefined)
          // A refresh that changes the statuses re-runs this effect instead.
          .finally(() => { if (!controller.signal.aborted) schedule(); });
      }, delay);
    };
    schedule();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [journeyId, statusKey, readJourney]);
}
