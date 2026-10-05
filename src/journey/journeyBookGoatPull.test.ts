import { describe, expect, it } from "vitest";
import { STARTRIPS_PULL_PHASES as P } from "../brand/startripsPullClip";
import { BOOK_PAGE_RATIO } from "./journeyBookLayout";
import { coverMarkFrame } from "./journeyBook3dPainter";
import {
  GOAT_OPACITY,
  GOAT_PULL_COVER,
  GOAT_PULL_PLAYED_KEY,
  GOAT_PULL_TOTAL_MS,
  goatPullAutoEligible,
  goatPullCoverProgress,
  goatPullMarkHit,
  goatPullPlayed,
  goatPullStaging,
  markGoatPullPlayed,
} from "./journeyBookGoatPull";

const MARK = coverMarkFrame(BOOK_PAGE_RATIO);
const degrees = (progress: number) => progress * 180;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("cover progress over the goat pull", () => {
  it("holds the cover closed through the wake, the walk and the grip", () => {
    for (const t of [0, P.wakeEnd, P.walkEnd, P.gripEnd]) expect(goatPullCoverProgress(t)).toBe(0);
  });

  it("lifts about 4° on the first tug and drops back shut", () => {
    expect(degrees(goatPullCoverProgress(P.tug1Peak))).toBeCloseTo(4, 5);
    expect(goatPullCoverProgress(P.tug1End)).toBe(0);
    for (let t = P.gripEnd; t <= P.tug1End; t += 10) {
      expect(goatPullCoverProgress(t)).toBeLessThanOrEqual(GOAT_PULL_COVER.tug1 + 1e-12);
    }
  });

  it("lifts about 10° on the second tug and drops back less", () => {
    expect(degrees(goatPullCoverProgress(P.tug2Peak))).toBeCloseTo(10, 5);
    const rest = goatPullCoverProgress(P.tug2End);
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThan(GOAT_PULL_COVER.tug2);
  });

  it("heaves monotonically past upright and hands over to the turn without a jump", () => {
    let previous = goatPullCoverProgress(P.tug2End);
    for (let t = P.tug2End + 5; t <= GOAT_PULL_TOTAL_MS; t += 5) {
      const progress = goatPullCoverProgress(t);
      expect(progress).toBeGreaterThanOrEqual(previous - 1e-12);
      // No step bigger than the turn's own rate allows over 5 ms (plus slack).
      expect(progress - previous).toBeLessThan(0.01);
      previous = progress;
    }
    expect(goatPullCoverProgress(P.release)).toBeGreaterThan(0.5);
    expect(goatPullCoverProgress(P.release - 1)).toBeCloseTo(goatPullCoverProgress(P.release), 2);
    expect(goatPullCoverProgress(GOAT_PULL_TOTAL_MS)).toBeCloseTo(1, 9);
    expect(goatPullCoverProgress(GOAT_PULL_TOTAL_MS + 1_000)).toBe(1);
  });
});

describe("where the goat stands", () => {
  it("starts exactly over its emboss, in the stamped tone, facing as stamped", () => {
    const start = goatPullStaging(0, MARK);
    expect(start.u).toBeCloseTo(MARK.x + MARK.width / 2, 12);
    expect(start.v).toBeCloseTo(MARK.y + MARK.height, 12);
    expect(start).toMatchObject({ facing: 1, tone: 0, opacity: 1, hop: 0, hopLift: 0 });
  });

  it("turns to the fore-edge and walks there along the foot", () => {
    const arrived = goatPullStaging(P.walkEnd, MARK);
    expect(arrived.facing).toBeCloseTo(-1, 9);
    expect(arrived.u).toBeGreaterThan(0.9);
    expect(arrived.u).toBeLessThan(1);
    expect(arrived.tone).toBe(1);
    expect(arrived.opacity).toBeCloseTo(GOAT_OPACITY, 9);
    let previous = 0;
    for (let t = 0; t <= P.walkEnd; t += 20) {
      const { u } = goatPullStaging(t, MARK);
      expect(u).toBeGreaterThanOrEqual(previous);
      previous = u;
    }
  });

  it("hops off after letting go and is gone by the end", () => {
    expect(goatPullStaging(P.letGo, MARK).hop).toBe(0);
    expect(goatPullStaging(P.release, MARK).hop).toBe(1);
    expect(goatPullStaging(P.end, MARK).opacity).toBe(0);
  });
});

describe("when the goat wakes", () => {
  const ready = { reduced: false, played: false, onClosedCover: true, markReady: true, blocked: false };

  it("wakes only on a closed cover at rest, once, with motion allowed", () => {
    expect(goatPullAutoEligible(ready)).toBe(true);
    expect(goatPullAutoEligible({ ...ready, reduced: true })).toBe(false);
    expect(goatPullAutoEligible({ ...ready, played: true })).toBe(false);
    expect(goatPullAutoEligible({ ...ready, onClosedCover: false })).toBe(false);
    expect(goatPullAutoEligible({ ...ready, markReady: false })).toBe(false);
    expect(goatPullAutoEligible({ ...ready, blocked: true })).toBe(false);
  });

  it("remembers each Journey on the device", () => {
    const storage = memoryStorage();
    expect(goatPullPlayed(storage, "journey-a")).toBe(false);
    markGoatPullPlayed(storage, "journey-a");
    expect(goatPullPlayed(storage, "journey-a")).toBe(true);
    expect(goatPullPlayed(storage, "journey-b")).toBe(false);
    expect(JSON.parse(storage.values.get(GOAT_PULL_PLAYED_KEY) ?? "[]")).toEqual(["journey-a"]);
    // A fresh read of the same storage (a reload) still knows.
    expect(goatPullPlayed({ getItem: storage.getItem, setItem: storage.setItem }, "journey-a")).toBe(true);
  });

  it("never replays in the session when storage throws or holds garbage", () => {
    const refusing = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(goatPullPlayed(refusing, "journey-c")).toBe(false);
    expect(() => markGoatPullPlayed(refusing, "journey-c")).not.toThrow();
    expect(goatPullPlayed(refusing, "journey-c")).toBe(true);
    const garbage = memoryStorage();
    garbage.setItem(GOAT_PULL_PLAYED_KEY, "{not json");
    expect(goatPullPlayed(garbage, "journey-d")).toBe(false);
    expect(goatPullPlayed(null, "journey-c")).toBe(true);
  });

  it("replays on a tap within at least a 44 px target around the mark", () => {
    const mark = { left: 100, top: 400, width: 22, height: 20 };
    expect(goatPullMarkHit({ x: 111, y: 410 }, mark)).toBe(true);
    expect(goatPullMarkHit({ x: 111 + 21, y: 410 }, mark)).toBe(true);
    expect(goatPullMarkHit({ x: 111 + 23, y: 410 }, mark)).toBe(false);
    expect(goatPullMarkHit({ x: 111, y: 410 - 23 }, mark)).toBe(false);
  });
});

describe("the cover mark's frame", () => {
  it("sits bottom left on the foot line and keeps the mark's proportions", () => {
    expect(MARK.y + MARK.height).toBeCloseTo(1 - 0.073, 12);
    expect(MARK.x).toBeGreaterThanOrEqual(0.095 - 1e-12);
    expect((MARK.width * BOOK_PAGE_RATIO) / MARK.height).toBeCloseTo(170 / 150, 9);
  });
});
