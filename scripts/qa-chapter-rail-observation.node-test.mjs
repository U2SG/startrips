import assert from "node:assert/strict";
import test from "node:test";
import { gradeChapterRailReveal } from "./qa-chapter-rail-observation.mjs";

const wide = { railWidth: 1560, scrollLeft: 0, activeLeft: 1360, activeRight: 1450 };
test("an already-visible selected chapter does not require synthetic scrolling", () => {
  assert.deepEqual(gradeChapterRailReveal(wide), { failed: false, requiresScroll: false, visible: true });
});
test("narrowing the rail makes real automatic reveal mandatory", () => {
  assert.deepEqual(gradeChapterRailReveal({ ...wide, railWidth: 1083 }),
    { failed: true, requiresScroll: true, visible: false });
  assert.deepEqual(gradeChapterRailReveal({ railWidth: 1083, scrollLeft: 367, activeLeft: 993, activeRight: 1083 }),
    { failed: false, requiresScroll: true, visible: true });
});
test("positive scrolling alone cannot pass clipped or overshot chapters", () => {
  for (const observation of [
    { railWidth: 1083, scrollLeft: 30, activeLeft: 1330, activeRight: 1420 },
    { railWidth: 1083, scrollLeft: 1400, activeLeft: -40, activeRight: 50 },
  ]) assert.equal(gradeChapterRailReveal(observation).failed, true);
});
test("missing or non-finite geometry never counts as visible", () => {
  for (const key of Object.keys(wide)) {
    for (const value of [undefined, null, NaN, Infinity]) {
      assert.equal(gradeChapterRailReveal({ ...wide, [key]: value }).failed, true);
    }
  }
  assert.equal(gradeChapterRailReveal({ ...wide, railWidth: 0 }).failed, true);
  assert.equal(gradeChapterRailReveal({ ...wide, activeRight: wide.activeLeft }).failed, true);
});
