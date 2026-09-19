import { describe, expect, it } from "vitest";
import {
  coverRevealReducer,
  initialCoverRevealState,
  planCoverReveal,
  runCoverReveal,
  type CoverRevealEvent,
  type CoverRevealRequest,
} from "./coverRevealFlow";

const PAIR = {
  generatedFirst: "generated-first.png",
  originalCover: "original-cover.png",
};

function request(overrides: Partial<CoverRevealRequest> = {}): CoverRevealRequest {
  return {
    revision: 1,
    pair: PAIR,
    preset: "ink-bloom",
    reducedMotion: false,
    backend: "webgl2",
    ...overrides,
  };
}

const reveal = (overrides: Partial<CoverRevealRequest> = {}): CoverRevealEvent => ({
  type: "request",
  request: request(overrides),
});

describe("coverRevealFlow lifecycle", () => {
  it("walks idle -> preparing -> revealing -> settled and ends on the original cover", () => {
    const events: CoverRevealEvent[] = [
      reveal(),
      { type: "images-loaded", revision: 1 },
      { type: "frame", revision: 1, progress: 0.4 },
      { type: "complete", revision: 1 },
    ];
    const phases = [
      initialCoverRevealState.phase,
      ...events.map((_event, index) => runCoverReveal(events.slice(0, index + 1)).phase),
    ];
    expect(phases).toEqual(["idle", "preparing", "revealing", "revealing", "settled"]);

    const final = runCoverReveal(events);
    expect(final.displayedImage).toBe(PAIR.originalCover);
    expect(final.settleReason).toBe("completed");
    expect(final.degraded).toBe(false);
  });

  it("shows the generated first image only while revealing, never as the terminal state", () => {
    const revealing = runCoverReveal([reveal(), { type: "images-loaded", revision: 1 }]);
    expect(revealing.displayedImage).toBe(PAIR.generatedFirst);

    for (const terminal of ["complete", "interrupt"] as const) {
      const settled = runCoverReveal([
        reveal(),
        { type: "images-loaded", revision: 1 },
        { type: "frame", revision: 1, progress: 0.7 },
        { type: terminal, revision: 1 },
      ]);
      expect(settled.phase).toBe("settled");
      expect(settled.displayedImage).toBe(PAIR.originalCover);
      expect(settled.displayedImage).not.toBe(PAIR.generatedFirst);
    }
  });

  it("ends a user interruption immediately at the original cover", () => {
    const interrupted = runCoverReveal([
      reveal(),
      { type: "images-loaded", revision: 1 },
      { type: "frame", revision: 1, progress: 0.25 },
      { type: "interrupt", revision: 1 },
    ]);
    expect(interrupted.phase).toBe("settled");
    expect(interrupted.settleReason).toBe("interrupted");
    expect(interrupted.progress).toBe(1);
    expect(interrupted.displayedImage).toBe(PAIR.originalCover);

    // Frames that arrive after the interruption cannot revive the reveal.
    const after = coverRevealReducer(interrupted, { type: "frame", revision: 1, progress: 0.3 });
    expect(after).toBe(interrupted);
  });

  it("settles a failed image load on the original cover and reports it honestly", () => {
    const failed = runCoverReveal([
      reveal(),
      { type: "failed", revision: 1, reason: "network" },
    ]);
    expect(failed.phase).toBe("settled");
    expect(failed.displayedImage).toBe(PAIR.originalCover);
    expect(failed.degraded).toBe(true);
    expect(failed.error).toBe("network");
    expect(failed.frameCount).toBe(0);
  });
});

describe("coverRevealFlow reduced motion", () => {
  it("resolves a reduced-motion request directly to the settled original cover", () => {
    const state = runCoverReveal([reveal({ reducedMotion: true })]);
    expect(state.phase).toBe("settled");
    expect(state.settleReason).toBe("reduced-motion");
    expect(state.displayedImage).toBe(PAIR.originalCover);
    expect(state.progress).toBe(1);
    // Reduced motion is a pacing choice, not a broken device.
    expect(state.degraded).toBe(false);
  });

  it("renders no intermediate reveal frames under reduced motion", () => {
    const state = runCoverReveal([
      reveal({ reducedMotion: true }),
      { type: "images-loaded", revision: 1 },
      { type: "frame", revision: 1, progress: 0.2 },
      { type: "frame", revision: 1, progress: 0.6 },
    ]);
    expect(state.frameCount).toBe(0);
    expect(state.phase).toBe("settled");
    expect(state.displayedImage).toBe(PAIR.originalCover);
  });

  it("plans a reduced-motion request as immediate", () => {
    const plan = planCoverReveal(request({ reducedMotion: true }));
    expect(plan).toEqual({
      mode: "immediate",
      degraded: false,
      reason: "reduced-motion",
      finalImage: PAIR.originalCover,
    });
  });
});

