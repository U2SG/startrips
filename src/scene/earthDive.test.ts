import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canBlendDetail,
  earthDiveBlendMs,
  resolveEarthDive,
  EARTH_DIVE_BLEND_ENTER_PROGRESS,
  EARTH_DIVE_BLEND_MS,
  EARTH_DIVE_BLEND_READINESS,
  EARTH_DIVE_DETAIL_ENTER_PROGRESS,
  EARTH_DIVE_REDUCED_MOTION_BLEND_MS,
  INITIAL_EARTH_DIVE_STATE,
  type DetailReadiness,
  type EarthDiveInput,
  type EarthDiveStage,
  type EarthDiveState,
} from "./earthDive";
import {
  GLOBE_SEMANTIC_ZOOM_CEILING,
  localBandProgress,
  resolveGlobeSemanticZoom,
  type GlobeSemanticZoom,
  type SemanticZoomSnapshot,
} from "./semanticZoom";

type Frame = {
  level?: GlobeSemanticZoom;
  localProgress?: number;
  readiness?: DetailReadiness;
  handoffRevision?: number;
  focusRevision?: number;
  commandRequested?: boolean;
  releaseRequested?: boolean;
  blendPresented?: boolean;
  suspended?: boolean;
  reduceMotion?: boolean;
};

function snapshot(level: GlobeSemanticZoom, localProgress: number): SemanticZoomSnapshot {
  // The zoom field is the authority's own. The resolver never reads it, which
  // is why a synthetic value here cannot hide a boundary assumption.
  return { level, zoom: Number.NaN, localProgress };
}

function input(frame: Frame = {}): EarthDiveInput {
  return {
    snapshot: snapshot(frame.level ?? "planet", frame.localProgress ?? 0),
    readiness: frame.readiness ?? "unavailable",
    handoffRevision: frame.handoffRevision ?? 1,
    focusRevision: frame.focusRevision ?? 1,
    commandRequested: frame.commandRequested,
    releaseRequested: frame.releaseRequested,
    blendPresented: frame.blendPresented,
    suspended: frame.suspended,
    reduceMotion: frame.reduceMotion,
  };
}

function state(stage: EarthDiveStage): EarthDiveState {
  return {
    ...INITIAL_EARTH_DIVE_STATE,
    stage,
    owner: stage === "detail" ? "detail" : "particle",
  };
}

/** Run a frame sequence and return every state the section would publish. */
function run(frames: Frame[], from: EarthDiveStage = "particle") {
  const published: EarthDiveState[] = [];
  let current = state(from);
  for (const frame of frames) {
    current = resolveEarthDive(current, input(frame));
    published.push(current);
  }
  return published;
}

const stagesOf = (published: EarthDiveState[]) => published.map((entry) => entry.stage);

/** Hold one input steady until the state stops moving, so ordering is visible. */
function settle(from: EarthDiveStage, frame: Frame, maxFrames = 12) {
  const published: EarthDiveState[] = [];
  let current = state(from);
  for (let index = 0; index < maxFrames; index += 1) {
    const next = resolveEarthDive(current, input(frame));
    if (next.stage === current.stage && next.owner === current.owner) break;
    current = next;
    published.push(current);
  }
  return published;
}

