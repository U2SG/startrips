import { afterEach, describe, expect, it, vi } from "vitest";
import { createJourneyFilmWatchdog } from "./journeyFilmWatchdog";
afterEach(() => vi.useRealTimers());
describe("film progress watchdog", () => {
  it("keeps advancing exports alive beyond five minutes and rejects repeated progress", () => {
    vi.useFakeTimers();
    const watch = createJourneyFilmWatchdog(new AbortController().signal);
    for (let frame = 0; frame < 8; frame++) {
      vi.advanceTimersByTime(100_000); watch.progress("rendering", frame);
      expect(watch.signal.aborted).toBe(false);
    }
    watch.progress("rendering", 7);
    vi.advanceTimersByTime(120_000);
    expect(watch.signal.reason).toMatchObject({ name: "TimeoutError" });
    watch.dispose();
  });
  it("bounds a stalled preparation or finalization and clears on cancellation", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const watch = createJourneyFilmWatchdog(parent.signal);
    watch.progress("finalizing", 0);
    vi.advanceTimersByTime(119_999); expect(watch.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(watch.signal.reason.name).toBe("TimeoutError");
    watch.dispose();
    const next = createJourneyFilmWatchdog(parent.signal);
    parent.abort(); expect(next.signal.reason).toBe(parent.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("dispose clears its timer without aborting a finished artifact", () => {
    vi.useFakeTimers();
    const watch = createJourneyFilmWatchdog(new AbortController().signal);
    watch.dispose(); watch.progress("rendering", 100); vi.advanceTimersByTime(500_000);
    expect(watch.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not mistake alternating unchanged counters for progress", () => {
    vi.useFakeTimers();
    const watch = createJourneyFilmWatchdog(new AbortController().signal);
    watch.progress("rendering", 10); watch.progress("output-write", 1024);
    vi.advanceTimersByTime(100_000);
    watch.progress("rendering", 9); watch.progress("output-write", 1024);
    vi.advanceTimersByTime(20_000);
    expect(watch.signal.reason.name).toBe("TimeoutError"); watch.dispose();
  });
});
