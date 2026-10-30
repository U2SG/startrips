import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  classifyLedgerOnlyFinal, classifySocClientOnly, classifySocSourceRun, classifySourceCi, isSocClientOnlyChange, verifySocGate,
} from "./ci-ledger-fast-path.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function ledger(number, source) {
  return `# PR #${number} - Fast path fixture

- **Source head:** \`${source}\`
- **Scope:** Scope.
- **User-visible change:** None.
- **Review fixes:** None.
- **Follow-up:** None.
- **Validation:** CI.
`;
}

function fixture({ extraFinalCommit = false, drift = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-fast-path-"));
  fs.mkdirSync(path.join(dir, "docs", "pr-history"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fast-path@example.com");
  git(dir, "config", "user.name", "Fast Path");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "docs", "pr-history.md"), "# Legacy\n");
  fs.writeFileSync(path.join(dir, "app.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "app.txt"), "source\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "source");
  const sourceSha = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "docs", "pr-history", "477.md"), ledger(477, sourceSha));
  if (drift) fs.writeFileSync(path.join(dir, "app.txt"), "drift\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "ledger");
  if (extraFinalCommit) {
    fs.appendFileSync(path.join(dir, "docs", "pr-history", "477.md"), "\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "second ledger commit");
  }
  return { dir, baseSha, sourceSha, headSha: git(dir, "rev-parse", "HEAD") };
}

test("recognizes exactly one legal ledger-only final commit", () => {
  const f = fixture();
  assert.deepEqual(classifyLedgerOnlyFinal({
    eventName: "pull_request",
    prNumber: 477,
    headSha: f.headSha,
    baseSha: f.baseSha,
    root: f.dir,
  }), {
    fastPath: true,
    sourceSha: f.sourceSha,
    reason: "single-ledger-only-final",
  });
});

test("fails closed when code drifts after Source", () => {
  const f = fixture({ drift: true });
  const result = classifyLedgerOnlyFinal({
    eventName: "pull_request",
    prNumber: 477,
    headSha: f.headSha,
    baseSha: f.baseSha,
    root: f.dir,
  });
  assert.equal(result.fastPath, false);
  assert.match(result.reason, /ledger-not-final/);
});

test("fails closed when final uses more than one commit", () => {
  const f = fixture({ extraFinalCommit: true });
  const result = classifyLedgerOnlyFinal({
    eventName: "pull_request",
    prNumber: 477,
    headSha: f.headSha,
    baseSha: f.baseSha,
    root: f.dir,
  });
  assert.equal(result.fastPath, false);
  assert.equal(result.reason, "final-commit-count-2");
});

test("workflow keeps all 42 logical browser suites across at most eight shards", () => {
  const workflow = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const matrixStart = workflow.indexOf("      matrix:\n        include:");
  const stepsStart = workflow.indexOf("\n    steps:", matrixStart);
  assert.ok(matrixStart >= 0 && stepsStart > matrixStart);
  const matrixText = workflow.slice(matrixStart, stepsStart);
  const expectedSuites = new Set([
    "login-media", "post-login", "playback-prefetch", "playback-continuity", "playback-map-bridge", "final-acceptance",
    "route-anchoring", "city-label-anchoring", "earth-dive", "attention-hierarchy",
    "brand-signature-motion", "recovery-surfaces", "composer-route-points",
    "composer-playback-preview", "composer-mobile-ia", "mobile-contract", "story-presentation-navigation", "mobile-classic-views", "globe-focus-chrome",
    "route-point-context", "globe-render-budget", "recorded-track-lod", "guest-share", "home-base-suggestion",
    "home-base-context", "owner-share", "cover-reveal", "cover-reveal-opening", "entry-boundaries",
    "story-media-handoff", "playback-manual-camera", "media-motion-lab", "route-candidates",
    "soundtrack-ducking", "mobile-native", "story-note-beats",
    "journal-hotels",
    "journal-streaming",
    "journey-book-3d-turns", "journey-book-3d-drags", "journey-book-3d-last-spread", "journey-book-3d-phone",
  ]);
  const shardNames = [...matrixText.matchAll(/^          - name: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.ok(shardNames.length <= 8);
  assert.equal(new Set(shardNames).size, shardNames.length);
  const suites = new Set();
  for (const match of matrixText.matchAll(/^            suites: "([^"]+)"$/gm)) {
    for (const suite of match[1].split("|").filter(Boolean)) suites.add(suite);
  }
  assert.deepEqual(suites, expectedSuites);
  assert.equal((matrixText.match(/pnpm qa:[a-z0-9-]+/g) ?? []).length, 44);
  assert.equal((matrixText.match(/^\s+[a-z0-9][a-z0-9-]*::.+$/gm) ?? []).length, 42);
});

function jobs({ productFailure = false, wrongLedgerFailure = false } = {}) {
  const success = (id, name) => ({ id, name, status: "completed", conclusion: "success", steps: [] });
  return [
    {
      id: 1,
      name: "ledger",
      status: "completed",
      conclusion: "failure",
      steps: [{ name: wrongLedgerFailure ? "Validate sharded ledgers" : "Validate current PR ledger", conclusion: "failure" }],
    },
    success(2, "ci-plan"),
    success(3, "core"),
    success(4, "keepsake-render"),
    success(5, "browser-qa / earth"),
    { ...success(6, "browser-qa / auth-media"), conclusion: productFailure ? "failure" : "success" },
    { id: 7, name: "verify", status: "completed", conclusion: "failure", steps: [] },
  ];
}

const run = { status: "completed", conclusion: "failure" };

test("accepts a Source run whose only failures are expected pre-seal ledger and verify", () => {
  assert.deepEqual(classifySourceCi(run, jobs()), {
    green: true,
    reason: "source-product-lanes-green",
  });
});

test("rejects Source reuse when a product shard failed", () => {
  const result = classifySourceCi(run, jobs({ productFailure: true }));
  assert.equal(result.green, false);
  assert.match(result.reason, /source-product-not-green/);
});

test("rejects Source reuse when ledger failed for a reason other than missing final ledger", () => {
  const result = classifySourceCi(run, jobs({ wrongLedgerFailure: true }));
  assert.equal(result.green, false);
  assert.equal(result.reason, "source-ledger-failure-not-expected-pre-seal-gap");
});

// Mirrors Source run 37169686820: attempt 1 was cancelled before the browser-qa
// matrix expanded; attempt 2 re-ran every job and expanded the real lanes.
function rerunJobs({ placeholderAttempt = 1, lanesAttempt = 2, laneConclusion = "success" } = {}) {
  const job = (id, attempt, name, conclusion, steps = []) => (
    { id, run_attempt: attempt, name, status: "completed", conclusion, steps }
  );
  return [
    job(11, 1, "quick-checks", "cancelled"),
    job(12, 1, "ledger", "cancelled"),
    job(13, 1, "verify", "failure"),
    job(14, 1, "core", "cancelled"),
    job(15, 1, "keepsake-render", "cancelled"),
    job(16, placeholderAttempt, "browser-qa / ${{ matrix.name }}", "cancelled"),
    job(21, 2, "ledger", "failure", [{ name: "Validate current PR ledger", conclusion: "failure" }]),
    job(22, 2, "quick-checks", "success"),
    job(23, 2, "core", "success"),
    job(24, 2, "keepsake-render", "success"),
    job(25, lanesAttempt, "browser-qa / route-home-share", laneConclusion),
    job(26, 2, "browser-qa / story-media", "success"),
    job(27, 2, "verify", "failure"),
  ];
}

const rerun = { status: "completed", conclusion: "failure", run_attempt: 2 };

test("ignores an unexpanded matrix placeholder superseded by a later attempt", () => {
  assert.deepEqual(classifySourceCi(rerun, rerunJobs()), {
    green: true,
    reason: "source-product-lanes-green",
  });
});

test("rejects an unexpanded matrix placeholder in the latest attempt", () => {
  const result = classifySourceCi(rerun, rerunJobs({ placeholderAttempt: 2 }));
  assert.equal(result.green, false);
  assert.equal(result.reason, "source-product-not-green:browser-qa / ${{ matrix.name }}");
});

test("rejects a placeholder when no later attempt expanded the matrix", () => {
  const result = classifySourceCi(rerun, rerunJobs({ lanesAttempt: 1 }).filter(
    (job) => job.name !== "browser-qa / story-media",
  ));
  assert.equal(result.green, false);
  assert.match(result.reason, /browser-qa \/ \$\{\{ matrix\.name \}\}/);
});

test("rejects a cancelled real lane with no later success", () => {
  const result = classifySourceCi(rerun, rerunJobs({ laneConclusion: "cancelled" }));
  assert.equal(result.green, false);
  assert.equal(result.reason, "source-product-not-green:browser-qa / route-home-share");
});

test("soc-client-only accepts pure soc client paths plus this PR's own ledger", () => {
  assert.equal(isSocClientOnlyChange([
    "mobile/soc/src/App.tsx", "scripts/qa-soc-web.mjs", "scripts/qa-soc-android.py",
    ".github/workflows/soc.yml", "docs/soc.md", "docs/pr-history/740.md",
  ], 740), true);
});

test("soc-client-only rejects server, root, mixed, foreign-ledger and ledger-only changes", () => {
  for (const files of [
    ["mobile/soc/src/App.tsx", "server/app.ts"],
    ["mobile/soc/src/App.tsx", "server/routes/soc.ts"],
    ["mobile/soc/package.json", "package.json"],
    ["mobile/soc/src/App.tsx", "pnpm-lock.yaml"],
    ["mobile/soc/src/App.tsx", ".github/workflows/ci.yml"],
    ["mobile/soc/src/App.tsx", "deploy/Caddyfile"],
    ["scripts/qa-soc/x.mjs"], ["scripts/qa-soc-x.sh"],
    ["mobile/soc/src/App.tsx", "docs/pr-history/739.md"],
    ["docs/pr-history/740.md"], [],
  ]) assert.equal(isSocClientOnlyChange(files, 740), false, files.join(","));
});

function socFixture(move) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-soc-only-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fast-path@example.com");
  git(dir, "config", "user.name", "Fast Path");
  fs.mkdirSync(path.join(dir, "server"));
  fs.mkdirSync(path.join(dir, "mobile", "soc"), { recursive: true });
  fs.writeFileSync(path.join(dir, "server", "soc.ts"), "export const shared = 'server login process';\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");
  if (move) git(dir, "mv", "server/soc.ts", "mobile/soc/soc.ts");
  else fs.writeFileSync(path.join(dir, "mobile", "soc", "App.tsx"), "export default null;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "change");
  return { eventName: "pull_request", prNumber: 740, baseSha, headSha: git(dir, "rev-parse", "HEAD"), root: dir };
}

test("soc-client-only classifies the PR diff and fails closed on renames out of server/ and non-PR events", () => {
  const pure = socFixture(false);
  assert.equal(classifySocClientOnly(pure), true);
  assert.equal(classifySocClientOnly({ ...pure, eventName: "push" }), false);
  assert.equal(classifySocClientOnly({ ...pure, baseSha: "0".repeat(40) }), false);
  assert.equal(classifySocClientOnly(socFixture(true)), false);
});

test("soc Source reuse requires a green run with green web, android and ios lanes", () => {
  const lane = (id, name, conclusion = "success") => ({ id, name, status: "completed", conclusion });
  const green = { status: "completed", conclusion: "success" };
  const lanes = [lane(1, "soc-plan"), lane(2, "web"), lane(3, "android"), lane(4, "ios"), lane(5, "live", "skipped")];
  assert.deepEqual(classifySocSourceRun(green, lanes), { green: true, reason: "source-soc-lanes-green" });
  assert.equal(classifySocSourceRun({ ...green, conclusion: "failure" }, lanes).green, false);
  assert.equal(classifySocSourceRun({ status: "in_progress", conclusion: null }, lanes).green, false);
  for (const conclusion of ["skipped", "cancelled", "failure"]) {
    assert.equal(classifySocSourceRun(green, [...lanes, lane(9, "android", conclusion)]).reason, "source-soc-android-not-green");
  }
  assert.equal(classifySocSourceRun(green, lanes.filter((job) => job.name !== "ios")).reason, "source-soc-ios-not-green");
});


function socGate({ runs, ledgerFinal = false, proveSource = async () => {} }) {
  let clock = 0;
  return verifySocGate({
    socOnly: true, ledgerFinal, proveSource, now: () => clock, sleep: async (ms) => { clock += ms; },
    findHeadRun: async () => runs.length > 1 ? runs.shift() : runs[0],
  });
}
const socLane = (id, name, conclusion = "success") => ({ id, name, status: "completed", conclusion });
const socLanes = (conclusion) => [socLane(1, "web", conclusion), socLane(2, "android", conclusion), socLane(3, "ios", conclusion)];
const socDone = (conclusion, lanes = socLanes()) => ({ run: { id: 7, status: "completed", conclusion }, jobs: lanes });

test("soc gate waits for and passes on a green soc run for the head", async () => {
  const pending = { run: { id: 7, status: "in_progress", conclusion: null }, jobs: [] };
  assert.match(await socGate({ runs: [null, pending, socDone("success")] }), /android and ios green/);
});

test("soc gate fails closed on red, cancelled, missing, timed-out or unproved reuse", async () => {
  await assert.rejects(socGate({ runs: [socDone("failure")] }), /concluded failure/);
  await assert.rejects(socGate({ runs: [socDone("cancelled")] }), /concluded cancelled/);
  await assert.rejects(socGate({ runs: [null] }), /no soc.yml run/);
  await assert.rejects(socGate({ runs: [{ run: { id: 7, status: "queued" }, jobs: [] }] }), /timed out/);
  await assert.rejects(socGate({ runs: [socDone("success", socLanes("skipped"))] }), /did not run/);
  await assert.rejects(socGate({ runs: [socDone("success", socLanes("skipped"))], ledgerFinal: true,
    proveSource: async () => { throw new Error("Source CI is not reusable"); } }), /not reusable/);
});

test("soc gate accepts reuse on a ledger final only with a proved Source soc run", async () => {
  let proved = false;
  const result = await socGate({ runs: [socDone("success", socLanes("skipped"))], ledgerFinal: true,
    proveSource: async () => { proved = true; } });
  assert.ok(proved);
  assert.match(result, /reused the proved Source/);
});

test("non-soc PRs have no soc requirement and never poll", async () => {
  const never = async () => { throw new Error("must not be called"); };
  assert.equal(await verifySocGate({ socOnly: false, findHeadRun: never, proveSource: never, sleep: never }), "soc gate not required");
});
