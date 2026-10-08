import { useEffect, useRef } from "react";
import { journeyAutoRoutePending } from "./autoRouteSnapping";
import type { Journey } from "./types";

export const AUTO_ROUTE_REFRESH_MS = 10_000;

/**
 * While the visible Journey has a segment waiting for automatic road geometry,
 * re-reads it on a modest interval; stops as soon as nothing is pending, and
 * aborts on unmount or when another Journey becomes visible.
 */
export function useAutoRouteRefresh(
  journey: Journey | null,
  readJourney: ((id: string, signal: AbortSignal) => Promise<Journey>) | null | undefined,
  onRefreshed: (journey: Journey) => void,
) {
  const journeyId = journey?.id ?? null;
  const pending = journey ? journeyAutoRoutePending(journey) : false;
  const refreshed = useRef(onRefreshed);
  refreshed.current = onRefreshed;
  useEffect(() => {
    if (!journeyId || !pending || !readJourney) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        void readJourney(journeyId, controller.signal)
          .then((fetched) => { if (!controller.signal.aborted) refreshed.current(fetched); })
          .catch(() => undefined)
          // A refresh that clears the pending state re-runs this effect and stops here.
          .finally(() => { if (!controller.signal.aborted) schedule(); });
      }, AUTO_ROUTE_REFRESH_MS);
    };
    schedule();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [journeyId, pending, readJourney]);
}
