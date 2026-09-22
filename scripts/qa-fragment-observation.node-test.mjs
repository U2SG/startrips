import assert from "node:assert/strict";
import test from "node:test";
import { releaseFragmentReply, waitForFragmentReadback } from "./qa-fragment-observation.mjs";

function heldFixture({ method = "DELETE", status = 204, body = null, mismatch = false } = {}) {
  const request = { method: () => method };
  const another = { method: () => method };
  let predicate;
  let resolveReply;
  let bodyReads = 0;
  let finishedReads = 0;
  const reply = new Promise((resolve) => { resolveReply = resolve; });
  const response = {
    request: () => mismatch ? another : request,
    status: () => status,
    json: async () => { bodyReads++; return body; },
    // Reproduces the routed no-content response: this transport promise never
    // resolves, even though the application has received the HTTP status.
    finished: () => { finishedReads++; return new Promise(() => {}); },
  };
  const page = { waitForResponse: (match) => { predicate = match; return reply; } };
  const release = async () => {
    assert.ok(predicate, "response watcher must be registered before release");
    assert.equal(predicate({ request: () => another }), false);
    assert.equal(predicate({ request: () => request }), true);
    resolveReply(response);
  };
  release.request = request;
  return { page, release, counts: () => ({ bodyReads, finishedReads }) };
}

test("delayed DELETE 204 completes without an unresolved transport/body wait", { timeout: 1000 }, async () => {
  const f = heldFixture();
  assert.equal(await releaseFragmentReply(f.page, f.release, 204), null);
  assert.deepEqual(f.counts(), { bodyReads: 0, finishedReads: 0 });
});

test("PUT consumes the exact held response payload rather than another matching URL", async () => {
  const body = { fragment: { id: "old", note: "delayed edit" } };
  const f = heldFixture({ method: "PUT", status: 200, body });
  assert.deepEqual(await releaseFragmentReply(f.page, f.release, 200), body);
  assert.deepEqual(f.counts(), { bodyReads: 1, finishedReads: 0 });
});

test("wrong status is a failure, not a successful stale-response check", async () => {
  const f = heldFixture({ status: 503 });
  await assert.rejects(releaseFragmentReply(f.page, f.release, 204), /Unexpected DELETE fragment response: 503/);
});

test("a different request with the same method cannot satisfy the observation", async () => {
  const f = heldFixture({ mismatch: true });
  await assert.rejects(releaseFragmentReply(f.page, f.release, 204), /Unexpected DELETE fragment response/);
});

test("PUT cannot silently take the no-content shortcut", async () => {
  const f = heldFixture({ method: "PUT" });
  await assert.rejects(releaseFragmentReply(f.page, f.release, 204), /Only fragment DELETE may return 204/);
});

test("edit readback cannot succeed on textarea draft content before the form unmounts", async () => {
  const events = [];
  let finishSave;
  const saved = new Promise((resolve) => { finishSave = resolve; });
  const row = {
    getByRole: (role) => {
      assert.equal(role, "form");
      return { waitFor: async (options) => { assert.deepEqual(options, { state: "detached" }); events.push("wait-save"); await saved; } };
    },
    locator: (selector) => {
      assert.equal(selector, "p.everyday-fragments__note");
      events.push("read-saved-paragraph");
      return {
        waitFor: async (options) => { assert.deepEqual(options, { state: "visible" }); },
        innerText: async () => "saved note",
      };
    },
  };
  const check = waitForFragmentReadback(row, "saved note");
  assert.deepEqual(events, ["wait-save"]);
  finishSave();
  await check;
  assert.deepEqual(events, ["wait-save", "read-saved-paragraph"]);
});

test("wrong saved note still fails the unchanged product assertion", async () => {
  const row = {
    getByRole: () => ({ waitFor: async () => {} }),
    locator: () => ({ waitFor: async () => {}, innerText: async () => "old note" }),
  };
  await assert.rejects(waitForFragmentReadback(row, "new note"), /Fragment note readback mismatch/);
});
