import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RECOVERY_REASON,
  appendSummary,
  evaluateDispatch,
  extractMainHeadSha,
  fetchMainHeadSha,
  normalizeSha,
} from "./verify-main-sha.mjs";

const MAIN_HEAD = "8d4c3baaa36df8ca5ca28f2f630f2f894f38d3a4";
const OLDER_SHA = "1af2577000000000000000000000000000000000";

function refPayload(sha) {
  return { ref: "refs/heads/main", object: { sha, type: "commit" } };
}

function stubFetch(responder) {
  return async (url, init) => responder(url, init);
}

test("the recovery reason is the exact text the job summary must carry", () => {
  assert.equal(RECOVERY_REASON, "manual recovery for missing exact-main push run");
});

test("a dispatch on the live main HEAD passes and names the SHA and the reason", () => {
  const result = evaluateDispatch({
    eventName: "workflow_dispatch",
    checkoutSha: MAIN_HEAD,
    mainHeadSha: MAIN_HEAD,
  });
  assert.equal(result.checked, true);
  assert.equal(result.matches, true);
  assert.match(result.summary, new RegExp(MAIN_HEAD));
  assert.match(result.summary, new RegExp(RECOVERY_REASON));
});

test("a dispatch on any other SHA is rejected and names both SHAs", () => {
  const result = evaluateDispatch({
    eventName: "workflow_dispatch",
    checkoutSha: OLDER_SHA,
    mainHeadSha: MAIN_HEAD,
  });
  assert.equal(result.checked, true);
  assert.equal(result.matches, false);
  assert.match(result.summary, new RegExp(OLDER_SHA));
  assert.match(result.summary, new RegExp(MAIN_HEAD));
});

test("SHA comparison ignores case and surrounding whitespace", () => {
  const result = evaluateDispatch({
    eventName: "workflow_dispatch",
    checkoutSha: MAIN_HEAD.toUpperCase() + "\n",
    mainHeadSha: MAIN_HEAD,
  });
  assert.equal(result.matches, true);
  assert.equal(result.checkoutSha, MAIN_HEAD);
});

test("push and pull_request runs are not guarded", () => {
  for (const eventName of ["push", "pull_request"]) {
    const result = evaluateDispatch({ eventName, checkoutSha: OLDER_SHA, mainHeadSha: MAIN_HEAD });
    assert.equal(result.checked, false);
    assert.equal(result.matches, true);
    assert.equal(result.summary, null);
  }
});

test("a malformed SHA is a failure, never a match", () => {
  assert.throws(() => normalizeSha("not-a-sha", "checked-out SHA"), /40-character commit SHA/);
  assert.throws(
    () => evaluateDispatch({ eventName: "workflow_dispatch", checkoutSha: "", mainHeadSha: MAIN_HEAD }),
    /checked-out SHA/,
  );
});

test("only a single refs/heads/main ref object yields a HEAD", () => {
  assert.equal(extractMainHeadSha(refPayload(MAIN_HEAD)), MAIN_HEAD);
  assert.throws(() => extractMainHeadSha([refPayload(MAIN_HEAD)]), /single ref object/);
  assert.throws(() => extractMainHeadSha({ ref: "refs/heads/mainline", object: { sha: MAIN_HEAD } }), /refs\/heads\/main/);
  assert.throws(() => extractMainHeadSha({ ref: "refs/heads/main" }), /no ref object/);
});

test("the live lookup authenticates and reads the ref object", async () => {
  const seen = {};
  const sha = await fetchMainHeadSha({
    repository: "U2SG/startrips",
    apiUrl: "https://api.github.com/",
    token: "test-token",
    fetchImpl: stubFetch((url, init) => {
      seen.url = url;
      seen.authorization = init.headers.authorization;
      return { ok: true, status: 200, json: async () => refPayload(MAIN_HEAD) };
    }),
  });
  assert.equal(sha, MAIN_HEAD);
  assert.equal(seen.url, "https://api.github.com/repos/U2SG/startrips/git/ref/heads/main");
  assert.equal(seen.authorization, "Bearer test-token");
});

test("an unavailable or unauthenticated lookup fails closed", async () => {
  await assert.rejects(
    fetchMainHeadSha({
      repository: "U2SG/startrips",
      token: "test-token",
      fetchImpl: stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) })),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchMainHeadSha({ repository: "U2SG/startrips", token: "" }),
    /GitHub token is required/,
  );
  await assert.rejects(
    fetchMainHeadSha({ repository: "startrips", token: "test-token" }),
    /owner\/repo/,
  );
});

test("the job summary line is appended, and a missing summary path is tolerated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-main-sha-"));
  const summaryPath = path.join(dir, "summary.md");
  fs.writeFileSync(summaryPath, "existing\n", "utf8");
  const { summary } = evaluateDispatch({
    eventName: "workflow_dispatch",
    checkoutSha: MAIN_HEAD,
    mainHeadSha: MAIN_HEAD,
  });
  assert.equal(appendSummary(summary, summaryPath), true);
  const written = fs.readFileSync(summaryPath, "utf8");
  assert.match(written, /^existing\n/);
  assert.match(written, new RegExp(MAIN_HEAD + " \(reason: " + RECOVERY_REASON + "\)\."));
  assert.equal(appendSummary(summary, ""), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
