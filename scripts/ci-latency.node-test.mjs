import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ci = read(".github/workflows/ci.yml");
const reproduction = read(".github/workflows/story-autoplay-reproduction.yml");
const job = (name) => ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];

test("all 31 suite commands are retained exactly once across the same ten shards", () => {
  const browser = job("browser-qa");
  const matrix = browser.slice(browser.indexOf("      matrix:"), browser.indexOf("\n    steps:"));
  const names = [...matrix.matchAll(/^          - name: (.+)$/gm)].map((m) => m[1]);
  assert.equal(names.length, 10);
  assert.equal(new Set(names).size, 10);
  const rows = [...matrix.matchAll(/^              ([a-z0-9-]+)::(.+)$/gm)];
  assert.equal(rows.length, 31);
  assert.equal(new Set(rows.map((m) => m[1])).size, 31);
  for (const [, suite, command] of rows) {
    const expected = suite === "login-media"
      ? "QA_CAPTURE_MEDIA_MOTION=1 pnpm qa:login-v3 && QA_CAPTURE_MEDIA_MOTION=1 pnpm qa:media-controls && QA_CAPTURE_MEDIA_MOTION=1 pnpm qa:media-reclassification"
      : `pnpm qa:${suite === "post-login" ? "post-login-controls" : suite}`;
    assert.equal(command, expected, suite);
  }
  for (const block of matrix.split("          - name: ").slice(1)) {
    const declared = block.match(/suites: "([^"]+)"/)[1].split("|").filter(Boolean).sort();
    const executed = [...block.matchAll(/^              ([a-z0-9-]+)::/gm)].map((m) => m[1]).sort();
    assert.deepEqual(declared, executed);
  }
  assert.match(browser, /fail-fast: false/);
  assert.match(browser, /QA_SUITE_TIMEOUT_MS: '720000'/);
});

test("hosted Chrome is reused without per-run Chromium or OS dependency installation", () => {
  const version = JSON.parse(read("package.json")).devDependencies["playwright-core"];
  for (const workflow of [job("browser-qa"), reproduction]) {
    assert.match(workflow, /runs-on: ubuntu-24.04/);
    assert.ok(workflow.includes(`QA_PLAYWRIGHT_VERSION: '${version}'`));
    assert.doesNotMatch(workflow, /container:/);
    assert.match(workflow, /run: pnpm exec playwright-core install ffmpeg/);
    assert.doesNotMatch(workflow, /install --with-deps chromium/);
    assert.match(workflow, /timeout-minutes: 1\n        run: node scripts\/ci-browser-runtime.mjs/);
  }
});

test("fast feedback runs once and final classification precedes expensive provisioning", () => {
  assert.equal((ci.match(/run: pnpm typecheck/g) || []).length, 1);
  assert.match(job("quick-checks"), /CLASSIFY_ONLY: '1'/);
  assert.match(job("quick-checks"), /run: pnpm typecheck/);
  for (const name of ["core", "browser-qa", "keepsake-render"]) {
    const block = job(name);
    assert.match(block, /needs: quick-checks\n    if: needs.quick-checks.outputs.ledger_only_final != 'true'/);
    assert.doesNotMatch(block, /needs: ledger/);
    assert.doesNotMatch(block, /Classify ledger-only final/);
  }
  const verify = job("verify");
  assert.match(verify, /if: \$\{\{ always\(\) \}\}/);
  assert.match(verify, /id: source-proof/);
  assert.doesNotMatch(verify, /CLASSIFY_ONLY/);
  assert.match(verify, /SOURCE_PROOF_OUTCOME: \$\{\{ steps.source-proof.outcome \}\}/);
  assert.match(verify, /run: node scripts\/ci-validation-results.mjs/);
});

test("production baseline and candidate retain the same current harness and bounded FFmpeg setup", () => {
  assert.match(reproduction, /mode: \[baseline, candidate\]/);
  for (const [file, temporary] of [["ci-browser-runtime.mjs", "r3-runtime.mjs"], ["ci-ensure-ffmpeg.sh", "r3-ffmpeg.sh"]]) {
    assert.ok(reproduction.includes(`cp scripts/${file} "$RUNNER_TEMP/${temporary}"`));
    assert.ok(reproduction.includes(`cp "$RUNNER_TEMP/${temporary}" scripts/${file}`));
  }
  for (const workflow of [job("keepsake-render"), reproduction]) {
    assert.match(workflow, /timeout-minutes: 3\n        run: bash scripts\/ci-ensure-ffmpeg.sh/);
  }
  const setup = read("scripts/ci-ensure-ffmpeg.sh");
  assert.match(setup, /timeout --kill-after=5s 60s/);
  assert.match(setup, /timeout --kill-after=5s 90s/);
  assert.match(setup, /Acquire::http::Timeout=20/);
});
