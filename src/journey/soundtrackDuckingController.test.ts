import { describe, expect, it } from "vitest";
import {
  SOUNDTRACK_DUCK_FACTOR,
  SOUNDTRACK_DUCK_ATTACK_MS,
  SOUNDTRACK_DUCK_RELEASE_MS,
} from "./soundtrackDucking";
import { createSoundtrackDuckingController } from "./soundtrackDuckingController";

function fakeAudio(volume = 1) {
  const element = { volume };
  return element as typeof element & HTMLAudioElement;
}

function fakeVideo(overrides: Partial<HTMLVideoElement> = {}) {
  return {
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    readyState: 4,
    ...overrides,
  } as unknown as HTMLVideoElement;
}

/** A manual clock, so the ramp is exercised without real animation frames. */
function harness(initial = {
  baseline: 1,
  video: fakeVideo() as HTMLVideoElement | null,
}) {  let time = 0;
  let queue: (() => void)[] = [];
  const state = {
    baseline: initial.baseline,
    video: initial.video,
    generation: 0,
  };
  const audio = fakeAudio();
  const controller = createSoundtrackDuckingController({
    getSoundtrack: () => audio,
    getForegroundVideo: () => state.video,
    getMediaGeneration: () => state.generation,
    getBaselineVolume: () => state.baseline,
    now: () => time,
    requestFrame: (callback: () => void) => {
      queue.push(callback);
      return queue.length;
    },
    cancelFrame: () => {
      queue = [];
    },
  });
  const drain = () => {
    const pending = queue;
    queue = [];
    for (const callback of pending) callback();
  };
  const run = (ms: number) => {
    const steps = Math.max(1, Math.round(ms / 8));
    for (let index = 0; index < steps; index += 1) {
      time += ms / steps;
      drain();
    }
    // Sample once more at the final instant, so a transition that has exactly
    // elapsed is observed as arrived rather than one step short of it.
    drain();
  };
  return { audio, controller, state, run };
}

/**
 * A transition only starts on the frame the controller first observes the
 * change, one frame after the member sees it, so a transition declared to last
 * `ATTACK` arrives just after `ATTACK`. Overshooting by a clear margin is what
 * asserts arrival, rather than a rounding tolerance on the endpoint.
 */
const ARRIVED = 64;

