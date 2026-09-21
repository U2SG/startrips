import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECOVERY_REASON,
  WORKFLOW_FILE,
  appendOutput,
  appendSummary,
  evaluateDispatch,
  extractMainHeadSha,
  fetchLastValidatedMainSha,
  fetchMainHeadSha,
  normalizeSha,
  selectLastValidatedMainSha,
} from "./verify-main-sha.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./verify-main-sha.mjs", import.meta.url));

const MAIN_HEAD = "8d4c3baaa36df8ca5ca28f2f630f2f894f38d3a4";
const OLDER_SHA = "1af2577000000000000000000000000000000000";
const OLDEST_SHA = "2bc3688000000000000000000000000000000000";

function runRecord(overrides) {
  return {
    id: 100,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_sha: OLDER_SHA,
    run_started_at: "2026-09-19T10:00:00Z",
    ...overrides,
  };
}

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
  assert.ok(result.summary.includes(MAIN_HEAD));
  assert.ok(result.summary.includes(RECOVERY_REASON));
});

test("a dispatch on any other SHA is rejected and names both SHAs", () => {
  const result = evaluateDispatch({
    eventName: "workflow_dispatch",
    checkoutSha: OLDER_SHA,
    mainHeadSha: MAIN_HEAD,
  });
  assert.equal(result.checked, true);
  assert.equal(result.matches, false);
  assert.ok(result.summary.includes(OLDER_SHA));
  assert.ok(result.summary.includes(MAIN_HEAD));
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
  assert.ok(written.startsWith("existing\n"));
  assert.ok(written.includes("Validated main SHA " + MAIN_HEAD + " (reason: " + RECOVERY_REASON + ").\n"));
  assert.equal(appendSummary(summary, ""), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the derived before-SHA is the newest successful push run on main", () => {
  const payload = {
    workflow_runs: [
      runRecord({ id: 5, head_sha: OLDEST_SHA, run_started_at: "2026-09-17T10:00:00Z" }),
      runRecord({ id: 9, head_sha: OLDER_SHA, run_started_at: "2026-09-19T10:00:00Z" }),
      runRecord({ id: 4, head_sha: OLDEST_SHA, run_started_at: "2026-09-16T10:00:00Z" }),
    ],
  };
  assert.equal(selectLastValidatedMainSha(payload), OLDER_SHA);
});

test("only a successful push run on main counts as a previous validation", () => {
  const payload = {
    workflow_runs: [
      runRecord({ id: 30, event: "workflow_dispatch", head_sha: MAIN_HEAD, run_started_at: "2026-09-21T10:00:00Z" }),
      runRecord({ id: 29, conclusion: "failure", head_sha: MAIN_HEAD, run_started_at: "2026-09-21T09:00:00Z" }),
      runRecord({ id: 28, conclusion: null, status: "in_progress", head_sha: MAIN_HEAD, run_started_at: "2026-09-21T08:00:00Z" }),
      runRecord({ id: 27, head_branch: "feat/other", head_sha: MAIN_HEAD, run_started_at: "2026-09-21T07:00:00Z" }),
      runRecord({ id: 9, head_sha: OLDER_SHA, run_started_at: "2026-09-19T10:00:00Z" }),
    ],
  };
  assert.equal(selectLastValidatedMainSha(payload), OLDER_SHA);
});

test("an empty or malformed run list fails closed, it never yields a before-SHA", () => {
  assert.throws(
    () => selectLastValidatedMainSha({ workflow_runs: [] }),
    /no previously validated main commit could be determined/,
  );
  assert.throws(
    () => selectLastValidatedMainSha({ workflow_runs: [runRecord({ conclusion: "failure" })] }),
    /no previously validated main commit could be determined/,
  );
  assert.throws(() => selectLastValidatedMainSha({}), /workflow_runs array/);
  assert.throws(() => selectLastValidatedMainSha(null), /workflow_runs array/);
  assert.throws(
    () => selectLastValidatedMainSha({ workflow_runs: [runRecord({ head_sha: "not-a-sha" })] }),
    /previously validated main HEAD/,
  );
});

test("the run lookup asks the API for successful main push runs of this workflow", async () => {
  const seen = {};
  const sha = await fetchLastValidatedMainSha({
    repository: "U2SG/startrips",
    apiUrl: "https://api.github.com/",
    token: "test-token",
    fetchImpl: stubFetch((url, init) => {
      seen.url = url;
      seen.authorization = init.headers.authorization;
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [runRecord({ head_sha: OLDER_SHA })] }) };
    }),
  });
  assert.equal(sha, OLDER_SHA);
  assert.equal(
    seen.url,
    "https://api.github.com/repos/U2SG/startrips/actions/workflows/" +
      WORKFLOW_FILE +
      "/runs?branch=main&event=push&status=success&per_page=100",
  );
  assert.equal(seen.authorization, "Bearer test-token");
});

test("an unavailable run lookup fails closed", async () => {
  await assert.rejects(
    fetchLastValidatedMainSha({
      repository: "U2SG/startrips",
      token: "test-token",
      fetchImpl: stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) })),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchLastValidatedMainSha({ repository: "U2SG/startrips", token: "" }),
    /GitHub token is required/,
  );
});

test("the derived before-SHA is written to the step output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-main-sha-output-"));
  const outputPath = path.join(dir, "output.txt");
  assert.equal(appendOutput("before-sha", OLDER_SHA, outputPath), true);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "before-sha=" + OLDER_SHA + "\n");
  assert.equal(appendOutput("before-sha", OLDER_SHA, ""), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("derive-before-sha exits non-zero when no previous validated main commit exists", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ workflow_runs: [] }));
  });
  server.unref();
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT_PATH, "derive-before-sha"],
        {
          env: {
            ...process.env,
            GITHUB_API_URL: "http://127.0.0.1:" + port,
            GITHUB_REPOSITORY: "U2SG/startrips",
            GITHUB_TOKEN: "test-token",
            GITHUB_OUTPUT: "",
            GITHUB_STEP_SUMMARY: "",
          },
        },
        (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
      );
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no previously validated main commit could be determined/);
    assert.equal(result.stdout.trim(), "");
  } finally {
    server.close();
  }
});
