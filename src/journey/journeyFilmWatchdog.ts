/** Healthy long films may run for any elapsed time; only a stalled stage expires. */
export function createJourneyFilmWatchdog(parent: AbortSignal, stallMs = 120_000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const completedByPhase = new Map<string, number>();
  const progress = (nextPhase: string, nextCompleted: number) => {
    if (disposed || controller.signal.aborted || parent.aborted || !Number.isFinite(nextCompleted)) return;
    if (nextCompleted <= (completedByPhase.get(nextPhase) ?? -1)) return;
    completedByPhase.set(nextPhase, nextCompleted);
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("Film export made no progress", "TimeoutError")), stallMs);
  };
  const dispose = () => { disposed = true; clearTimeout(timer); parent.removeEventListener("abort", dispose); };
  parent.addEventListener("abort", dispose, { once: true });
  progress("preparing", 0);
  return { signal: AbortSignal.any([parent, controller.signal]), progress, dispose };
}