describe("earth dive resolver", () => {
  it("declares no zoom boundary, clamp or range of its own", () => {
    const source = readFileSync(new URL("./earthDive.ts", import.meta.url), "utf-8");
    // #252 section 1: `semanticZoom.ts` stays the single zoom authority. The
    // resolver consumes the continuous progress that authority derives, but no
    // zoom value may be restated here - neither a particle band boundary nor
    // one of the technical report's QA seed values. The guard is anchored so a
    // normalized cut such as `0.8` is not mistaken for the MapLibre zoom `8`.
    expect(source.match(
      /(?<![\d.])(?:0\.72|1\.3|2\.1|2\.36|2\.5|2\.55|2\.74|2\.92|3\.0|5\.6|5\.85|6\.45)(?!\d)/g,
    )).toBeNull();
    // No clock, so no timeout can exist here at all.
    expect(source).not.toMatch(/setTimeout|setInterval|Date\.now|performance\.now/);
    // The canonical zoom is carried through untouched: the resolver reads the
    // band and the normalized progress, never the number itself.
    expect(source).not.toMatch(/snapshot\.zoom/);

    // The signature is the authority's published snapshot, taken as it comes.
    const authority = resolveGlobeSemanticZoom({ zoom: GLOBE_SEMANTIC_ZOOM_CEILING });
    expect(authority.snapshot.localProgress).toBe(localBandProgress(GLOBE_SEMANTIC_ZOOM_CEILING));
    expect(resolveEarthDive(state("blending"), {
      snapshot: authority.snapshot,
      readiness: "visual-ready",
      handoffRevision: 1,
      focusRevision: 1,
    }).stage).toBe("detail");
  });

  it("progresses particle -> prewarm -> blending -> detail in order, skipping no stage", () => {
    // One frame that is already deep and ready: the stage still walks the whole
    // ladder rather than jumping straight to detail.
    expect(stagesOf(settle("particle", {
      level: "local",
      localProgress: 1,
      readiness: "visual-ready",
    }))).toEqual(["prewarm", "blending", "detail"]);
  });

  it("enters prewarm at regional, before the detail renderer is ready", () => {
    expect(stagesOf(run([{ level: "regional" }]))).toEqual(["prewarm"]);
    expect(stagesOf(run([{ level: "regional", readiness: "mounted" }]))).toEqual(["prewarm"]);
  });

  it("puts the blending and detail edges at distinct progress points inside local", () => {
    expect(EARTH_DIVE_BLEND_ENTER_PROGRESS).toBeLessThan(EARTH_DIVE_DETAIL_ENTER_PROGRESS);
    expect(resolveEarthDive(state("prewarm"), input({
      level: "local",
      localProgress: EARTH_DIVE_BLEND_ENTER_PROGRESS - 0.01,
      readiness: "visual-ready",
    })).stage).toBe("prewarm");
    expect(resolveEarthDive(state("blending"), input({
      level: "local",
      localProgress: EARTH_DIVE_DETAIL_ENTER_PROGRESS - 0.01,
      readiness: "visual-ready",
    })).stage).toBe("blending");
  });

  it("blends at visual-ready rather than waiting for a fully settled map", () => {
    expect(EARTH_DIVE_BLEND_READINESS).toBe("visual-ready");
    expect(canBlendDetail("unavailable")).toBe(false);
    expect(canBlendDetail("mounted")).toBe(false);
    expect(canBlendDetail("visual-ready")).toBe(true);
    expect(canBlendDetail("fully-settled")).toBe(true);
    for (const readiness of ["unavailable", "mounted"] as const) {
      expect(resolveEarthDive(state("prewarm"), input({
        level: "local",
        localProgress: 1,
        readiness,
      })).stage).toBe("prewarm");
    }
    for (const readiness of ["visual-ready", "fully-settled"] as const) {
      expect(resolveEarthDive(state("prewarm"), input({
        level: "local",
        localProgress: 1,
        readiness,
      })).stage).toBe("blending");
    }
  });

  it("lets readiness and not time gate the blend, for an arbitrarily large elapsed time", () => {
    // 20 000 frames is minutes of wall clock at any frame rate, and far past
    // every timeout the superseded implementation carried. The resolver takes
    // no clock at all, so the stage cannot move on its own.
    const frames: Frame[] = Array.from({ length: 20_000 }, (_unused, index) => ({
      level: index === 0 ? "regional" : "local",
      localProgress: index === 0 ? 0 : 1,
      readiness: "mounted",
    }));
    const published = run(frames);
    expect(new Set(stagesOf(published))).toEqual(new Set(["prewarm"]));
    expect(new Set(published.map((entry) => entry.owner))).toEqual(new Set(["particle"]));
    // The same sequence with readiness reached does blend, so the hold above is
    // the gate and not a stuck resolver.
    expect(stagesOf(run([...frames.slice(0, 2), {
      level: "local",
      localProgress: 1,
      readiness: "visual-ready",
    }]))).toEqual(["prewarm", "prewarm", "blending"]);
  });

  it("releases asymmetrically: returning to particle needs the band to fall to macro", () => {
    expect(stagesOf(run([{ level: "regional" }], "prewarm"))).toEqual(["prewarm"]);
    expect(stagesOf(run([{ level: "macro" }], "prewarm"))).toEqual(["particle"]);
    expect(stagesOf(run([{ level: "planet" }], "prewarm"))).toEqual(["particle"]);
  });

  it("yields no repeated stage flip for an oscillating regional/local sequence", () => {
    // The oscillation happens at the band edge, i.e. with no depth inside local.
    const stages = stagesOf(run([
      { level: "regional", readiness: "fully-settled" },
      { level: "local", localProgress: 0.02, readiness: "fully-settled" },
      { level: "regional", readiness: "fully-settled" },
      { level: "local", localProgress: 0.01, readiness: "fully-settled" },
      { level: "regional", readiness: "fully-settled" },
      { level: "local", localProgress: 0.03, readiness: "fully-settled" },
    ], "prewarm"));
    expect(new Set(stages)).toEqual(new Set(["prewarm"]));
  });

  it("shortens the blend under reduced motion without skipping prewarm or the readiness gate", () => {
    expect(earthDiveBlendMs(true)).toBe(EARTH_DIVE_REDUCED_MOTION_BLEND_MS);
    expect(earthDiveBlendMs(false)).toBe(EARTH_DIVE_BLEND_MS);
    expect(earthDiveBlendMs(true)).toBeLessThan(earthDiveBlendMs(false));

    const reduced = settle("particle", {
      level: "local",
      localProgress: 1,
      readiness: "visual-ready",
      reduceMotion: true,
    });
    expect(stagesOf(reduced)).toEqual(["prewarm", "blending", "detail"]);
    expect(new Set(reduced.map((entry) => entry.blendMs)))
      .toEqual(new Set([EARTH_DIVE_REDUCED_MOTION_BLEND_MS]));
    // Reduced motion is a timing choice, not a licence to skip the gate.
    expect(stagesOf(run([{
      level: "local",
      localProgress: 1,
      readiness: "mounted",
      reduceMotion: true,
    }]))).toEqual(["prewarm"]);
  });
});

