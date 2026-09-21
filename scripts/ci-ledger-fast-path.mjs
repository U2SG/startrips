import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePrLedger } from "./pr-history.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FULL_BROWSER_MATRIX = {
  include: [
    { name: "earth", suites: "|earth-dive|", commands: "pnpm qa:earth-dive" },
    { name: "auth-media", suites: "|login-media|composer-playback-preview|", commands: "QA_CAPTURE_MEDIA_MOTION=1 pnpm qa:login-v3 && QA_CAPTURE_MEDIA_MOTION=1 pnpm qa:media-controls && QA_CAPTURE_MEDIA_MOTION=1 pnpm qa:media-reclassification\npnpm qa:composer-playback-preview" },
    { name: "labels-recovery", suites: "|city-label-anchoring|recovery-surfaces|", commands: "pnpm qa:city-label-anchoring\npnpm qa:recovery-surfaces" },
    { name: "reveal-share", suites: "|cover-reveal-opening|cover-reveal|owner-share|", commands: "pnpm qa:cover-reveal-opening\npnpm qa:cover-reveal\npnpm qa:owner-share" },
    { name: "playback-brand", suites: "|playback-prefetch|playback-continuity|final-acceptance|brand-signature-motion|", commands: "pnpm qa:playback-prefetch\npnpm qa:playback-continuity\npnpm qa:final-acceptance\npnpm qa:brand-signature-motion" },
    { name: "shell-composer", suites: "|post-login|mobile-contract|composer-route-points|composer-mobile-ia|", commands: "pnpm qa:post-login-controls\npnpm qa:mobile-contract\npnpm qa:composer-route-points\npnpm qa:composer-mobile-ia" },
    { name: "globe-context", suites: "|globe-focus-chrome|globe-render-budget|route-point-context|attention-hierarchy|", commands: "pnpm qa:globe-focus-chrome\npnpm qa:globe-render-budget\npnpm qa:route-point-context\npnpm qa:attention-hierarchy" },
    { name: "route-home-share", suites: "|route-anchoring|guest-share|home-base-suggestion|home-base-context|", commands: "pnpm qa:route-anchoring\npnpm qa:guest-share\npnpm qa:home-base-suggestion\npnpm qa:home-base-context" },
  ],
};

export const FAST_BROWSER_MATRIX = {
  include: [{ name: "source-reuse", suites: "|source-reuse|", commands: "true" }],
};

function fail(message) {
  throw new Error(message);
}

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function output(name, value) {
  const target = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (target) fs.appendFileSync(target, line, "utf8");
  else process.stdout.write(line);
}

export function classifyLedgerOnlyFinal({ eventName, prNumber, headSha, baseSha, root = ROOT }) {
  if (eventName !== "pull_request") {
    return { fastPath: false, sourceSha: null, reason: "not-pull-request" };
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { fastPath: false, sourceSha: null, reason: "missing-pr-number" };
  }
  const ledgerPath = path.join(root, "docs", "pr-history", `${prNumber}.md`);
  if (!fs.existsSync(ledgerPath)) {
    return { fastPath: false, sourceSha: null, reason: "ledger-absent" };
  }

  let entry;
  try {
    entry = validatePrLedger({ prNumber, headSha, baseSha, root });
  } catch (error) {
    return { fastPath: false, sourceSha: null, reason: `ledger-not-final: ${error instanceof Error ? error.message : String(error)}` };
  }

  let commitCount;
  try {
    commitCount = Number(git(["rev-list", "--count", `${entry.sourceHead}..${headSha}`], root));
  } catch {
    return { fastPath: false, sourceSha: null, reason: "cannot-count-final-commits" };
  }
  if (commitCount !== 1) {
    return { fastPath: false, sourceSha: null, reason: `final-commit-count-${commitCount}` };
  }

  // The reviewed Source itself must not already contain this PR's ledger.
  try {
    git(["cat-file", "-e", `${entry.sourceHead}:docs/pr-history/${prNumber}.md`], root);
    return { fastPath: false, sourceSha: null, reason: "ledger-already-present-in-source" };
  } catch {
    // Expected for a legal first/only ledger final.
  }

  return { fastPath: true, sourceSha: entry.sourceHead, reason: "single-ledger-only-final" };
}

