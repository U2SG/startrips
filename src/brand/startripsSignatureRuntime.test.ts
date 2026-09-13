import { describe, expect, it, vi } from "vitest";
import { createStartripsSignatureRuntime } from "./startripsSignatureRuntime";

function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map<number, (now: number) => void>();
  return {
    scheduler: {
      now: () => now,
      requestFrame: (callback: (value: number) => void) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame: (id: number) => { callbacks.delete(id); },
    },
    pending: () => callbacks.size,
    firstCallback: () => callbacks.values().next().value as ((now: number) => void) | undefined,
    step(ms: number) {
      now += ms;
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(now);
    },
  };
}

describe("Startrips signature runtime lifecycle", () => {
  it("cancels a pending frame on dispose and ignores a stale callback", () => {
    const fake = fakeScheduler();
    const onState = vi.fn();
    const runtime = createStartripsSignatureRuntime({
      clip: "loading", reduced: false, scheduler: fake.scheduler, onPose: vi.fn(), onState,
    });
    runtime.start();
    const stale = fake.firstCallback();
    expect(fake.pending()).toBe(1);
    runtime.dispose();
    expect(fake.pending()).toBe(0);
    stale?.(500);
    expect(fake.pending()).toBe(0);
    expect(onState.mock.calls.at(-1)?.[0].status).toBe("running");
  });

  it("a newer clip request can own the only driver after the previous runtime is disposed", () => {
    const fake = fakeScheduler();
    const first = createStartripsSignatureRuntime({
      clip: "loading", reduced: false, scheduler: fake.scheduler, onPose: vi.fn(), onState: vi.fn(),
    });
    first.start();
    const stale = fake.firstCallback();
    first.dispose();
    const secondState = vi.fn();
    const second = createStartripsSignatureRuntime({
      clip: "full", reduced: false, scheduler: fake.scheduler, onPose: vi.fn(), onState: secondState,
    });
    second.start();
    expect(fake.pending()).toBe(1);
    stale?.(1000);
    expect(fake.pending()).toBe(1);
    fake.step(100);
    expect(fake.pending()).toBe(1);
    expect(secondState.mock.calls.at(-1)?.[0].status).toBe("running");
    second.dispose();
  });

  it("suspends without advancing and restarts from the same elapsed point", () => {
    const fake = fakeScheduler();
    const states: Array<{ status: string; elapsedMs: number }> = [];
    const runtime = createStartripsSignatureRuntime({
      clip: "loading", reduced: false, scheduler: fake.scheduler, onPose: vi.fn(), onState: (state) => states.push(state),
    });
    runtime.start();
    fake.step(500);
    runtime.setSuspended(true);
    const pausedAt = states.at(-1)?.elapsedMs;
    fake.step(1500);
    expect(states.at(-1)?.elapsedMs).toBe(pausedAt);
    runtime.setSuspended(false);
    fake.step(100);
    expect(states.at(-1)?.elapsedMs).toBeGreaterThan(pausedAt ?? 0);
    runtime.dispose();
  });
  it("tracks real wall-clock time instead of losing work between frames", () => {
    const fake = fakeScheduler();
    const states: Array<{ cycle: number; elapsedMs: number }> = [];
    const runtime = createStartripsSignatureRuntime({
      clip: "loading", reduced: false, scheduler: fake.scheduler, onPose: vi.fn(), onState: (state) => states.push(state),
    });
    runtime.start();
    fake.step(1_800);
    fake.step(1_800);
    expect(states.at(-1)?.cycle).toBe(1);
    expect(states.at(-1)?.elapsedMs).toBeCloseTo(0, 3);
    runtime.dispose();
  });

  it("does not schedule or accumulate hidden time when suspended before start", () => {
    const fake = fakeScheduler();
    const states: Array<{ status: string; elapsedMs: number; cycle: number; driverCount: number }> = [];
    const runtime = createStartripsSignatureRuntime({
      clip: "loading", reduced: false, scheduler: fake.scheduler, onPose: vi.fn(), onState: (state) => states.push(state),
    });
    runtime.setSuspended(true);
    runtime.start();
    expect(fake.pending()).toBe(0);
    expect(states.at(-1)).toMatchObject({ status: "suspended", elapsedMs: 0, cycle: 0, driverCount: 0 });
    fake.step(8_000);
    expect(states.at(-1)?.elapsedMs).toBe(0);
    runtime.setSuspended(false);
    expect(fake.pending()).toBe(1);
    fake.step(100);
    expect(states.at(-1)).toMatchObject({ status: "running", cycle: 0, driverCount: 1 });
    expect(states.at(-1)?.elapsedMs).toBeCloseTo(100, 3);
    runtime.dispose();
  });

});
