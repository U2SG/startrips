import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  BOOK_CAMERA_TILT,
  BOOK_SHEET_SPACING,
  bookFrame,
  bookTableHeight,
  faceScreenRect,
  restingPageHeight,
  stackSheets,
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
  const cos = Math.cos(BOOK_CAMERA_TILT);
  const sin = Math.sin(BOOK_CAMERA_TILT);

  it("fits the spread width on a narrow stage and the page height on a wide one", () => {
    const narrow = bookFrame(0.5, 0.8, "landscape", 4);
    expect(narrow.halfWidth * 2).toBeGreaterThanOrEqual(1.6);
    expect((narrow.halfWidth * 2) / (narrow.top - narrow.bottom)).toBeCloseTo(0.5);
    const wide = bookFrame(3, 0.8, "landscape", 4);
    expect(wide.top - wide.bottom).toBeGreaterThanOrEqual(cos);
    expect((wide.halfWidth * 2) / (wide.top - wide.bottom)).toBeCloseTo(3);
  });

  it("frames one page in portrait", () => {
    const frame = bookFrame(0.6, 0.8, "portrait", 4);
    expect(frame.halfWidth * 2).toBeGreaterThanOrEqual(0.8);
    expect(frame.top - frame.bottom).toBeGreaterThanOrEqual(cos);
  });

  it("holds a page standing mid-turn and the whole stack thickness on any stage", () => {
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const aspect of [0.5, 0.6, 1, 1.9, 3]) {
        for (const sheets of [1, 40, 200]) {
          const frame = bookFrame(aspect, 0.8, orientation, sheets);
          // The far top corner of an upright page in flight.
          expect(frame.top).toBeGreaterThanOrEqual(sin + cos / 2);
          // The near edge of the deepest sheet, below the near page edge.
          expect(frame.bottom).toBeLessThanOrEqual(-cos / 2 - BOOK_SHEET_SPACING * sheets * sin);
        }
      }
    }
  });

  it("places settled faces where a tilted orthographic camera renders them", () => {
    const sheets = 40;
    const frame = bookFrame(1.9, 0.8, "landscape", sheets);
    const cssHeight = 680;
    const cssWidth = cssHeight * 1.9;
    const pixelsPerUnit = cssHeight / (frame.top - frame.bottom);
    const camera = new THREE.OrthographicCamera(-frame.halfWidth, frame.halfWidth, frame.top, frame.bottom, 0.1, 20);
    camera.position.set(0, 5 * cos, 5 * sin);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const toScreen = (x: number, y: number, z: number) => {
      const point = new THREE.Vector3(x, y, z).project(camera);
      return { x: ((point.x + 1) / 2) * cssWidth, y: ((1 - point.y) / 2) * cssHeight };
    };
    for (const spread of [1, 20, 39]) {
      for (const side of ["left", "right"] as const) {
        const rect = faceScreenRect({ side, spread, sheets, frame, pixelsPerUnit, spineX: cssWidth / 2, pageWidth: 0.8 });
        const y = restingPageHeight(side, spread, sheets);
        const outer = side === "left" ? -0.8 : 0.8;
        const far = toScreen(outer, y, -0.5);
        const near = toScreen(outer, y, 0.5);
        expect(rect.top).toBeCloseTo(far.y, 6);
        expect(rect.top + rect.height).toBeCloseTo(near.y, 6);
        expect(side === "left" ? rect.left : rect.left + rect.width).toBeCloseTo(far.x, 6);
      }
    }
    // A deep book: at the first spread the left page lies a whole stack lower.
    const left = faceScreenRect({ side: "left", spread: 1, sheets, frame, pixelsPerUnit, spineX: 0, pageWidth: 0.8 });
    const right = faceScreenRect({ side: "right", spread: 1, sheets, frame, pixelsPerUnit, spineX: 0, pageWidth: 0.8 });
    expect(left.top - right.top).toBeCloseTo(BOOK_SHEET_SPACING * sheets * sin * pixelsPerUnit, 6);
  });
});

describe("table under the stack", () => {
  it("keeps the deepest sheet above the table on any book size", () => {
    // quick_flipbook rests a sheet up to `sheets` gaps below the spine; a page
    // below the table plane is hidden from its outer edge inwards.
    for (const sheets of [1, 4, 29, 30, 36, 80, 200]) {
      expect(-BOOK_SHEET_SPACING * sheets).toBeGreaterThan(bookTableHeight(sheets));
    }
  });

  it("leaves small books at the original table height", () => {
    expect(bookTableHeight(0)).toBe(-0.035);
    expect(bookTableHeight(20)).toBe(-0.035);
  });

  it("finds the top sheet of each stack where quick_flipbook rests it", () => {
    expect(restingPageHeight("closed-front", 0, 40)).toBeCloseTo(0);
    expect(restingPageHeight("right", 1, 40)).toBeCloseTo(-BOOK_SHEET_SPACING);
    expect(restingPageHeight("left", 1, 40)).toBeCloseTo(-BOOK_SHEET_SPACING * 40);
    expect(restingPageHeight("left", 39, 40)).toBeCloseTo(-BOOK_SHEET_SPACING * 2);
    expect(restingPageHeight("closed-back", 40, 40)).toBeCloseTo(-BOOK_SHEET_SPACING);
  });

  it("counts the sheets lying in each stack, leaving out a sheet in flight", () => {
    expect(stackSheets(0, 40)).toEqual({ left: 0, right: 40, inFlight: false });
    expect(stackSheets(3, 40)).toEqual({ left: 3, right: 37, inFlight: false });
    expect(stackSheets(3.4, 40)).toEqual({ left: 3, right: 36, inFlight: true });
    expect(stackSheets(2.96, 40)).toEqual({ left: 2, right: 37, inFlight: true });
    expect(stackSheets(40, 40)).toEqual({ left: 40, right: 0, inFlight: false });
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
