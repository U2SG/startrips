import { createRequire } from "node:module";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  AUTO_TURN_RISE,
  autoTurnFloorTop,
  autoTurnFrameTop,
  turnPeakSheetTop,
  BOOK_CAMERA_TILT,
  BOOK_SHEET_SPACING,
  bookFrame,
  bookTableHeight,
  cappedFlightFrameTop,
  coverKeyLight,
  EDGE_LIFT,
  faceScreenRect,
  fitBookFrame,
  flightFrameTop,
  FRAME_FOLLOW_EPSILON,
  HOVER_EDGE_HEIGHT,
  MAX_PULLBACK,
  pullBackTopLimit,
  restBookFrame,
  screenUp,
  KEY_SHADOW,
  RAKING_ELEVATION,
  READING_KEY,
  restingPageHeight,
  sheetFlipPose,
  sheetStiffness,
  stackSheets,
  stepFrameFollow,
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
    for (const lift of [0, 1]) {
      const narrow = bookFrame(0.5, 0.8, "landscape", 4, lift);
      expect(narrow.halfWidth * 2).toBeGreaterThanOrEqual(1.6);
      expect((narrow.halfWidth * 2) / (narrow.top - narrow.bottom)).toBeCloseTo(0.5);
      const wide = bookFrame(3, 0.8, "landscape", 4, lift);
      expect(wide.top - wide.bottom).toBeGreaterThanOrEqual(cos);
      expect((wide.halfWidth * 2) / (wide.top - wide.bottom)).toBeCloseTo(3);
    }
  });

  it("frames one page in portrait", () => {
    const frame = bookFrame(0.6, 0.8, "portrait", 4, 0);
    expect(frame.halfWidth * 2).toBeGreaterThanOrEqual(0.8);
    expect(frame.top - frame.bottom).toBeGreaterThanOrEqual(cos);
  });

  it("keeps the full-lift frame of a page standing upright mid-turn", () => {
    // The frame before the rest framing: top = sin + cos / 2 + margin.
    const frame = bookFrame(3, 0.8, "landscape", 4, 1);
    expect(frame.top).toBeCloseTo(sin + cos / 2 + 0.05, 12);
    expect(frame.bottom).toBeCloseTo(-BOOK_SHEET_SPACING * 5 * sin - cos / 2 - 0.05, 12);
    expect(frame.halfWidth).toBeCloseTo((3 * (frame.top - frame.bottom)) / 2, 12);
    const narrow = bookFrame(0.5, 0.8, "landscape", 4, 1);
    expect(narrow.halfWidth).toBeCloseTo(1.6 * 1.08 / 2, 12);
  });

  it("tilts the camera 15 degrees toward the reader", () => {
    expect(BOOK_CAMERA_TILT).toBeCloseTo((15 * Math.PI) / 180, 12);
  });

  it("frames a settled book tightly: a page fills about 87% of a wide stage", () => {
    // Without the hover headroom (lift 0) the page would fill about 90%.
    expect(bookFrame(3, 0.8, "landscape", 4, 0).top - bookFrame(3, 0.8, "landscape", 4, 0).bottom).toBeCloseTo(1.0675, 3);
    const frame = restBookFrame(3, 0.8, "landscape", 4);
    expect(frame.top - frame.bottom).toBeCloseTo(1.112, 3);
    expect(cos / (frame.top - frame.bottom)).toBeGreaterThan(0.86);
    // Against the #634 frame (lift 1, at its 20 degree tilt), where it filled about 68%.
    const tilt634 = (20 * Math.PI) / 180;
    const frame634 = bookFrame(3, 0.8, "landscape", 4, 1, tilt634);
    expect(Math.cos(tilt634) / (frame634.top - frame634.bottom)).toBeLessThan(0.7);
    // The near and far edges of the settled page still clear the frame.
    expect(frame.top).toBeGreaterThanOrEqual(cos / 2 + 0.05 - 1e-12);
  });

  it("grows the frame monotonically as the page stands up", () => {
    for (const aspect of [0.5, 1, 1.9, 3]) {
      let previous = bookFrame(aspect, 0.8, "landscape", 40, 0);
      for (let step = 1; step <= 20; step += 1) {
        const frame = bookFrame(aspect, 0.8, "landscape", 40, step / 20);
        expect(frame.top - frame.bottom).toBeGreaterThanOrEqual(previous.top - previous.bottom - 1e-12);
        expect(frame.top).toBeGreaterThanOrEqual(previous.top - 1e-12);
        previous = frame;
      }
    }
  });

  it("writes into a supplied frame without allocating", () => {
    const out = { top: 0, bottom: 0, halfWidth: 0 };
    expect(bookFrame(1.9, 0.8, "landscape", 4, 0.5, BOOK_CAMERA_TILT, out)).toBe(out);
    expect(out).toEqual(bookFrame(1.9, 0.8, "landscape", 4, 0.5));
  });

  it("holds a page standing mid-turn and the whole stack thickness on any stage", () => {
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const aspect of [0.5, 0.6, 1, 1.9, 3]) {
        for (const sheets of [1, 40, 200]) {
          const frame = bookFrame(aspect, 0.8, orientation, sheets, 1);
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
    const frame = restBookFrame(1.9, 0.8, "landscape", sheets);
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
    // A deep book: at the first spread the left page lies 39 sheets below the right.
    const left = faceScreenRect({ side: "left", spread: 1, sheets, frame, pixelsPerUnit, spineX: 0, pageWidth: 0.8 });
    const right = faceScreenRect({ side: "right", spread: 1, sheets, frame, pixelsPerUnit, spineX: 0, pageWidth: 0.8 });
    expect(left.top - right.top).toBeCloseTo(BOOK_SHEET_SPACING * (sheets - 1) * sin * pixelsPerUnit, 6);
  });
});