describe("coverRevealFlow stale intent", () => {
  it("refuses to commit a loaded pair from a superseded revision", () => {
    const stalePair = { generatedFirst: "stale-first.png", originalCover: "stale-cover.png" };
    const current = runCoverReveal([
      reveal({ revision: 1, pair: stalePair }),
      reveal({ revision: 2 }),
    ]);
    expect(current.revision).toBe(2);
    expect(current.pair).toEqual(PAIR);

    const stale = coverRevealReducer(current, { type: "images-loaded", revision: 1 });
    expect(stale).toBe(current);
    expect(stale.displayedImage).toBeNull();
    expect(stale.pair).toEqual(PAIR);
  });

  it("cannot move the lifecycle out of the state the newer intent owns", () => {
    const owned = runCoverReveal([
      reveal({ revision: 2 }),
      { type: "images-loaded", revision: 2 },
    ]);
    expect(owned.phase).toBe("revealing");

    const staleEvents: CoverRevealEvent[] = [
      { type: "frame", revision: 1, progress: 0.9 },
      { type: "complete", revision: 1 },
      { type: "interrupt", revision: 1 },
      { type: "failed", revision: 1, reason: "stale" },
      { type: "renderer-failed", revision: 1, reason: "stale" },
      { type: "request", request: request({ revision: 1 }) },
    ];
    for (const event of staleEvents) {
      expect(coverRevealReducer(owned, event)).toBe(owned);
    }
  });

  it("keeps a re-issued current revision from restarting a settled reveal", () => {
    const settled = runCoverReveal([
      reveal({ revision: 3 }),
      { type: "images-loaded", revision: 3 },
      { type: "complete", revision: 3 },
    ]);
    expect(coverRevealReducer(settled, reveal({ revision: 3 }))).toBe(settled);
  });
});

describe("coverRevealFlow without WebGL2", () => {
  it("reports the degraded fallback decision instead of fabricating a reveal", () => {
    const plan = planCoverReveal(request({ backend: "unavailable" }));
    expect(plan).toEqual({
      mode: "immediate",
      degraded: true,
      reason: "no-webgl2",
      finalImage: PAIR.originalCover,
    });
  });

  it("settles on the canonical original cover with no reveal frames", () => {
    const state = runCoverReveal([
      reveal({ backend: "unavailable" }),
      { type: "images-loaded", revision: 1 },
      { type: "frame", revision: 1, progress: 0.5 },
    ]);
    expect(state.phase).toBe("settled");
    expect(state.settleReason).toBe("no-webgl2");
    expect(state.degraded).toBe(true);
    expect(state.frameCount).toBe(0);
    expect(state.displayedImage).toBe(PAIR.originalCover);
    expect(state.displayedImage).not.toBe(PAIR.generatedFirst);
  });
});

describe("coverRevealFlow when the renderer itself fails", () => {
  it("settles on the original cover when the renderer cannot be constructed", () => {
    // The WebGL2 probe succeeded, so the lifecycle is already preparing when the
    // real renderer refuses to be built. It must not sit there with no image.
    const preparing = runCoverReveal([reveal()]);
    expect(preparing.phase).toBe("preparing");
    expect(preparing.displayedImage).toBeNull();

    const settled = coverRevealReducer(preparing, {
      type: "renderer-failed",
      revision: 1,
      reason: "Unknown flow: not-a-supported-preset",
    });
    expect(settled.phase).toBe("settled");
    expect(settled.settleReason).toBe("renderer-failed");
    expect(settled.degraded).toBe(true);
    expect(settled.frameCount).toBe(0);
    expect(settled.displayedImage).toBe(PAIR.originalCover);
    expect(settled.error).toBe("Unknown flow: not-a-supported-preset");
  });

  it("settles on the original cover when the graphics context is lost mid-reveal", () => {
    const settled = runCoverReveal([
      reveal(),
      { type: "images-loaded", revision: 1 },
      { type: "frame", revision: 1, progress: 0.35 },
      { type: "renderer-failed", revision: 1, reason: "context lost" },
    ]);
    expect(settled.phase).toBe("settled");
    expect(settled.settleReason).toBe("renderer-failed");
    expect(settled.degraded).toBe(true);
    expect(settled.progress).toBe(1);
    // Not the half-dissolved generated image the loss froze on screen.
    expect(settled.displayedImage).toBe(PAIR.originalCover);
  });

  it("does not retroactively degrade a reveal that already completed", () => {
    const completed = runCoverReveal([
      reveal(),
      { type: "images-loaded", revision: 1 },
      { type: "frame", revision: 1, progress: 0.9 },
      { type: "complete", revision: 1 },
    ]);
    const afterLoss = coverRevealReducer(completed, {
      type: "renderer-failed",
      revision: 1,
      reason: "context lost after the reveal finished",
    });
    expect(afterLoss).toBe(completed);
    expect(afterLoss.settleReason).toBe("completed");
    expect(afterLoss.degraded).toBe(false);
  });
});

describe("coverRevealFlow invariants", () => {
  it("never leaves a settled lifecycle on anything but the original cover", () => {
    const terminals: CoverRevealEvent[] = [
      { type: "complete", revision: 1 },
      { type: "interrupt", revision: 1 },
      { type: "failed", revision: 1, reason: "any" },
      { type: "renderer-failed", revision: 1, reason: "any" },
    ];
    const starts: CoverRevealEvent[][] = [
      [reveal()],
      [reveal(), { type: "images-loaded", revision: 1 }],
      [reveal(), { type: "images-loaded", revision: 1 }, { type: "frame", revision: 1, progress: 0.5 }],
      [reveal({ reducedMotion: true })],
      [reveal({ backend: "unavailable" })],
    ];
    for (const start of starts) {
      for (const terminal of terminals) {
        const state = runCoverReveal([...start, terminal]);
        expect(state.phase).toBe("settled");
        expect(state.displayedImage).toBe(PAIR.originalCover);
      }
    }
  });

  it("releases back to idle without leaving a displayed image behind", () => {
    const released = runCoverReveal([
      reveal(),
      { type: "images-loaded", revision: 1 },
      { type: "release" },
    ]);
    expect(released.phase).toBe("idle");
    expect(released.displayedImage).toBeNull();
    expect(released.pair).toBeNull();
    expect(released.revision).toBe(1);
  });
});
