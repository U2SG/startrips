import { describe, expect, it } from "vitest";
import {
  SOUNDTRACK_DUCK_FACTOR,
  SOUNDTRACK_DUCK_ATTACK_MS,
  SOUNDTRACK_DUCK_RELEASE_MS,
} from "./soundtrackDucking";
import {
  createSoundtrackDuckingController,
  SOUNDTRACK_DUCK_IDLE_POLL_MS,
} from "./soundtrackDuckingController";

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

    // Somebody else raises the soundtrack while the video is still audible. The
    // new level is the member's baseline, and because the video has NOT stopped
    // the duck must re-apply to it: 0.5 * 0.3. Parking on 0.5 would leave the
    // rest of that video playing at the level the member had already ducked
    // past, which is the whole thing ducking exists to prevent.
    audio.volume = 0.5;
    run(SOUNDTRACK_DUCK_ATTACK_MS + ARRIVED);
    expect(audio.volume).toBeCloseTo(0.5 * SOUNDTRACK_DUCK_FACTOR, 3);

    // When the video finally stops, it restores to that same new baseline.
    Object.defineProperty(foreground, "paused", { value: true, configurable: true });
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

/**
 * #610: both scheduling paths injected separately, with disjoint handles and
 * cancels that remove only their own handle, so a tick cancelled through the
 * wrong call stays pending and fails the assertion instead of being swept away.
 */
function parkingHarness() {
  let time = 0;
  const frames = new Map<number, () => void>();
  const idles = new Map<number, () => void>();
  let nextFrame = 1;
  let nextIdle = 1001;
  const calls = {
    requestFrame: 0,
    idleDelays: [] as number[],
    cancelFrame: [] as number[],
    cancelIdleTimer: [] as number[],
  };
  const video = fakeVideo();
  const state = {
    video: video as HTMLVideoElement | null,
    generation: 0,
    soundtrack: fakeAudio(1) as HTMLAudioElement,
  };
  const controller = createSoundtrackDuckingController({
    getSoundtrack: () => state.soundtrack,
    getForegroundVideo: () => state.video,
    getMediaGeneration: () => state.generation,
    now: () => time,
    requestFrame: (callback: () => void) => {
      calls.requestFrame += 1;
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle: number) => {
      calls.cancelFrame.push(handle);
      frames.delete(handle);
    },
    setIdleTimer: (callback: () => void, ms: number) => {
      calls.idleDelays.push(ms);
      const handle = nextIdle++;
      idles.set(handle, callback);
      return handle;
    },
    cancelIdleTimer: (handle: number) => {
      calls.cancelIdleTimer.push(handle);
      idles.delete(handle);
    },
  });
  const fire = (queue: Map<number, () => void>) => {
    const pending = [...queue.values()];
    queue.clear();
    for (const callback of pending) callback();
  };
  /** One display frame. */
  const frame = () => {
    time += 8;
    fire(frames);
  };
  /** One idle tick. */
  const idle = () => {
    time += SOUNDTRACK_DUCK_IDLE_POLL_MS;
    fire(idles);
  };
  /** Drive frames until the loop stops asking for them, and require it parked. */
  const untilParked = () => {
    for (let index = 0; index < 1000 && frames.size > 0; index += 1) frame();
    expect(frames.size).toBe(0);
    expect(idles.size).toBe(1);
  };
  /** A few frames in, a transition must sit strictly between its endpoints. */
  const partWay = () => {
    for (let index = 0; index < 10; index += 1) frame();
    return state.soundtrack.volume;
  };
  return { video, state, controller, calls, frames, idles, frame, idle, untilParked, partWay };
}