describe("framing a sheet in flight", () => {
  const MARGIN = 0.05;
  // The uncurled far corner of a sheet turned `t` of the way (0–1).
  const cornerUp = (t: number) => screenUp(Math.sin(Math.PI * t), -0.5);
  const rest = restBookFrame(3, 0.8, "landscape", 4);
  const restHeight = rest.top - rest.bottom;
  // The frame the camera eases toward, under the pull-back cap.
  const flightFrame = (t: number) => fitBookFrame(3, 0.8, "landscape", 4, cappedFlightFrameTop(t > 0 ? cornerUp(t) : null, rest, 4));

  it("frames the rest state with room for a hover-lifted edge", () => {
    expect(HOVER_EDGE_HEIGHT).toBeCloseTo(Math.sin(Math.PI * EDGE_LIFT), 12);
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const aspect of [0.5, 1, 1.9, 3]) {
        for (const sheets of [1, 40, 200]) {
          const frame = restBookFrame(aspect, 0.8, orientation, sheets);
          expect(frame.top).toBeGreaterThanOrEqual(screenUp(HOVER_EDGE_HEIGHT, -0.5) + MARGIN - 1e-12);
          expect(frame).toEqual(bookFrame(aspect, 0.8, orientation, sheets, HOVER_EDGE_HEIGHT));
        }
      }
    }
  });

  it("leaves the camera at rest for a hover in either direction", () => {
    for (const t of [EDGE_LIFT, 1 - EDGE_LIFT]) {
      const frame = flightFrame(t);
      expect(frame.top).toBeCloseTo(rest.top, 12);
      expect(frame.bottom).toBeCloseTo(rest.bottom, 12);
      expect(frame.halfWidth).toBeCloseTo(rest.halfWidth, 12);
    }
    expect(flightFrameTop(null)).toBeCloseTo(rest.top, 12);
    expect(flightFrameTop(Number.NaN)).toBeCloseTo(rest.top, 12);
  });

  it("asks, before the cap, for the measured sheet top a margin inside the frame", () => {
    for (const sheetTop of [-1, 0, 0.4, 0.6, 0.8, 1.2]) {
      expect(flightFrameTop(sheetTop)).toBeGreaterThanOrEqual(sheetTop + MARGIN);
      expect(flightFrameTop(sheetTop)).toBeGreaterThanOrEqual(flightFrameTop(null));
    }
  });

  it("caps the pull-back at 8% of the rest frame for every progress, a rigid cover's full turn included", () => {
    expect(MAX_PULLBACK).toBe(0.08);
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const aspect of [0.5, 1, 1.9, 3]) {
        for (const sheets of [1, 40, 200]) {
          const restFrame = restBookFrame(aspect, 0.8, orientation, sheets);
          const restH = restFrame.top - restFrame.bottom;
          const limit = pullBackTopLimit(restFrame, sheets);
          // A board turns rigidly, so its uncurled far corner is its highest
          // point; t = 0.5 stands it upright at screenUp(1, -0.5).
          const tops = Array.from({ length: 201 }, (_, step) => cornerUp(step / 200));
          tops.push(screenUp(1, -0.5), 5);
          for (const sheetTop of tops) {
            const top = cappedFlightFrameTop(sheetTop, restFrame, sheets);
            const frame = fitBookFrame(aspect, 0.8, orientation, sheets, top);
            const height = frame.top - frame.bottom;
            expect(height).toBeLessThanOrEqual((1 + MAX_PULLBACK) * restH + 1e-12);
            expect(height).toBeGreaterThanOrEqual(restH - 1e-12);
            if (flightFrameTop(sheetTop) <= limit) {
              // Below the cap the sheet is still a margin inside the frame.
              expect(frame.top).toBeGreaterThanOrEqual(sheetTop + MARGIN - 1e-12);
            } else {
              // At the cap the frame is exactly 8% taller than at rest.
              expect(height).toBeCloseTo((1 + MAX_PULLBACK) * restH, 12);
              expect(frame.top).toBeCloseTo(limit, 12);
            }
          }
        }
      }
    }
  });

  it("shrinks a mid-turn book by at most 1 - 1/1.08 (about 7.4%), down from about 20%", () => {
    const upright = screenUp(1, -0.5);
    // The book's on-screen size scales with restHeight / frame height.
    const shrink = (top: number) => {
      const frame = fitBookFrame(3, 0.8, "landscape", 4, top);
      return 1 - restHeight / (frame.top - frame.bottom);
    };
    expect(shrink(cappedFlightFrameTop(upright, rest, 4))).toBeCloseTo(1 - 1 / 1.08, 12);
    // Uncapped at 15 degrees it would shrink about 16%.
    expect(shrink(flightFrameTop(upright))).toBeCloseTo(0.162, 3);
    // Before: uncapped at the 20 degree tilt it shrank about 20.5%.
    const tilt20 = (20 * Math.PI) / 180;
    const rest20 = restBookFrame(3, 0.8, "landscape", 4, tilt20);
    const full20 = bookFrame(3, 0.8, "landscape", 4, 1, tilt20);
    expect(1 - (rest20.top - rest20.bottom) / (full20.top - full20.bottom)).toBeCloseTo(0.205, 3);
  });

  it("pulls back continuously and monotonically over a half turn, and returns as it lands", () => {
    const height = (t: number) => {
      const frame = flightFrame(t);
      return frame.top - frame.bottom;
    };
    const step = 1 / 1000;
    for (let t = 0; t < 0.5; t += step) {
      expect(height(t + step)).toBeGreaterThanOrEqual(height(t) - 1e-12);
      expect(height(t + step) - height(t)).toBeLessThan(0.005);
    }
    for (let t = 0.5; t < 1 - step / 2; t += step) {
      expect(height(t + step)).toBeLessThanOrEqual(height(t) + 1e-12);
      expect(height(t) - height(t + step)).toBeLessThan(0.005);
    }
    // Mid-turn the cap holds the frame 8% taller than at rest.
    expect(height(0.5)).toBeCloseTo((1 + MAX_PULLBACK) * restHeight, 12);
    expect(flightFrame(1)).toEqual(rest);
  });

  it("fits the same frame from a top as from a lift", () => {
    for (const lift of [0, HOVER_EDGE_HEIGHT, 0.5, 1]) {
      const frame = bookFrame(1.9, 0.8, "landscape", 40, lift);
      const top = screenUp(lift, -0.5) + MARGIN;
      expect(fitBookFrame(1.9, 0.8, "landscape", 40, top)).toEqual(frame);
    }
  });
});

