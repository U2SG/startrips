import { describe, expect, it } from "vitest";
import {
  cameraHalfHeight,
  dragFraction,
  dragTurnDirection,
  edgePreviewDirection,
  faceSide,
  facesAtSpread,
  focusX,
  representativeFace,
  shouldCompleteDrag,
  spreadOfFace,
  stepFace,
} from "./journeyBook3dModel";

// Eight faces: cover, six interior pages, back cover — four sheets.
const FACES = 8;

describe("sheet geometry", () => {
  it("maps faces to spreads and sides", () => {
    expect([0, 1, 2, 3, 4, 7].map(spreadOfFace)).toEqual([0, 1, 1, 2, 2, 4]);
    expect(faceSide(0, FACES)).toBe("closed-front");
    expect(faceSide(1, FACES)).toBe("left");
    expect(faceSide(2, FACES)).toBe("right");
    expect(faceSide(7, FACES)).toBe("closed-back");
  });

  it("lists the faces visible at each spread", () => {
    expect(facesAtSpread(0, FACES)).toEqual([0]);
    expect(facesAtSpread(2, FACES)).toEqual([3, 4]);
    expect(facesAtSpread(4, FACES)).toEqual([7]);
    expect(representativeFace(2, FACES)).toBe(4);
    expect(representativeFace(4, FACES)).toBe(7);
  });
});

describe("stepping", () => {
  it("turns a spread at a time in landscape", () => {
    expect(stepFace(0, 1, FACES, "landscape")).toEqual({ face: 2, turns: true });
    expect(stepFace(2, 1, FACES, "landscape")).toEqual({ face: 4, turns: true });
    expect(stepFace(7, 1, FACES, "landscape")).toBeNull();
  });

  it("reads one page at a time in portrait, turning paper only between sheets", () => {
    expect(stepFace(0, 1, FACES, "portrait")).toEqual({ face: 1, turns: true });
    expect(stepFace(1, 1, FACES, "portrait")).toEqual({ face: 2, turns: false });
    expect(stepFace(2, 1, FACES, "portrait")).toEqual({ face: 3, turns: true });
    expect(stepFace(3, -1, FACES, "portrait")).toEqual({ face: 2, turns: true });
    expect(stepFace(0, -1, FACES, "portrait")).toBeNull();
  });

  it("frames the page being read in portrait and the spread in landscape", () => {
    expect(focusX(1, FACES, 0.8, "portrait")).toBeCloseTo(-0.4);
    expect(focusX(2, FACES, 0.8, "portrait")).toBeCloseTo(0.4);
    expect(focusX(0, FACES, 0.8, "portrait")).toBe(0);
    expect(focusX(2, FACES, 0.8, "landscape")).toBe(0);
  });
});

describe("camera fit", () => {
  it("fits the spread width on a narrow stage and the page height on a wide one", () => {
    const narrow = cameraHalfHeight(0.5, 0.8, "landscape");
    expect(narrow * 2 * 0.5).toBeGreaterThanOrEqual(1.6);
    const wide = cameraHalfHeight(3, 0.8, "landscape");
    expect(wide * 2).toBeGreaterThanOrEqual(1);
  });

  it("frames one page in portrait", () => {
    const half = cameraHalfHeight(0.6, 0.8, "portrait");
    expect(half * 2 * 0.6).toBeGreaterThanOrEqual(0.8);
    expect(half * 2).toBeGreaterThanOrEqual(1);
  });
});

describe("drag", () => {
  it("turns forward from the right page and backward from the left in portrait", () => {
    expect(dragTurnDirection(2, FACES, "portrait", -40)).toBe(1);
    expect(dragTurnDirection(2, FACES, "portrait", 40)).toBe(0);
    expect(dragTurnDirection(3, FACES, "portrait", 40)).toBe(-1);
    expect(dragTurnDirection(3, FACES, "portrait", -40)).toBe(0);
  });

  it("follows the drag in landscape and never turns past a cover", () => {
    expect(dragTurnDirection(2, FACES, "landscape", 10)).toBe(-1);
    expect(dragTurnDirection(2, FACES, "landscape", -10)).toBe(1);
    expect(dragTurnDirection(0, FACES, "landscape", -10)).toBe(1);
    expect(dragTurnDirection(0, FACES, "landscape", 10)).toBe(0);
    expect(dragTurnDirection(7, FACES, "landscape", 10)).toBe(-1);
    expect(dragTurnDirection(7, FACES, "landscape", -10)).toBe(0);
  });

  it("measures the turn and decides completion", () => {
    expect(dragFraction(-100, 1, 200)).toBe(0.5);
    expect(dragFraction(100, 1, 200)).toBe(0);
    expect(dragFraction(300, -1, 200)).toBe(1);
    expect(shouldCompleteDrag(0.33, 900)).toBe(true);
    expect(shouldCompleteDrag(0.15, 200)).toBe(true);
    expect(shouldCompleteDrag(0.15, 600)).toBe(false);
  });

  it("lifts only the outer page edge under the pointer", () => {
    const base = { sheets: 4, pointerY: 100, spineX: 400, centerY: 100, pageWidth: 200, pageHeight: 260, edgeZone: 28 };
    expect(edgePreviewDirection({ ...base, spread: 2, pointerX: 590 })).toBe(1);
    expect(edgePreviewDirection({ ...base, spread: 2, pointerX: 210 })).toBe(-1);
    expect(edgePreviewDirection({ ...base, spread: 2, pointerX: 400 })).toBe(0);
    expect(edgePreviewDirection({ ...base, spread: 0, pointerX: 495 })).toBe(1);
  });
});
