import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import {
  PLAYBACK_VIDEO_WATCHDOG_MS,
  playbackVideoBeatBuffering,
  playbackVideoBeatFailed,
  playbackVideoBeatLifecycleMachine,
  playbackVideoBeatTrimStatus,
} from "./playbackVideoBeatLifecycle";

function start(hasTrim = true, beatKey = "beat-a") {
  const actor = createActor(playbackVideoBeatLifecycleMachine, {
    input: { beatKey, assetId: "video-a", stepIndex: 4, hasTrim },
  });
  actor.start();
  return actor;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("playbackVideoBeatLifecycle", () => {
  it("owns trim positioning and degrades a stuck seek before starting the untrimmed fallback path", async () => {
    const actor = start(true);
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("positioning");
    await vi.advanceTimersByTimeAsync(PLAYBACK_VIDEO_WATCHDOG_MS);
    expect(actor.getSnapshot().value).toBe("starting");
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("unavailable");
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(false);
    actor.stop();
  });

  it("moves a positioned trim through stall and playback-time recovery without losing trim ownership", () => {
    const actor = start(true);
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    actor.send({ type: "POSITION_READY", beatKey: "beat-a" });
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("playing");
    actor.send({ type: "STALLED", beatKey: "beat-a" });
    expect(playbackVideoBeatBuffering(actor.getSnapshot())).toBe(true);
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("buffering");
    actor.send({ type: "TIME_PROGRESS", beatKey: "beat-a" });
    expect(actor.getSnapshot().value).toBe("playing");
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("playing");
    actor.stop();
  });

  it("keeps a positioned trim playing across pause and resume instead of repositioning it", () => {
    const actor = start(true);
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    actor.send({ type: "POSITION_READY", beatKey: "beat-a" });
    actor.send({ type: "PAUSE", beatKey: "beat-a" });
    expect(actor.getSnapshot().value).toBe("pausedPlaying");
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("playing");
    actor.send({ type: "RESUME", beatKey: "beat-a" });
    expect(actor.getSnapshot().value).toBe("playing");
    expect(playbackVideoBeatTrimStatus(actor.getSnapshot())).toBe("playing");
    actor.stop();
  });

  it("does not age the first-frame watchdog while paused before the signed read arrives", async () => {
    const actor = start(false);
    actor.send({ type: "PAUSE", beatKey: "beat-a" });
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(false);
    actor.send({ type: "RESUME", beatKey: "beat-a" });
    await vi.advanceTimersByTimeAsync(PLAYBACK_VIDEO_WATCHDOG_MS);
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(true);
    actor.stop();
  });

  it("falls back only after the bounded stall watchdog", async () => {
    const actor = start(false);
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    actor.send({ type: "PLAYING", beatKey: "beat-a" });
    actor.send({ type: "STALLED", beatKey: "beat-a" });
    await vi.advanceTimersByTimeAsync(PLAYBACK_VIDEO_WATCHDOG_MS - 1);
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(true);
    actor.stop();
  });

  it("pauses the watchdog and gives resume a fresh bounded window", async () => {
    const actor = start(false);
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    actor.send({ type: "STALLED", beatKey: "beat-a" });
    await vi.advanceTimersByTimeAsync(2_000);
    actor.send({ type: "PAUSE", beatKey: "beat-a" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(false);
    actor.send({ type: "RESUME", beatKey: "beat-a" });
    await vi.advanceTimersByTimeAsync(PLAYBACK_VIDEO_WATCHDOG_MS);
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(true);
    actor.stop();
  });

  it("ignores stale callbacks from the previous beat even when they reach the current actor", () => {
    const actor = start(true, "beat-b");
    actor.send({ type: "READ_READY", beatKey: "beat-b" });
    actor.send({ type: "POSITION_READY", beatKey: "beat-a" });
    actor.send({ type: "FAILED", beatKey: "beat-a" });
    actor.send({ type: "ENDED", beatKey: "beat-a" });
    expect(actor.getSnapshot().value).toBe("positioning");
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(false);
    actor.stop();
  });

  it("treats an explicit media failure as terminal fallback for this beat only", () => {
    const actor = start(false);
    actor.send({ type: "READ_READY", beatKey: "beat-a" });
    actor.send({ type: "FAILED", beatKey: "beat-a" });
    expect(playbackVideoBeatFailed(actor.getSnapshot())).toBe(true);
    actor.stop();

    const next = start(false, "beat-b");
    next.send({ type: "READ_READY", beatKey: "beat-b" });
    expect(playbackVideoBeatFailed(next.getSnapshot())).toBe(false);
    next.stop();
  });
});