describe("an automatic turn's camera", () => {
  const sheets = 3;
  const rest = restBookFrame(3, 0.8, "landscape", sheets);
  const restTop = flightFrameTop(null);

  // quick_flipbook's ES build imports CommonJS three.modifiers by name, which
  // Node rejects, so load its CommonJS build, with the three it requires.
  const require = createRequire(import.meta.url);
  const { FlipBook } = require("quick_flipbook") as typeof import("quick_flipbook");
  const CjsThree = require("three") as typeof THREE;

  // A real quick_flipbook book; sheet 1 is interior, as in the product.
  const book = new FlipBook({ flipDuration: 1, pageSubdivisions: 16, yBetweenPages: BOOK_SHEET_SPACING });
  // Its own three's material, so the book takes it as a material, not a URL.
  const material = new CjsThree.MeshBasicMaterial();
  book.setPages(Array.from({ length: sheets * 2 }, () => material));
  book.scale.x = 0.8;
  const sheet = [...book][1];
  const point = new THREE.Vector3();

  /** Pose the real sheet as the scene does and return its highest screen-up. */
  const poseTop = (pose: ReturnType<typeof sheetFlipPose>) => {
    sheet.rotation.z = pose.rotationZ;
    sheet.bend.force = pose.bendForce;
    sheet.twist.angle = pose.twistAngle;
    (sheet.pageCurve as { intensity: number }).intensity = pose.curveIntensity;
    sheet.modifiers.apply();
    sheet.page.updateWorldMatrix(true, false);
    const position = sheet.page.geometry.getAttribute("position");
    let top = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(sheet.page.matrixWorld);
      top = Math.max(top, screenUp(point.y, point.z));
    }
    return top;
  };

  /** The sheet's highest point over a whole turn, finely and off the peak's sample grid. */
  const measuredTop = (stiffness: number) => {
    let top = -Infinity;
    for (let step = 1; step < 499; step += 1) {
      const t = step / 499;
      book.progress = 1 + t;
      for (const direction of [-1, 1]) top = Math.max(top, poseTop(sheetFlipPose(t, direction, 1, stiffness)));
    }
    return top;
  };
  const peak = (stiffness: number) => turnPeakSheetTop(stiffness, poseTop);

  it("peaks a rigid cover exactly where it stands upright", () => {
    expect(peak(1)).toBeCloseTo(screenUp(1, -0.5), 12);
    const top = measuredTop(1);
    expect(top).toBeLessThanOrEqual(peak(1) + 1e-9);
    expect(top).toBeGreaterThan(peak(1) - 1e-3);
  });

  it("measures a curling, twisting sheet of paper's peak from above, close", () => {
    const top = measuredTop(0);
    expect(top).toBeLessThanOrEqual(peak(0));
    expect(peak(0) - top).toBeLessThan(0.006);
    // Turning back, paper's curl lifts it above an upright board.
    expect(top).toBeGreaterThan(peak(1));
  });

  it("holds the turn's peak under the cap, for rigid and paper alike", () => {
    for (const stiffness of [0, 1]) {
      const top = autoTurnFrameTop(peak(stiffness), rest, sheets);
      expect(top).toBeLessThanOrEqual(pullBackTopLimit(rest, sheets) + 1e-12);
      // On a wide stage the upright page needs more than the cap allows.
      expect(top).toBeCloseTo(pullBackTopLimit(rest, sheets), 12);
      const frame = fitBookFrame(3, 0.8, "landscape", sheets, top);
      expect((frame.top - frame.bottom) / (rest.top - rest.bottom) - 1).toBeCloseTo(MAX_PULLBACK, 12);
    }
    // On a narrow stage the slack may hold the upright page without the cap.
    const narrow = restBookFrame(0.5, 0.8, "landscape", sheets);
    expect(autoTurnFrameTop(peak(1), narrow, sheets)).toBeLessThanOrEqual(pullBackTopLimit(narrow, sheets));
    expect(autoTurnFrameTop(peak(1), narrow, sheets)).toBeLessThanOrEqual(flightFrameTop(peak(1)) + 1e-12);
  });

  it("raises its floor smoothly from rest to the peak frame before the sheet gets there", () => {
    const peakTop = autoTurnFrameTop(peak(1), rest, sheets);
    expect(autoTurnFloorTop(0, restTop, peakTop)).toBe(restTop);
    expect(autoTurnFloorTop(AUTO_TURN_RISE, restTop, peakTop)).toBeCloseTo(peakTop, 12);
    expect(autoTurnFloorTop(-2, restTop, peakTop)).toBeCloseTo(peakTop, 12);
    let previous = restTop;
    for (let step = 1; step <= 100; step += 1) {
      const floor = autoTurnFloorTop((step / 100) * AUTO_TURN_RISE, restTop, peakTop);
      expect(floor).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(floor - previous).toBeLessThan((peakTop - restTop) * 0.02);
      previous = floor;
    }
    // A camera on the floor never crops a rising rigid cover more than the
    // cap crops it held upright.
    const capFrame = fitBookFrame(3, 0.8, "landscape", sheets, peakTop);
    const heldOvershoot = (peak(1) - capFrame.top) / (capFrame.top - capFrame.bottom);
    for (let step = 0; step <= 500; step += 1) {
      const t = step / 1000;
      const frame = fitBookFrame(3, 0.8, "landscape", sheets, autoTurnFloorTop(t, restTop, peakTop));
      const overshoot = (screenUp(Math.sin(Math.PI * t), -0.5) - frame.top) / (frame.top - frame.bottom);
      expect(overshoot).toBeLessThanOrEqual(heldOvershoot + 1e-12);
    }
  });
});

