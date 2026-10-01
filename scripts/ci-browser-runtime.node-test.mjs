import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeVersion, selectHostedBrowser, launchWithRuntimeCheck, finishRuntimeRecording } from "./ci-browser-runtime.mjs";

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

test("capability checks reuse exactly the suite browser without a second launch", async () => {
  const calls = [];
  const browser = { close: async () => calls.push("close") };
  const result = await launchWithRuntimeCheck(async () => { calls.push("launch"); return browser; }, {
    enabled: true,
    verify: async (actual) => { assert.equal(actual, browser); calls.push("verify"); },
  });
  assert.equal(result, browser);
  assert.deepEqual(calls, ["launch", "verify"]);
});

test("a failed capability assertion closes the real browser and cannot become a pass", async () => {
  const failure = new Error("H.264 unavailable");
  let closed = false;
  await assert.rejects(launchWithRuntimeCheck(async () => ({
    close: async () => { closed = true; throw new Error("cleanup failed"); },
  }), { enabled: true, verify: async () => { throw failure; } }), (actual) => actual === failure);
  assert.equal(closed, true);
});

test("normal non-CI QA does not acquire a second verification path", async () => {
  const browser = {};
  assert.equal(await launchWithRuntimeCheck(async () => browser, {
    enabled: false, verify: async () => { assert.fail("must not run"); },
  }), browser);
});

test("launch failure remains a failure and is never retried", async () => {
  let calls = 0;
  await assert.rejects(launchWithRuntimeCheck(async () => {
    calls++; throw new Error("launch failed");
  }, { enabled: true, verify: async () => assert.fail("must not run") }), /launch failed/);
  assert.equal(calls, 1);
});

test("recorder publication must precede closing the producer context", async () => {
  const order = [];
  let publish;
  const artifact = new Promise((resolve) => { publish = resolve; });
  const finished = finishRuntimeRecording({ close: async () => order.push("close") }, {
    path: () => { order.push("await-artifact"); return artifact; },
  });
  await Promise.resolve();
  assert.deepEqual(order, ["await-artifact"]);
  publish("/tmp/fixture.webm");
  assert.equal(await finished, "/tmp/fixture.webm");
  assert.deepEqual(order, ["await-artifact", "close"]);
});

test("missing or rejected recording transport cannot be treated as a completed recording", async () => {
  const context = { close: async () => assert.fail("failure cleanup belongs to the caller") };
  await assert.rejects(finishRuntimeRecording(context, null), /no video transport/);
  await assert.rejects(finishRuntimeRecording(context, { path: async () => { throw new Error("recorder failed"); } }), /recorder failed/);
});

test("a silent recorder fails within a bounded deadline without sleeping or retrying", async () => {
  let calls = 0;
  await assert.rejects(finishRuntimeRecording({ close: async () => assert.fail("must not close before publication") }, {
    path: () => { calls++; return new Promise(() => {}); },
  }, { timeoutMs: 1 }), /no first frame/);
  assert.equal(calls, 1);
});
