import { describe, expect, it } from "vitest";
import { apertureSeamId, expectedApertureSeams, gradeApertureContinuity } from "./qa-aperture-continuity.mjs";

const visited = [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2];
const allSeams = expectedApertureSeams(visited);

describe("mixed-aspect aperture seam plan", () => {
  it("names one seam per exercised transition, including the repeated return leg", () => {
    expect(allSeams).toHaveLength(visited.length - 1);
    expect(allSeams[0]).toBe(apertureSeamId(1, 0, 1));
    expect(allSeams[7]).toBe(apertureSeamId(8, 7, 6));
    // The plan walks 0->1 twice; the step ordinal keeps the two seams distinct.
    expect(allSeams.at(-2)).toBe(apertureSeamId(15, 0, 1));
    expect(new Set(allSeams).size).toBe(allSeams.length);
  });
});

describe("mixed-aspect aperture continuity gate", () => {
  it("passes on sparse, jittered sampling when every seam settled and no clip jumped", () => {
    const grade = gradeApertureContinuity({ expectedSeams: allSeams, reachedSeams: allSeams, jumps: [] });
    expect(grade.failed).toBe(false);
    expect(grade.unreachedSeams).toEqual([]);
  });

  it("fails an unreached seam and names exactly that seam", () => {
    const missing = allSeams[9];
    const grade = gradeApertureContinuity({
      expectedSeams: allSeams,
      reachedSeams: allSeams.filter((seam) => seam !== missing),
      jumps: [],
    });
    expect(grade.failed).toBe(true);
    expect(grade.unreachedSeams).toEqual([missing]);
  });

  it("fails a real aperture jump and keeps its delta/elapsed evidence", () => {
    const jumps = [{ delta: 31.5, elapsed: 16.2 }];
    const grade = gradeApertureContinuity({ expectedSeams: allSeams, reachedSeams: allSeams, jumps });
    expect(grade.failed).toBe(true);
    expect(grade.jumps).toEqual(jumps);
    expect(grade.unreachedSeams).toEqual([]);
  });

  it("reports a settled seam outside the plan without letting the planned seam pass", () => {
    const grade = gradeApertureContinuity({
      expectedSeams: allSeams,
      reachedSeams: [...allSeams.slice(1), apertureSeamId(1, 0, 3)],
      jumps: [],
    });
    expect(grade.failed).toBe(true);
    expect(grade.unreachedSeams).toEqual([allSeams[0]]);
    expect(grade.unexpectedSeams).toEqual([apertureSeamId(1, 0, 3)]);
  });
});