describe("camera follow", () => {
  const RATE = 1 / 0.25;
  const REST = 0.4;
  const CAP = 0.49;

  /** Steps until the follow lands exactly on `target`, or Infinity. */
  const stepsToLand = (from: number, velocity: number, target: number, delta: number) => {
    const follow = { top: from, velocity };
    for (let step = 1; step <= 100_000; step += 1) {
      stepFrameFollow(follow, target, REST, CAP, RATE, delta);
      expect(follow.top).toBeLessThanOrEqual(CAP);
      expect(follow.top).toBeGreaterThanOrEqual(REST);
      if (follow.top === target && follow.velocity === 0) return step;
    }
    return Infinity;
  };

  it("lands exactly on the target in finite steps at any frame rate, outward and back", () => {
    for (const delta of [1 / 120, 1 / 60, 0.04, 0.25, 1]) {
      for (const [from, target] of [[REST, CAP], [CAP, REST], [REST, 0.45], [0.45, REST]]) {
        const steps = stepsToLand(from, 0, target, delta);
        expect(steps).toBeLessThan(Infinity);
        // Under about 3 s of follow time at the 0.25 s time constant, whatever the step.
        expect(steps * delta).toBeLessThan(3.5);
      }
    }
  });

  it("eases rather than snaps, and is independent of the frame rate", () => {
    const one = stepFrameFollow({ top: REST, velocity: 0 }, CAP, REST, CAP, RATE, 0.1);
    expect(one.top).toBeGreaterThan(REST);
    expect(one.top).toBeLessThan(REST + (CAP - REST) * 0.2);
    const halves = { top: REST, velocity: 0 };
    stepFrameFollow(halves, CAP, REST, CAP, RATE, 0.05);
    stepFrameFollow(halves, CAP, REST, CAP, RATE, 0.05);
    expect(halves.top).toBeCloseTo(one.top, 12);
    expect(halves.velocity).toBeCloseTo(one.velocity, 12);
  });

  it("holds the cap and the rest frame against carried velocity", () => {
    const outward = stepFrameFollow({ top: CAP - 1e-3, velocity: 5 }, CAP, REST, CAP, RATE, 0.1);
    expect(outward.top).toBe(CAP);
    expect(outward.velocity).toBeLessThanOrEqual(0);
    const back = stepFrameFollow({ top: REST + 1e-3, velocity: -5 }, REST, REST, CAP, RATE, 0.1);
    expect(back.top).toBe(REST);
    expect(back.velocity).toBeGreaterThanOrEqual(0);
    expect(stepsToLand(CAP - 1e-3, 5, CAP, 1 / 60)).toBeLessThan(Infinity);
    expect(stepsToLand(REST + 1e-3, -5, REST, 1 / 60)).toBeLessThan(Infinity);
  });

  it("lands at once when never framed, and holds still over an empty step", () => {
    expect(stepFrameFollow({ top: Number.NaN, velocity: 3 }, 0.42, REST, CAP, RATE, 0.016)).toEqual({ top: 0.42, velocity: 0 });
    expect(stepFrameFollow({ top: 0.45, velocity: 0.1 }, REST, REST, CAP, RATE, 0)).toEqual({ top: 0.45, velocity: 0.1 });
    expect(FRAME_FOLLOW_EPSILON).toBeGreaterThan(0);
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

describe("coverKeyLight", () => {
  const elevation = (pose: { x: number; y: number; z: number }) => Math.atan2(pose.y, Math.hypot(pose.x, pose.z));

  it("rakes from the upper left while the front cover is closed", () => {
    const pose = coverKeyLight(0, false);
    expect(elevation(pose)).toBeCloseTo(RAKING_ELEVATION, 6);
    // Screen up is world -Z and screen left world -X.
    expect(pose.x).toBeLessThan(0);
    expect(pose.z).toBeLessThan(0);
    expect(Math.hypot(pose.x, pose.y, pose.z)).toBeCloseTo(Math.hypot(READING_KEY.x, READING_KEY.y, READING_KEY.z), 6);
  });

  it("is today's reading light once the cover is open, and stays there", () => {
    for (const progress of [1, 1.5, 12]) {
      expect(coverKeyLight(progress, false)).toEqual({ ...READING_KEY, shadowNormalBias: KEY_SHADOW.normalBias });
    }
  });

  it("keeps the irradiance on flat paper constant", () => {
    const flat = READING_KEY.intensity * Math.sin(elevation(READING_KEY));
    for (const progress of [0, 0.3, 0.7, 1]) {
      const pose = coverKeyLight(progress, false);
      expect(pose.intensity * Math.sin(elevation(pose))).toBeCloseTo(flat, 6);
    }
  });

  it("grows the shadow's normal offset at the low angle, short of the book's thickness", () => {
    const raking = coverKeyLight(0, false).shadowNormalBias;
    expect(raking).toBeGreaterThan(KEY_SHADOW.normalBias);
    expect(raking).toBeLessThan(0.03);
  });

  it("rises steadily as the cover opens and ignores a hover lift", () => {
    let previous = -Infinity;
    for (let step = 0; step <= 20; step += 1) {
      const current = elevation(coverKeyLight(step / 20, false));
      expect(current).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = current;
    }
    expect(coverKeyLight(0.055, false)).toEqual(coverKeyLight(0, false));
  });

  it("snaps between the two poses under reduced motion", () => {
    expect(coverKeyLight(0.3, true)).toEqual(coverKeyLight(0, false));
    expect(coverKeyLight(0.6, true)).toEqual(coverKeyLight(1, false));
  });
});

describe("sheet stiffness", () => {
  // quick_flipbook's FlipPage.flip, verbatim.
  const library = (t: number, direction: number, s: number) => ({
    rotationZ: Math.PI * t,
    bendForce: Math.min(-Math.sin(Math.PI * t) / 2, -1e-4) * direction,
    twistAngle: Math.sin(Math.PI * t) / 10,
    curveIntensity: (-1 + 2 * t) * (-Math.sin(Math.PI * t) + 1) * s,
  });
  const steps = Array.from({ length: 21 }, (_, step) => step / 20);

  it("makes the first and last sheet boards and every other sheet paper", () => {
    expect([0, 1, 2, 38, 39].map((index) => sheetStiffness(index, 40))).toEqual([1, 0, 0, 0, 1]);
    expect(sheetStiffness(0, 1)).toBe(1);
    expect([0, 1].map((index) => sheetStiffness(index, 2))).toEqual([1, 1]);
  });

  it("turns paper exactly as quick_flipbook does", () => {
    for (const t of steps) {
      for (const direction of [-1, 1]) {
        for (const s of [0, 0.4, 1]) {
          const pose = sheetFlipPose(t, direction, s, 0);
          const expected = library(t, direction, s);
          expect(pose.rotationZ).toBeCloseTo(expected.rotationZ, 12);
          expect(pose.bendForce).toBeCloseTo(expected.bendForce, 12);
          expect(pose.twistAngle).toBeCloseTo(expected.twistAngle, 12);
          expect(pose.curveIntensity).toBeCloseTo(expected.curveIntensity, 12);
        }
      }
    }
  });

  it("swings a board about the spine without curl or twist", () => {
    for (const t of steps) {
      for (const direction of [-1, 1]) {
        const pose = sheetFlipPose(t, direction, 1, 1);
        expect(pose.rotationZ).toBeCloseTo(Math.PI * t, 12);
        expect(pose.bendForce).toBeCloseTo(-1e-4 * direction, 12);
        expect(pose.twistAngle).toBe(0);
        // The spine curve only gives near the ends of the turn, never more than paper's.
        expect(Math.abs(pose.curveIntensity)).toBeLessThanOrEqual(Math.abs(library(t, direction, 1).curveIntensity) + 1e-12);
      }
    }
    // A quarter of the way over, paper still carries ~15% of its spine curve; a board ~1%.
    expect(Math.abs(sheetFlipPose(0.25, 1, 1, 1).curveIntensity)).toBeLessThan(0.02);
    expect(sheetFlipPose(0.5, 1, 1, 1).curveIntensity).toBe(0);
  });

  it("rests a board in exactly the shape of paper", () => {
    for (const t of [0, 1]) {
      for (const direction of [-1, 1]) {
        for (const s of [0, 0.5, 1]) {
          const board = sheetFlipPose(t, direction, s, 1);
          const paper = sheetFlipPose(t, direction, s, 0);
          expect(board.rotationZ).toBe(paper.rotationZ);
          expect(board.bendForce).toBe(paper.bendForce);
          // sin(π) is 1.2e-16 in floating point, not 0.
          expect(board.twistAngle).toBeCloseTo(paper.twistAngle, 12);
          expect(board.curveIntensity).toBeCloseTo(paper.curveIntensity, 12);
        }
      }
    }
  });
});