describe("earth dive ownership", () => {
  const dive: Frame = {
    level: "local",
    localProgress: 1,
    readiness: "visual-ready",
  };

  it("keeps exactly one owner authoritative on every frame", () => {
    const published = settle("particle", dive);
    for (const entry of published) {
      expect(["particle", "detail"]).toContain(entry.owner);
    }
    // The owner is its own value, not a reading of opacity: `blending` is the
    // stage at which the detail surface is visible, and the particle globe is
    // still the input owner there.
    expect(published.map((entry) => [entry.stage, entry.owner])).toEqual([
      ["prewarm", "particle"],
      ["blending", "particle"],
      ["detail", "detail"],
    ]);
  });

  it("transfers ownership exactly once across a whole dive", () => {
    const published = settle("particle", dive);
    const transfers = published.filter((entry, index) => (
      entry.owner !== (published[index - 1] ?? INITIAL_EARTH_DIVE_STATE).owner
    ));
    expect(transfers).toHaveLength(1);
    expect(transfers[0].stage).toBe("detail");
  });

  it("does not transfer ownership to a surface the blend has not put on screen yet", () => {
    // One wheel notch can cross both progress cuts, so the commit edge would
    // otherwise be reached on the frame after `blending` — while the layer is
    // still fading in and the user cannot see what they are steering.
    const crossing = { ...dive, blendPresented: false };
    expect(resolveEarthDive(state("blending"), input(crossing)))
      .toMatchObject({ stage: "blending", owner: "particle" });
    expect(stagesOf(settle("particle", crossing))).toEqual(["prewarm", "blending"]);
    // It is a gate on the transfer, not a stage: once the surface is on screen
    // the same frame commits.
    expect(resolveEarthDive(state("blending"), input(dive)))
      .toMatchObject({ stage: "detail", owner: "detail" });
    // And it never delays a REVERSAL: a user zooming back out is obeyed on the
    // frame they do it, however the presentation is doing.
    expect(resolveEarthDive(state("detail"), input({ ...crossing, releaseRequested: true })))
      .toMatchObject({ stage: "blending", owner: "particle" });
    expect(resolveEarthDive(state("detail"), input({ ...crossing, level: "macro" })))
      .toMatchObject({ stage: "blending", owner: "particle" });
  });

  it("brings ownership home the moment the stage leaves detail", () => {
    expect(resolveEarthDive(state("detail"), input({
      ...dive,
      releaseRequested: true,
    }))).toMatchObject({ stage: "blending", owner: "particle" });
  });

  it("invalidates a handoff older than the focus intent on the same frame", () => {
    const stale: Frame = { ...dive, handoffRevision: 3, focusRevision: 4 };
    // Pending at the last step before ownership transfers: it resolves away
    // from detail rather than committing a handoff aligned to a place the user
    // has left, and the particle globe never loses the camera.
    expect(resolveEarthDive(state("blending"), input(stale)))
      .toMatchObject({ stage: "prewarm", owner: "particle" });
    // The same frame with a current intent commits.
    expect(resolveEarthDive(state("blending"), input({ ...stale, focusRevision: 3 })))
      .toMatchObject({ stage: "detail", owner: "detail" });
    // A handoff that already committed is not torn down: the map owns the view,
    // so a later re-focus is an ordinary map flight.
    expect(resolveEarthDive(state("detail"), input(stale)))
      .toMatchObject({ stage: "detail", owner: "detail" });
  });

  it("lets the fallback command request the same dive without bypassing a gate", () => {
    expect(stagesOf(settle("particle", {
      level: "regional",
      readiness: "visual-ready",
      commandRequested: true,
    }))).toEqual(["prewarm", "blending", "detail"]);
    // The command is the accessibility path into the same dive, so it works
    // from a far band too - it stands in for the zoom gate, and only that.
    expect(stagesOf(settle("particle", {
      level: "planet",
      readiness: "visual-ready",
      commandRequested: true,
    }))).toEqual(["prewarm", "blending", "detail"]);
    // Withdrawing it releases through the same ladder rather than cutting out.
    expect(stagesOf(settle("detail", { level: "planet", readiness: "visual-ready" })))
      .toEqual(["blending", "prewarm", "particle"]);
    expect(stagesOf(run([
      { level: "regional", readiness: "mounted", commandRequested: true },
      { level: "regional", readiness: "mounted", commandRequested: true },
    ]))).toEqual(["prewarm", "prewarm"]);
    // Withdrawing the command is the way out of a dive whose detail surface
    // never becomes available: the band's own exit is reachable again.
    expect(stagesOf(run([
      { level: "macro", readiness: "mounted", commandRequested: true },
      { level: "macro", readiness: "mounted" },
    ], "prewarm"))).toEqual(["prewarm", "particle"]);
  });
  // #253: globe focus mode promises a viewport with exactly ONE piece of
  // persistent chrome. The detail renderer brings MapLibre's own bottom-right
  // navigation and bottom-left attribution controls, which this app does not
  // own and therefore cannot restyle away, so the mode suspends the Dive
  // outright rather than trying to hide its output.
  describe("suspension by the surrounding Atlas mode (#253)", () => {
    it("resolves home from a committed detail dive, one stage per frame", () => {
      // The zoom authority still reports `local` at full depth and the map is
      // fully settled: nothing except the suspension is asking to leave.
      const deep = {
        level: "local" as GlobeSemanticZoom,
        localProgress: 1,
        readiness: "fully-settled" as DetailReadiness,
        suspended: true,
      };
      const published = settle("detail", deep);
      expect(stagesOf(published)).toEqual(["blending", "prewarm", "particle"]);
      // Ownership comes home on the first frame that leaves `detail`, so the
      // particle globe answers the gestures again before the map is torn down.
      expect(published[0].owner).toBe("particle");
      expect(published.at(-1)).toMatchObject({ stage: "particle", owner: "particle" });
    });

    it("outranks the fallback command, which otherwise stands in for the zoom gate", () => {
      // `commandRequested` is the one input that grants the zoom gate from any
      // band. Focus mode removes the control that issues it, but a command
      // latched before entry must not survive into the mode either.
      expect(stagesOf(settle("particle", {
        level: "planet",
        readiness: "fully-settled",
        commandRequested: true,
        suspended: true,
      }))).toEqual([]);
      expect(resolveEarthDive(state("particle"), input({
        level: "local",
        localProgress: 1,
        readiness: "fully-settled",
        commandRequested: true,
        suspended: true,
      }))).toMatchObject({ stage: "particle", owner: "particle" });
    });

    it("cannot re-arm while it holds, however deep the zoom authority reads", () => {
      // The gesture hint the mode shows says SCROLL TO ZOOM, so a suspended
      // mode is precisely the state in which deep zoom readings arrive.
      const frames = [0.5, 0.9, 1, 1, 1].map((localProgress) => ({
        level: "local" as GlobeSemanticZoom,
        localProgress,
        readiness: "fully-settled" as DetailReadiness,
        suspended: true,
      }));
      expect(stagesOf(run(frames))).toEqual([
        "particle", "particle", "particle", "particle", "particle",
      ]);
    });

    it("hands the band back its decision the moment it lifts", () => {
      // Leaving the mode is not itself a dive: the band decides, exactly as it
      // does for a user who never entered focus mode at all.
      const deep = {
        level: "local" as GlobeSemanticZoom,
        localProgress: 1,
        readiness: "fully-settled" as DetailReadiness,
      };
      expect(stagesOf(run([{ ...deep, suspended: true }, deep, deep, deep])))
        .toEqual(["particle", "prewarm", "blending", "detail"]);
      // ...and a shallow band still gets nothing, so lifting the suspension
      // grants no zoom of its own.
      expect(stagesOf(run([
        { level: "planet", readiness: "fully-settled", suspended: true },
        { level: "planet", readiness: "fully-settled" },
      ]))).toEqual(["particle", "particle"]);
    });
  });
});
