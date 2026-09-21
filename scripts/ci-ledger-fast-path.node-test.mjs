import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { classifyLedgerOnlyFinal, classifySourceCi } from "./ci-ledger-fast-path.mjs";

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

test("workflow keeps all 24 logical browser suites across exactly 8 shards", () => {
  const workflow = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const matrixStart = workflow.indexOf("      matrix:\n        include:");
  const stepsStart = workflow.indexOf("\n    steps:", matrixStart);
  assert.ok(matrixStart >= 0 && stepsStart > matrixStart);
  const matrixText = workflow.slice(matrixStart, stepsStart);
  const expectedSuites = new Set([
    "login-media", "post-login", "playback-prefetch", "playback-continuity", "final-acceptance",
    "route-anchoring", "city-label-anchoring", "earth-dive", "attention-hierarchy",
    "brand-signature-motion", "recovery-surfaces", "composer-route-points",
    "composer-playback-preview", "composer-mobile-ia", "mobile-contract", "globe-focus-chrome",
    "route-point-context", "globe-render-budget", "guest-share", "home-base-suggestion",
    "home-base-context", "owner-share", "cover-reveal", "cover-reveal-opening",
  ]);
  const shardNames = [...matrixText.matchAll(/^          - name: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.equal(shardNames.length, 8);
  const suites = new Set();
  for (const match of matrixText.matchAll(/^            suites: "([^"]+)"$/gm)) {
    for (const suite of match[1].split("|").filter(Boolean)) suites.add(suite);
  }
  assert.deepEqual(suites, expectedSuites);
  assert.equal((matrixText.match(/pnpm qa:[a-z0-9-]+/g) ?? []).length, 26);
  assert.equal((matrixText.match(/^\s+[a-z0-9][a-z0-9-]*::.+$/gm) ?? []).length, 24);
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