export function classifySourceCi(run, jobs) {
  if (!run || run.status !== "completed" || !["success", "failure"].includes(run.conclusion)) {
    return { green: false, reason: "source-run-not-terminal" };
  }

  const latest = new Map();
  for (const job of jobs ?? []) {
    if (typeof job?.name !== "string" || !Number.isInteger(job?.id)) {
      return { green: false, reason: "source-job-identity-missing" };
    }
    const prior = latest.get(job.name);
    if (!prior || job.id > prior.id) latest.set(job.name, job);
  }
  const effective = [...latest.values()];
  const names = new Set(effective.map((job) => job.name));
  for (const required of ["ledger", "core", "verify", "keepsake-render"]) {
    if (!names.has(required)) return { green: false, reason: `source-job-missing-${required}` };
  }
  const browser = effective.filter((job) => job.name.startsWith("browser-qa / "));
  if (browser.length < 1) return { green: false, reason: "source-browser-jobs-missing" };
  if (effective.some((job) => job.status !== "completed")) {
    return { green: false, reason: "source-jobs-not-terminal" };
  }

  const ledger = effective.find((job) => job.name === "ledger");
  const ledgerFailedSteps = (ledger.steps ?? [])
    .filter((step) => step.conclusion === "failure")
    .map((step) => step.name);
  if (ledger.conclusion !== "failure"
      || ledgerFailedSteps.length !== 1
      || ledgerFailedSteps[0] !== "Validate current PR ledger") {
    return { green: false, reason: "source-ledger-failure-not-expected-pre-seal-gap" };
  }

  const verify = effective.find((job) => job.name === "verify");
  if (verify.conclusion !== "failure") {
    return { green: false, reason: "source-verify-not-expected-pre-seal-failure" };
  }

  const product = effective.filter((job) => !["ledger", "verify"].includes(job.name));
  const failedProduct = product.filter((job) => job.conclusion !== "success");
  if (failedProduct.length) {
    return { green: false, reason: `source-product-not-green:${failedProduct.map((job) => job.name).join(",")}` };
  }
  return { green: true, reason: "source-product-lanes-green" };
}

async function api(pathname, token) {
  const response = await fetch(`https://api.github.com/${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "startrips-ledger-fast-path",
    },
  });
  if (!response.ok) fail(`GitHub API ${pathname} -> ${response.status}`);
  return response.json();
}

async function proveSourceCi({ repo, sourceSha, branch, token }) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) fail("invalid Source SHA");
  if (!repo || !branch || !token) fail("source proof requires repo, branch and token");

  const query = new URLSearchParams({
    event: "pull_request",
    branch,
    head_sha: sourceSha,
    per_page: "100",
  });
  const data = await api(`repos/${repo}/actions/workflows/ci.yml/runs?${query}`, token);
  const runs = (data.workflow_runs ?? []).filter(
    (run) => run.head_sha === sourceSha && run.event === "pull_request" && run.head_branch === branch,
  );
  if (!runs.length) fail(`no pull_request CI run found for Source ${sourceSha}`);
  runs.sort((a, b) => (b.id - a.id) || (b.run_attempt - a.run_attempt));
  const run = runs[0];

  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`, token);
    const rows = batch.jobs ?? [];
    jobs.push(...rows.filter((job) => job.run_id === run.id && job.head_sha === sourceSha));
    if (rows.length < 100) break;
    if (page === 20) fail("source CI jobs pagination limit");
  }

  const fresh = await api(`repos/${repo}/actions/runs/${run.id}`, token);
  for (const key of ["id", "head_sha", "run_attempt", "status", "conclusion"]) {
    if (fresh[key] !== run[key]) fail("Source CI changed during proof");
  }

  const verdict = classifySourceCi(run, jobs);
  if (!verdict.green) fail(`Source CI is not reusable: ${verdict.reason}`);
  return { runId: run.id, attempt: run.run_attempt, url: run.html_url, verdict };
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const prNumber = Number(process.env.PR_NUMBER || 0);
  const headSha = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA || "";
  const baseSha = process.env.PR_BASE_SHA || "";
  const plan = classifyLedgerOnlyFinal({ eventName, prNumber, headSha, baseSha });
  output("ledger_only_final", plan.fastPath ? "true" : "false");
  output("source_sha", plan.sourceSha ?? "");
  output("reason", plan.reason.replace(/[\r\n]+/g, " "));
  output("browser_matrix", JSON.stringify(plan.fastPath ? FAST_BROWSER_MATRIX : FULL_BROWSER_MATRIX));

  if (!plan.fastPath) {
    console.log(`full CI: ${plan.reason}`);
    return;
  }

  const proof = await proveSourceCi({
    repo: process.env.GITHUB_REPOSITORY,
    sourceSha: plan.sourceSha,
    branch: process.env.PR_HEAD_REF,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(`ledger-only final reuses Source CI run ${proof.runId} attempt ${proof.attempt}: ${proof.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