describe("soundtrack ducking controller", () => {
  it("holds the member's own level while an image, note or place is showing", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = null;
    run(SOUNDTRACK_DUCK_RELEASE_MS * 2);
    expect(audio.volume).toBe(1);
  });

  it("ramps down for an audible foreground video and back to the exact level", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo();
    // Part way through the attack it must be between the two levels, not a step.
    run(SOUNDTRACK_DUCK_ATTACK_MS / 2);
    expect(audio.volume).toBeLessThan(1);
    expect(audio.volume).toBeGreaterThan(SOUNDTRACK_DUCK_FACTOR);
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    state.video = null;
    run(SOUNDTRACK_DUCK_RELEASE_MS / 2);
    expect(audio.volume).toBeLessThan(1);
    run(SOUNDTRACK_DUCK_RELEASE_MS + ARRIVED);
    expect(audio.volume).toBe(1);
  });

  it("restores and re-ducks for pause, mute and unmute", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo();
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    for (const change of [{ paused: true }, { muted: true }, { ended: true }]) {
      state.video = fakeVideo(change);
      run(SOUNDTRACK_DUCK_RELEASE_MS + ARRIVED);
      expect(audio.volume).toBe(1);

      state.video = fakeVideo();
      run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
      expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
    }
  });

  // The acceptance item that decides the whole design: ducking is relative to
  // the level actually in force, not the one that happened to be in force when
  // the duck began.
  it("restores to a baseline lowered while ducked", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo();
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    state.baseline = 0.5;
    state.video = null;
    run(SOUNDTRACK_DUCK_RELEASE_MS + ARRIVED);
    expect(audio.volume).toBe(0.5);
  });

  // A rejected play() leaves the element paused, so the soundtrack must never
  // be parked at the ducked level with nothing audible to justify it.
  it("never ducks a video whose playback did not start", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo({ paused: true });
    run(SOUNDTRACK_DUCK_ATTACK_MS * 2);
    expect(audio.volume).toBe(1);
  });

  // "Has a first frame" is not "is playing": an un-paused element that has not
  // delivered data yet must not pull the soundtrack down either.
  it("does not duck before the video has current frame data", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo({ readyState: 1 });
    run(SOUNDTRACK_DUCK_ATTACK_MS * 2);
    expect(audio.volume).toBe(1);
  });

  it("does not duck for a video at zero volume", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo({ volume: 0 });
    run(SOUNDTRACK_DUCK_ATTACK_MS * 2);
    expect(audio.volume).toBe(1);
  });

  // Rapid video A -> image -> video B. The controller polls live state, so A's
  // superseded target cannot be applied after B has taken over.
  it("does not carry a stale transport's target across a video swap", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    const videoA = fakeVideo();
    state.video = videoA;
    run(SOUNDTRACK_DUCK_ATTACK_MS / 2);
    const midway = audio.volume;

    state.video = null;
    state.generation = 1;
    state.video = fakeVideo();
    state.generation = 2;
    run(8);
    // Straight from one ducking video to another, the gain must not jump to the
    // restored level and then back down.
    expect(audio.volume).toBeLessThan(1);
    expect(Math.abs(audio.volume - midway)).toBeLessThan(0.2);
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
  });

  // The wiring bug this pins: a surface that copies `videoRef.current` during
  // render sees null the first time a video appears, because React attaches the
  // ref in the commit phase. Resolving the element lazily is what makes the
  // first video duck at all, with no second render required to notice it.
  it("ducks a video whose element only appears after the frame that requested it", () => {
    let element: HTMLVideoElement | null = null;
    const audio = fakeAudio(1);
    let time = 0;
    let queue: (() => void)[] = [];
    const drain = () => {
      const pending = queue;
      queue = [];
      for (const callback of pending) callback();
    };
    const run = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / 8));
      for (let index = 0; index < steps; index += 1) {
        time += ms / steps;
        drain();
      }
      drain();
    };
    const controller = createSoundtrackDuckingController({
      getSoundtrack: () => audio,
      getForegroundVideo: () => element,
      now: () => time,
      requestFrame: (callback: () => void) => {
        queue.push(callback);
        return queue.length;
      },
      cancelFrame: () => {
        queue = [];
      },
    });
    controller.start();
    // Nothing is mounted yet.
    run(64);
    expect(audio.volume).toBe(1);
    // The element arrives, exactly as a commit-phase ref attach would.
    element = fakeVideo();
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
  });

  // The member's level is whatever this controller did not write. A surface
  // that changes it while ducked - a future volume control - must get that new
  // level back, not the one the duck started from.
  it("treats an externally changed element level as the new baseline", () => {
    const audio = fakeAudio(1);
    const foreground = fakeVideo();
    let time = 0;
    let queue: (() => void)[] = [];
    const drain = () => {
      const pending = queue;
      queue = [];
      for (const callback of pending) callback();
    };
    const run = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / 8));
      for (let index = 0; index < steps; index += 1) {
        time += ms / steps;
        drain();
      }
      drain();
    };
    const controller = createSoundtrackDuckingController({
      getSoundtrack: () => audio,
      getForegroundVideo: () => foreground,
      now: () => time,
      requestFrame: (callback: () => void) => {
        queue.push(callback);
        return queue.length;
      },
      cancelFrame: () => {
        queue = [];
      },
    });
    controller.start();
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    // Somebody else lowers the soundtrack while it is ducked.
    audio.volume = 0.5;
    run(SOUNDTRACK_DUCK_RELEASE_MS + ARRIVED);
    expect(audio.volume).toBe(0.5);
  });

  it("stops touching the element once stopped", () => {
    const { audio, controller, state, run } = harness();
    controller.start();
    state.video = fakeVideo();
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    const settled = audio.volume;
    controller.stop();
    state.video = null;
    run(SOUNDTRACK_DUCK_RELEASE_MS * 2);
    expect(audio.volume).toBe(settled);
    expect(controller.isRamping()).toBe(false);
  });

  // The reported P2. Story renders the soundtrack with `key={soundtrack.id}`, so
  // a replacement soundtrack is a NEW element sitting at the browser default
  // while the duck is already settled. The cached gain describes the element
  // that went away; without adopting the new one the controller would skip the
  // write and let the replacement play at full level under a still-audible
  // video.
  it("re-ducks a replacement soundtrack element instead of trusting its cached gain", () => {
    const first = fakeAudio(1);
    const second = fakeAudio(1);
    const state = {
      video: fakeVideo() as HTMLVideoElement | null,
      soundtrack: first as HTMLAudioElement,
    };
    let time = 0;
    let queue: (() => void)[] = [];
    const drain = () => {
      const pending = queue;
      queue = [];
      for (const callback of pending) callback();
    };
    const run = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / 8));
      for (let index = 0; index < steps; index += 1) {
        time += ms / steps;
        drain();
      }
      drain();
    };
    const controller = createSoundtrackDuckingController({
      getSoundtrack: () => state.soundtrack,
      getForegroundVideo: () => state.video,
      getBaselineVolume: () => 1,
      now: () => time,
      requestFrame: (callback: () => void) => {
        queue.push(callback);
        return queue.length;
      },
      cancelFrame: () => {
        queue = [];
      },
    });
    controller.start();
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(first.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    // The surface swaps in a different soundtrack; the video never stopped.
    state.soundtrack = second as HTMLAudioElement;
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);

    expect(second.volume).toBeLessThan(1);
    expect(second.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
  });
});
