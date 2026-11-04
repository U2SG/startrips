import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { browserMatrix, changedPaths, classifyPaths, WEB_SHARDS } from "./ci-ios-scope.mjs";
import { validateProductResults, validateResults } from "./ci-validation-results.mjs";
import { classifySourceCi } from "./ci-ledger-fast-path.mjs";

test("native design runs native only; docs allocate no macOS or browser runner", () => {
  for (const file of ["mobile/ios/Sources/App/AppRouter.swift", "mobile/ios/Scene/scene.css", "mobile/ios/Tests/AppTests.swift", "mobile/ios/Startrips.xcodeproj/project.pbxproj"]) {
    assert.deepEqual(classifyPaths([file]), { mode: "ios", native: true, web: false, shards: [] });
  }
  for (const file of ["docs/ios.md", "README.md", "mobile/ios/README.md"]) {
    assert.deepEqual(classifyPaths([file]), { mode: "docs", native: false, web: false, shards: [] });
  }
});

test("routing edits and unknown/shared runtime paths cannot waive existing Web protection", () => {
  for (const file of [".github/workflows/ci.yml", ".github/browser-matrix.json", "scripts/ci-ios-scope.mjs",
    "scripts/ci-validation-results.mjs", "src/scene/LivingAtlasGlobe.tsx", "server/routes/journeys.ts", "unknown-file"]) {
    const scope = classifyPaths(["mobile/ios/Scene/scene.css", file]);
    assert.equal(scope.web, true); assert.equal(scope.native, true);
    assert.deepEqual(scope.shards, WEB_SHARDS);
  }
  assert.deepEqual(classifyPaths(["src/journey/LivingAtlasApp.tsx"]).shards, WEB_SHARDS);
  for (const files of [null, []]) assert.deepEqual(classifyPaths(files).shards, WEB_SHARDS);
});

test("Web-only auth, previews and server tools do not allocate a native runner", () => {
  for (const file of ["src/auth/AuthGateway.tsx", "src/preview/index.ts", "server/admin/journal-import-cli.ts"]) {
    const scope = classifyPaths([file]);
    assert.equal(scope.native, false);
    assert.deepEqual(scope.shards, WEB_SHARDS);
  }
  const workflow = fs.readFileSync(".github/workflows/perf-bundle.yml", "utf8");
  assert.equal(workflow.split("\n").filter((line) => line.includes("paths-ignore:") && line.includes("'mobile/ios/**'")).length, 2);
});

test("narrow mapped mixed change runs affected actual matrix commands only", () => {
  const scope = classifyPaths(["mobile/ios/Scene/scene.css", "src/journey/JourneyTimeline.tsx", "docs/ios.md"]);
  assert.equal(scope.mode, "mixed"); assert.equal(scope.native, true);
  const selected = browserMatrix(scope).include;
  assert.deepEqual(selected.map((row) => row.name), ["shell-composer"]);
  assert.match(selected[0].commands, /entry-boundaries::pnpm qa:entry-boundaries/);
  const ordinary = browserMatrix(classifyPaths(["src/journey/JourneyTimeline.tsx"]));
  assert.equal(ordinary.include.length, 8);
  assert.equal(ordinary.include.flatMap((row) => row.commands.split("\n")).length, 43);
});

test("whole PR diff includes earlier shared commits and both rename paths; push uses entire range", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "CI Fixture"); git("config", "user.email", "fixture@example.invalid");
  const write = (name) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), name); };
  write("src/shared.ts"); git("add", "."); git("commit", "-qm", "base"); const baseSha = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "src/shared.ts"), "shared change"); git("add", "."); git("commit", "-qm", "shared");
  write("mobile/ios/Sources/App.swift"); git("add", "."); git("commit", "-qm", "native"); const headSha = git("rev-parse", "HEAD");
  const input = { eventName: "pull_request", baseSha, headSha, root };
  assert.deepEqual(changedPaths(input).sort(), ["mobile/ios/Sources/App.swift", "src/shared.ts"]);
  assert.equal(classifyPaths(changedPaths(input)).web, true);
  assert.deepEqual(changedPaths({ ...input, eventName: "push", beforeSha: baseSha }), changedPaths(input));
  git("mv", "src/shared.ts", "mobile/ios/shared.ts"); git("commit", "-qam", "move");
  assert.ok(changedPaths({ ...input, headSha: git("rev-parse", "HEAD") }).includes("src/shared.ts"));
  for (const eventName of ["workflow_dispatch", "unknown"]) assert.equal(changedPaths({ ...input, eventName }), null);
  assert.equal(changedPaths({ ...input, baseSha: "0".repeat(40) }), null);
});

const gate = { LEDGER_RESULT: "success", QUICK_CHECKS_RESULT: "success", SOURCE_PROOF_OUTCOME: "success",
  CLASSIFIED_LEDGER_ONLY: "false", PROVEN_LEDGER_ONLY: "false", CLASSIFIED_SOC_ONLY: "false", PROVEN_SOC_ONLY: "false",
  CLASSIFIED_SCOPE: "ios", PROVEN_SCOPE: "ios", CLASSIFIED_IOS: "true", PROVEN_IOS: "true", IOS_RESULT: "success",
  CORE_RESULT: "skipped", BROWSER_QA_RESULT: "skipped", KEEPSAKE_RENDER_RESULT: "skipped" };

