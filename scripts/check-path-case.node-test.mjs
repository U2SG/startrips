import assert from "node:assert/strict";
import test from "node:test";

import { findCaseCollisions, trackedPaths } from "./check-path-case.mjs";

test("catches the issue #500 module specifier collision", () => {
  const collisions = findCaseCollisions([
    "src/brand/StartripsRecoverySurface.tsx",
    "src/brand/startripsRecoverySurface.ts",
    "src/brand/startripsRecoverySurface.test.ts",
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].kind, "module specifier");
  assert.deepEqual(collisions[0].paths, [
    "src/brand/StartripsRecoverySurface.tsx",
    "src/brand/startripsRecoverySurface.ts",
  ]);
});

test("catches two paths differing only in case", () => {
  const collisions = findCaseCollisions(["server/config.ts", "server/Config.ts"]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].kind, "path");
});

test("keeps a module and its sibling test apart", () => {
  assert.deepEqual(
    findCaseCollisions([
      "src/brand/StartripsBrandMark.tsx",
      "src/brand/StartripsBrandMark.test.ts",
      "src/brand/recoverySurfaces.ts",
      "src/brand/recoverySurfaces.test.ts",
      "src/brand/StartripsRecoverySurface.tsx",
    ]),
    [],
  );
});

test("ignores paths outside the checked roots", () => {
  assert.deepEqual(findCaseCollisions(["docs/Readme.md", "docs/README.md"]), []);
});

test("the tracked tree is free of collisions", () => {
  assert.deepEqual(findCaseCollisions(trackedPaths()), []);
});
