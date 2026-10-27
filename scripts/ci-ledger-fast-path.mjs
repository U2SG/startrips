import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePrLedger } from "./pr-history.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// Soc client paths are built and tested only by soc.yml; server/ shares the login process.
const SOC_CLIENT_PATHS = [/^mobile\/soc\//, /^scripts\/qa-soc-[^/]+\.(mjs|py)$/, /^\.github\/workflows\/soc\.yml$/, /^docs\/soc\.md$/];

export function isSocClientOnlyChange(files, prNumber) {
  const ledger = `docs/pr-history/${prNumber}.md`;
  const product = files.filter((file) => file !== ledger);
  return product.length > 0 && product.every((file) => SOC_CLIENT_PATHS.some((pattern) => pattern.test(file)));
}

export function classifySocClientOnly({ eventName, prNumber, headSha, baseSha, root = ROOT }) {
  if (eventName !== "pull_request" || !Number.isInteger(prNumber) || prNumber <= 0) return false;
  if (![headSha, baseSha].every((sha) => /^[0-9a-f]{40}$/i.test(sha))) return false;
  try {
    const prBase = git(["merge-base", baseSha, headSha], root);
    const files = git(["diff", "--no-renames", "--name-only", `${prBase}..${headSha}`], root)
      .split(/\r?\n/).filter(Boolean).map((value) => value.replace(/\\/g, "/"));
    return isSocClientOnlyChange(files, prNumber);
  } catch {
    return false;
  }
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

// A matrix job cancelled before expansion keeps its literal `${{ matrix.* }}` name.
// It is superseded only when a later attempt of the same run expanded that matrix.
function isSupersededMatrixPlaceholder(job, jobs, run) {
  const marker = job.name.indexOf("${{");
  if (marker < 0) return false;
  const prefix = job.name.slice(0, marker);
  if (!prefix.endsWith(" / ")) return false;
  if (!Number.isInteger(job.run_attempt) || !Number.isInteger(run.run_attempt)) return false;
  if (job.run_attempt >= run.run_attempt) return false;
  return jobs.some((other) => typeof other?.name === "string"
    && other.name.startsWith(prefix)
    && !other.name.includes("${{")
    && Number.isInteger(other.run_attempt)
    && other.run_attempt > job.run_attempt);
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
    if (isSupersededMatrixPlaceholder(job, jobs, run)) continue;
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

// soc.yml has no expected pre-seal failures: the whole run and each rebuilt lane must be green.
export function classifySocSourceRun(run, jobs) {
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    return { green: false, reason: "source-soc-run-not-green" };
  }
  for (const name of ["web", "android", "ios"]) {
    const latest = (jobs ?? []).filter((job) => job?.name === name).sort((a, b) => b.id - a.id)[0];
    if (latest?.status !== "completed" || latest.conclusion !== "success") {
      return { green: false, reason: `source-soc-${name}-not-green` };
    }
  }
  return { green: true, reason: "source-soc-lanes-green" };
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

async function latestRun({ repo, sha, branch, token, workflow }) {
  const query = new URLSearchParams({ event: "pull_request", branch, head_sha: sha, per_page: "100" });
  const data = await api(`repos/${repo}/actions/workflows/${workflow}/runs?${query}`, token);
  const runs = (data.workflow_runs ?? []).filter(
    (run) => run.head_sha === sha && run.event === "pull_request" && run.head_branch === branch,
  );
  runs.sort((a, b) => (b.id - a.id) || (b.run_attempt - a.run_attempt));
  return runs[0] ?? null;
}

async function runJobs({ repo, token, run }) {
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`, token);
    const rows = batch.jobs ?? [];
    jobs.push(...rows.filter((job) => job.run_id === run.id && job.head_sha === run.head_sha));
    if (rows.length < 100) break;
    if (page === 20) fail("source CI jobs pagination limit");
  }
  return jobs;
}

// Soc-only PRs skip the web lanes, so verify waits for soc.yml on this exact head instead.
export async function verifySocGate({
  socOnly, ledgerFinal, findHeadRun, proveSource, sleep, now = Date.now, timeoutMs = 80 * 60_000, graceMs = 5 * 60_000,
}) {
  if (!socOnly) return "soc gate not required";
  const start = now();
  for (;;) {
    const found = await findHeadRun();
    if (found?.run.status === "completed") {
      const { run, jobs } = found;
      if (run.conclusion !== "success") fail(`soc run ${run.id} concluded ${run.conclusion}`);
      if (classifySocSourceRun(run, jobs).green) return `soc run ${run.id}: web, android and ios green`;
      if (!ledgerFinal) fail(`soc run ${run.id} did not run web, android and ios green`);
      await proveSource();
      return `soc run ${run.id} reused the proved Source soc run`;
    }
    const waited = now() - start;
    if (!found && waited >= graceMs) fail("no soc.yml run exists for this head");
    if (waited >= timeoutMs) fail("timed out waiting for soc.yml on this head");
    await sleep(60_000);
  }
}

async function proveSourceCi({ repo, sourceSha, branch, token, workflow = "ci.yml", classify = classifySourceCi }) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) fail("invalid Source SHA");
  if (!repo || !branch || !token) fail("source proof requires repo, branch and token");

  const run = await latestRun({ repo, sha: sourceSha, branch, token, workflow });
  if (!run) fail(`no pull_request ${workflow} run found for Source ${sourceSha}`);
  const jobs = await runJobs({ repo, token, run });

  const fresh = await api(`repos/${repo}/actions/runs/${run.id}`, token);
  for (const key of ["id", "head_sha", "run_attempt", "status", "conclusion"]) {
    if (fresh[key] !== run[key]) fail("Source CI changed during proof");
  }

  const verdict = classify(run, jobs);
  if (!verdict.green) fail(`Source CI is not reusable: ${verdict.reason}`);
  return { runId: run.id, attempt: run.run_attempt, url: run.html_url, verdict };
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const prNumber = Number(process.env.PR_NUMBER || 0);
  const headSha = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA || "";
  const baseSha = process.env.PR_BASE_SHA || "";
  const { GITHUB_REPOSITORY: repo, PR_HEAD_REF: branch, GITHUB_TOKEN: token } = process.env;
  const source = { repo, branch, token };

  if (process.env.SOURCE_WORKFLOW === "soc.yml") {
    // Fail closed by rebuilding: anything short of proof runs the full soc lanes.
    const plan = classifyLedgerOnlyFinal({ eventName, prNumber, headSha, baseSha });
    let reuse = false;
    if (plan.fastPath) {
      try {
        const proof = await proveSourceCi({ ...source, sourceSha: plan.sourceSha, workflow: "soc.yml", classify: classifySocSourceRun });
        reuse = true;
        console.log(`ledger-only final reuses Source soc run ${proof.runId} attempt ${proof.attempt}: ${proof.url}`);
      } catch (error) {
        console.log(`full soc: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log(`full soc: ${plan.reason}`);
    }
    output("reuse_source", reuse ? "true" : "false");
    return;
  }

  // Soc-client-only is gated on soc.yml for this head, not on reusing a ci.yml Source run.
  const socOnly = classifySocClientOnly({ eventName, prNumber, headSha, baseSha });
  output("soc_client_only", socOnly ? "true" : "false");
  const plan = socOnly
    ? { fastPath: false, sourceSha: null, reason: "soc-client-only" }
    : classifyLedgerOnlyFinal({ eventName, prNumber, headSha, baseSha });
  output("ledger_only_final", plan.fastPath ? "true" : "false");
  output("source_sha", plan.sourceSha ?? "");
  output("reason", plan.reason.replace(/[\r\n]+/g, " "));

  if (socOnly && process.env.CLASSIFY_ONLY !== "1") {
    if (!source.repo || !source.branch || !source.token) fail("soc gate requires repo, branch and token");
    const ledger = classifyLedgerOnlyFinal({ eventName, prNumber, headSha, baseSha });
    console.log(await verifySocGate({
      socOnly,
      ledgerFinal: ledger.fastPath,
      findHeadRun: async () => {
        const run = await latestRun({ ...source, sha: headSha, workflow: "soc.yml" });
        return run && { run, jobs: run.status === "completed" ? await runJobs({ ...source, run }) : [] };
      },
      proveSource: () => proveSourceCi({ ...source, sourceSha: ledger.sourceSha, workflow: "soc.yml", classify: classifySocSourceRun }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }));
  }
  if (!plan.fastPath) {
    console.log(`full CI: ${plan.reason}`);
    return;
  }
  if (process.env.CLASSIFY_ONLY === "1") {
    console.log(`ledger-only final classification: Source ${plan.sourceSha}`);
    return;
  }

  const proof = await proveSourceCi({ ...source, sourceSha: plan.sourceSha });
  console.log(`ledger-only final reuses Source CI run ${proof.runId} attempt ${proof.attempt}: ${proof.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