test("required verify rejects skipped/cancelled native, unexpected runner work and divergent classifications", () => {
  assert.doesNotThrow(() => validateResults(gate));
  for (const key of ["IOS_RESULT", "QUICK_CHECKS_RESULT", "LEDGER_RESULT"]) {
    for (const value of ["cancelled", "skipped", "failure", undefined]) assert.throws(() => validateResults({ ...gate, [key]: value }));
  }
  for (const key of ["CORE_RESULT", "BROWSER_QA_RESULT", "KEEPSAKE_RENDER_RESULT"]) {
    for (const value of ["success", "failure", "cancelled", undefined]) assert.throws(() => validateResults({ ...gate, [key]: value }));
  }
  for (const change of [{ PROVEN_SCOPE: "docs" }, { CLASSIFIED_SCOPE: undefined }, { PROVEN_IOS: "false" }]) {
    assert.throws(() => validateResults({ ...gate, ...change }));
  }
  const docs = { ...gate, CLASSIFIED_SCOPE: "docs", PROVEN_SCOPE: "docs", CLASSIFIED_IOS: "false", PROVEN_IOS: "false", IOS_RESULT: "skipped" };
  assert.doesNotThrow(() => validateResults(docs));
  assert.throws(() => validateResults({ ...docs, IOS_RESULT: "success" }));
});

test("Source reuse proves native lane and expected skips; cancellation is never evidence", () => {
  const scope = classifyPaths(["mobile/ios/Sources/App.swift"]);
  const run = { status: "completed", conclusion: "failure", run_attempt: 1 };
  const jobs = ["ledger", "verify", "quick-checks", "core", "keepsake-render", "browser-qa / ${{ matrix.name }}", "ios-native"].map((name, id) => ({
    id, name, status: "completed", conclusion: ["ledger", "verify"].includes(name) ? "failure" : ["quick-checks", "ios-native"].includes(name) ? "success" : "skipped",
    steps: name === "ledger" ? [{ name: "Validate current PR ledger", conclusion: "failure" }]
      : name === "verify" ? [{ name: "Re-classify soc-client-only and prove reusable Source CI for a ledger-only final", status: "completed", conclusion: "success" },
        { name: "Validate product lanes / ios / native-true", status: "completed", conclusion: "success" },
        { name: "Require current ledger", status: "completed", conclusion: "failure" }] : [],
  }));
  assert.equal(classifySourceCi(run, jobs, scope).green, true);
  assert.equal(classifySourceCi(run, jobs.map((job) => job.name === "verify" ? { ...job, steps: [] } : job), scope).green, false);
  assert.equal(classifySourceCi(run, [...jobs, { ...jobs[0], name: "unclassified", id: 99, conclusion: "skipped" }], scope).green, false);
  assert.doesNotThrow(() => validateProductResults({ ...gate, LEDGER_RESULT: "failure" }));
  assert.throws(() => validateResults({ ...gate, LEDGER_RESULT: "failure" }));
  assert.throws(() => validateProductResults({ ...gate, CORE_RESULT: "success", LEDGER_RESULT: "failure" }));
  for (const conclusion of ["cancelled", "skipped", "failure"]) {
    assert.equal(classifySourceCi(run, jobs.map((job) => job.name === "ios-native" ? { ...job, conclusion } : job), scope).green, false);
  }
  assert.equal(classifySourceCi(run, jobs.filter((job) => job.name !== "ios-native"), scope).green, false);
});

test("workflow gates runner allocation, one simulator, required verify, normal push and cancellation", () => {
  const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const job = (name) => ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.match(ci, /push:\n    branches: \[main\]/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github.event_name != 'workflow_dispatch' \}\}/);
  for (const name of ["core", "browser-qa", "keepsake-render"]) {
    assert.match(job(name), /if: .*outputs\.web == 'true'/);
    assert.ok(job(name).indexOf("if:") < job(name).indexOf("runs-on:"));
  }
  assert.match(job("ios-native"), /if: .*ledger_only_final != 'true'.*soc_client_only != 'true'.*outputs\.ios == 'true'/);
  assert.match(job("ios-native"), /runs-on: macos-15/);
  assert.doesNotMatch(job("ios-native"), /continue-on-error|playwright|browser-qa/);
  assert.match(job("verify"), /- ios-native/);
  assert.match(job("verify"), /IOS_RESULT: \$\{\{ needs.ios-native.result \}\}/);
  assert.match(job("ledger"), /node scripts\/verify-main-sha.mjs/);
  const runner = fs.readFileSync(new URL("../mobile/ios/ci-test.sh", import.meta.url), "utf8");
  assert.match(runner, /xcodebuild test/);
  assert.match(runner, /-parallel-testing-enabled NO/);
  assert.doesNotMatch(runner, /\|\| true|-skip-testing/);
});
