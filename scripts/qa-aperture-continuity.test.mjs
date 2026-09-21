import { describe, expect, it } from "vitest";
import {
  apertureSeamId,
  attributeApertureJumps,
  expectedApertureSeams,
  gradeApertureContinuity,
} from "./qa-aperture-continuity.mjs";

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

  it("fails a real aperture jump and names the seam next to its delta/elapsed evidence", () => {
    // Two seams settled before the sampler pushed this jump, so it belongs to
    // the third — the seam whose window was open when the clip path broke.
    const seams = allSeams.map((seam, index) => ({ seam, settled: true, jumpWatermark: index < 2 ? 0 : 1 }));
    const jumps = attributeApertureJumps(seams, [{ delta: 31.5, elapsed: 16.2 }]);
    const grade = gradeApertureContinuity({ expectedSeams: allSeams, reachedSeams: allSeams, jumps });
    expect(grade.failed).toBe(true);
    expect(grade.jumps).toEqual([{ seam: allSeams[2], delta: 31.5, elapsed: 16.2 }]);
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

describe("aperture jump attribution", () => {
  const raw = [
    { delta: 9, elapsed: 16 },
    { delta: 12, elapsed: 17 },
    { delta: 30, elapsed: 16 },
  ];

  it("gives every raw jump exactly one seam, in sampled order", () => {
    const seams = [
      { seam: allSeams[0], settled: true, jumpWatermark: 1 },
      { seam: allSeams[1], settled: true, jumpWatermark: 1 },
      { seam: allSeams[2], settled: true, jumpWatermark: 3 },
    ];
    const attributed = attributeApertureJumps(seams, raw);
    expect(attributed).toEqual([
      { seam: allSeams[0], ...raw[0] },
      { seam: allSeams[2], ...raw[1] },
      { seam: allSeams[2], ...raw[2] },
    ]);
  });

  it("leaves a jump sampled after the last settled seam unattributed rather than dropping it", () => {
    const seams = [{ seam: allSeams[0], settled: true, jumpWatermark: 1 }];
    const attributed = attributeApertureJumps(seams, raw);
    expect(attributed).toHaveLength(raw.length);
    expect(attributed.slice(1).every((jump) => jump.seam === null)).toBe(true);
  });

  it("skips a seam whose watermark could not be read without losing its jumps", () => {
    const seams = [
      { seam: allSeams[0], settled: false, jumpWatermark: null },
      { seam: allSeams[1], settled: true, jumpWatermark: 2 },
    ];
    const attributed = attributeApertureJumps(seams, raw);
    expect(attributed.map((jump) => jump.seam)).toEqual([allSeams[1], allSeams[1], null]);
  });
});
