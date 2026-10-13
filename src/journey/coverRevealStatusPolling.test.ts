import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVER_REVEAL_POLL_INTERVAL_MS as INTERVAL,
  COVER_REVEAL_POLL_LIMIT as LIMIT,
  startCoverRevealStatusPolling,
} from "./coverRevealStatusPolling";

class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
const disposals: Array<() => void> = [];
function setup(hidden = false, read = vi.fn(async () => {})) {
  const visibility = new Visibility();
  visibility.hidden = hidden;
  const error = vi.fn();
  const stop = startCoverRevealStatusPolling(read, error, visibility);
  disposals.push(stop);
  return { read, error, visibility, stop };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const stop of disposals.splice(0)) stop();
  vi.useRealTimers();
});

describe("creative cover foreground status polling", () => {
  it("keeps the five-second foreground cadence", async () => {
    const { read } = setup();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not spend any of the 60 reads during ten hidden minutes", async () => {
    const { read, visibility } = setup(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).not.toHaveBeenCalled();
    visibility.change(false);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync((LIMIT - 1) * INTERVAL);
    expect(read).toHaveBeenCalledTimes(LIMIT);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("parks an existing timer and resumes a pending job automatically", async () => {
    const { read, visibility } = setup();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    visibility.change(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
    visibility.change(false);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("checks hidden state even if the visibility event has not arrived", async () => {
    const { read, visibility } = setup();
    visibility.hidden = true;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility.change(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("never overlaps a slow read when foreground events repeat", async () => {
    const pending = deferred();
    const read = vi.fn(() => pending.promise);
    const { visibility } = setup(false, read);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    for (let index = 0; index < 5; index++) { visibility.change(true); visibility.change(false); }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not re-arm a read completed while hidden until returning", async () => {
    const pending = deferred();
    const read = vi.fn(() => pending.promise);
    const { visibility } = setup(false, read);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    visibility.change(true);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    visibility.change(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("keeps real failed requests inside the existing budget", async () => {
    const read = vi.fn(async () => { throw new Error("offline"); });
    const { error, visibility } = setup(false, read);
    await vi.advanceTimersByTimeAsync((LIMIT + 1) * INTERVAL);
    expect(read).toHaveBeenCalledTimes(LIMIT);
    expect(error).toHaveBeenCalledTimes(LIMIT);
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(read).toHaveBeenCalledTimes(LIMIT);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not reset a spent foreground budget after hiding", async () => {
    const { read, visibility } = setup();
    await vi.advanceTimersByTimeAsync(LIMIT * INTERVAL);
    visibility.change(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).toHaveBeenCalledTimes(LIMIT);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("removes the timer and listener when the component stops polling", async () => {
    const { read, visibility, stop } = setup();
    const remove = vi.spyOn(visibility, "removeEventListener");
    stop();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["resolve", "reject"] as const)("a late %s cannot resurrect a cleaned-up poller", async (outcome) => {
    const pending = deferred();
    const read = vi.fn(() => pending.promise);
    const { visibility, error, stop } = setup(false, read);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    stop();
    if (outcome === "resolve") pending.resolve();
    else pending.reject(new Error("late failure"));
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
