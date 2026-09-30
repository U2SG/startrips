import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeVersion, selectHostedBrowser } from "./ci-browser-runtime.mjs";

test("Playwright helper, installed package and exact dependency pin must agree", () => {
  assert.doesNotThrow(() => assertRuntimeVersion("1.55.0", "1.55.0", "1.55.0"));
  for (const args of [
    [undefined, "1.55.0", "1.55.0"], ["latest", "1.55.0", "1.55.0"],
    ["1.55.0", "1.56.0", "1.55.0"], ["1.55.0", "1.55.0", "^1.55.0"],
    ["1.55.0", "1.55.0", "1.54.0"],
  ]) assert.throws(() => assertRuntimeVersion(...args), /mismatch/);
});

test("runtime selection preserves hosted Chrome precedence and never silently downloads a browser", () => {
  assert.equal(selectHostedBrowser(undefined, () => true), "/usr/bin/google-chrome");
  assert.equal(selectHostedBrowser("/custom/chrome", () => true), "/custom/chrome");
  assert.equal(selectHostedBrowser(undefined, (p) => p === "/usr/bin/chromium"), "/usr/bin/chromium");
  assert.throws(() => selectHostedBrowser(undefined, () => false), /Hosted Chrome is missing/);
});