describe("soundtrack ducking controller parking (#610)", () => {
  it("stops requesting frames once the gain has arrived and keeps polling on the idle tick", () => {
    const { state, controller, calls, idle, untilParked } = parkingHarness();
    controller.start();
    untilParked();
    expect(state.soundtrack.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    const requested = calls.requestFrame;
    const ran = controller.snapshot().frames;
    for (let index = 0; index < 5; index += 1) idle();
    expect(calls.requestFrame).toBe(requested);
    expect(controller.snapshot().frames).toBe(ran + 5);
    expect(calls.idleDelays.length).toBeGreaterThan(5);
    expect(calls.idleDelays.every((ms) => ms === SOUNDTRACK_DUCK_IDLE_POLL_MS)).toBe(true);
    expect(state.soundtrack.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
  });

  it("wakes per frame for a pause, mute or end found by the idle tick, with the same transitions", () => {
    const { video, state, controller, frames, idles, idle, untilParked, partWay } = parkingHarness();
    controller.start();
    untilParked();

    for (const change of [{ paused: true }, { muted: true }, { ended: true }]) {
      Object.assign(video, change);
      idle();
      expect(frames.size).toBe(1);
      expect(idles.size).toBe(0);
      const releasing = partWay();
      expect(releasing).toBeGreaterThan(SOUNDTRACK_DUCK_FACTOR);
      expect(releasing).toBeLessThan(1);
      untilParked();
      expect(state.soundtrack.volume).toBe(1);

      Object.assign(video, { paused: false, muted: false, ended: false });
      idle();
      expect(frames.size).toBe(1);
      expect(idles.size).toBe(0);
      const attacking = partWay();
      expect(attacking).toBeLessThan(1);
      expect(attacking).toBeGreaterThan(SOUNDTRACK_DUCK_FACTOR);
      untilParked();
      expect(state.soundtrack.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
    }
  });

  it("picks up a video that starts while parked with no event to announce it", () => {
    const { state, controller, frames, idle, untilParked } = parkingHarness();
    state.video = null;
    controller.start();
    untilParked();
    expect(state.soundtrack.volume).toBe(1);

    state.video = fakeVideo();
    idle();
    expect(frames.size).toBe(1);
    untilParked();
    expect(state.soundtrack.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
  });

  it("adopts and re-ducks a soundtrack element replaced while parked", () => {
    const { state, controller, frames, idle, untilParked } = parkingHarness();
    controller.start();
    untilParked();

    const replacement = fakeAudio(1) as HTMLAudioElement;
    state.soundtrack = replacement;
    idle();
    expect(frames.size).toBe(1);
    untilParked();
    expect(replacement.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);
  });

  it("wakes for an external level change while parked and ducks the new baseline", () => {
    const { state, controller, frames, idle, untilParked } = parkingHarness();
    controller.start();
    untilParked();

    state.soundtrack.volume = 0.5;
    idle();
    expect(frames.size).toBe(1);
    untilParked();
    expect(state.soundtrack.volume).toBeCloseTo(0.5 * SOUNDTRACK_DUCK_FACTOR, 3);
  });

  it("takes a frame for a generation change and parks again when nothing moves", () => {
    const { state, controller, frames, idles, frame, idle, untilParked } = parkingHarness();
    controller.start();
    untilParked();
    const settled = state.soundtrack.volume;

    state.generation = 1;
    idle();
    expect(frames.size).toBe(1);
    expect(idles.size).toBe(0);
    frame();
    expect(frames.size).toBe(0);
    expect(idles.size).toBe(1);
    expect(state.soundtrack.volume).toBe(settled);
  });

  it("stop() while parked cancels the idle timer, not a frame, and leaves nothing pending", () => {
    const { video, state, controller, calls, frames, idles, idle, untilParked } = parkingHarness();
    controller.start();
    untilParked();
    const [timer] = [...idles.keys()];

    controller.stop();
    expect(calls.cancelIdleTimer).toEqual([timer]);
    expect(calls.cancelFrame).toEqual([]);
    expect(frames.size).toBe(0);
    expect(idles.size).toBe(0);

    const settled = state.soundtrack.volume;
    Object.assign(video, { paused: true });
    idle();
    expect(state.soundtrack.volume).toBe(settled);

    // A restart polls per frame again from scratch.
    controller.start();
    expect(frames.size).toBe(1);
    expect(idles.size).toBe(0);
  });

  it("stop() while ramping cancels the frame, not a timer, and leaves nothing pending", () => {
    const { controller, calls, frames, idles, frame } = parkingHarness();
    controller.start();
    frame();
    frame();
    expect(controller.isRamping()).toBe(true);
    const [pending] = [...frames.keys()];

    controller.stop();
    expect(calls.cancelFrame).toEqual([pending]);
    expect(calls.cancelIdleTimer).toEqual([]);
    expect(frames.size).toBe(0);
    expect(idles.size).toBe(0);
  });

  // The way the first attempt died: an idle path that reached for a timer
  // nothing drives. Outside a browser, with no idle timer injected, the slow
  // tick must still come back through the host's own frame scheduling.
  it("keeps polling through requestFrame outside a browser when no idle timer is injected", () => {
    const audio = fakeAudio(1);
    const video = fakeVideo();
    let time = 0;
    let queue: (() => void)[] = [];
    const drain = () => {
      time += 8;
      const pending = queue;
      queue = [];
      for (const callback of pending) callback();
    };
    const controller = createSoundtrackDuckingController({
      getSoundtrack: () => audio,
      getForegroundVideo: () => video,
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
    for (let index = 0; index < 200; index += 1) {
      drain();
      expect(queue.length).toBe(1);
    }
    expect(audio.volume).toBeCloseTo(SOUNDTRACK_DUCK_FACTOR, 3);

    Object.assign(video, { paused: true });
    for (let index = 0; index < 200; index += 1) drain();
    expect(audio.volume).toBe(1);
    controller.stop();
    expect(queue.length).toBe(0);
  });
});
