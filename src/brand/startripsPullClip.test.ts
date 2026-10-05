import { describe, expect, it } from "vitest";
import { STARTRIPS_PULL_DURATION_MS, STARTRIPS_PULL_PHASES as P, sampleStartripsPullPose } from "./startripsPullClip";
import { STARTRIPS_SIGNATURE_CLIPS } from "./startripsSignatureTimeline";

const REST = {
  rootX: 0, rootY: 0, rootRotateDeg: 0, bodyY: 0, headRotateDeg: 0, eyeX: 0, eyeY: 0,
  starX: 0, starY: 0, starScale: 1,
  legFnY: 0, legFnRotateDeg: 0, legFfY: 0, legFfRotateDeg: 0,
  legHnY: 0, legHnRotateDeg: 0, legHfY: 0, legHfRotateDeg: 0,
};

describe("the goat's pull clip", () => {
  it("starts in the stamped rest pose and ends at rest", () => {
    expect(sampleStartripsPullPose(0)).toEqual(REST);
    expect(sampleStartripsPullPose(STARTRIPS_PULL_DURATION_MS)).toEqual(REST);
    expect(sampleStartripsPullPose(STARTRIPS_PULL_DURATION_MS + 5_000)).toEqual(REST);
    expect(sampleStartripsPullPose(Number.NaN)).toEqual(REST);
  });

  it("stays within a restrained range at every sampled time", () => {
    for (let t = 0; t <= STARTRIPS_PULL_DURATION_MS; t += 25) {
      const pose = sampleStartripsPullPose(t);
      for (const [key, value] of Object.entries(pose)) {
        expect(Number.isFinite(value)).toBe(true);
        if (key.endsWith("Deg")) expect(Math.abs(value)).toBeLessThanOrEqual(30);
        else if (key === "starScale") expect(value).toBe(1);
        else expect(Math.abs(value)).toBeLessThanOrEqual(4);
      }
    }
  });

  it("walks with a leg cycle, then leans back harder on each pull", () => {
    const walk = Array.from({ length: 30 }, (_, index) => sampleStartripsPullPose(P.wakeEnd + 100 + index * 20).legFnRotateDeg);
    expect(Math.max(...walk)).toBeGreaterThan(8);
    expect(Math.min(...walk)).toBeLessThan(-8);
    const tug1 = sampleStartripsPullPose(P.tug1Peak).rootRotateDeg;
    const tug2 = sampleStartripsPullPose(P.tug2Peak).rootRotateDeg;
    const heave = sampleStartripsPullPose((P.tug2End + P.letGo) / 2).rootRotateDeg;
    expect(tug1).toBeGreaterThan(5);
    expect(tug2).toBeGreaterThan(tug1);
    expect(heave).toBeGreaterThan(tug2);
    // Between tugs the lean eases off without letting go.
    expect(sampleStartripsPullPose(P.tug1End).rootRotateDeg).toBeLessThan(tug1);
  });

  it("leaves the shared signature clips alone", () => {
    expect(Object.keys(STARTRIPS_SIGNATURE_CLIPS).sort()).toEqual(["full", "loading", "recovery"]);
  });
});
