import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT_MS = 10000;

export const RECOVERY_REASON = "manual recovery for missing exact-main push run";
export const WORKFLOW_FILE = "ci.yml";

function fail(message) {
  throw new Error(message);
}

export function normalizeSha(value, label) {
  if (typeof value !== "string") fail(label + " must be a 40-character commit SHA");
  const text = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(text)) fail(label + " must be a 40-character commit SHA, got '" + value + "'");
  return text;
}

export function extractMainHeadSha(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("main ref lookup must return a single ref object");
  }
  if (payload.ref !== "refs/heads/main") {
    fail("main ref lookup returned '" + payload.ref + "' instead of refs/heads/main");
  }
  if (!payload.object || typeof payload.object !== "object" || Array.isArray(payload.object)) {
    fail("main ref lookup returned no ref object");
  }
  return normalizeSha(payload.object.sha, "live main HEAD");
}

export function evaluateDispatch({ eventName, checkoutSha, mainHeadSha }) {
  if (eventName !== "workflow_dispatch") {
    return { checked: false, matches: true, summary: null };
  }
  const checkout = normalizeSha(checkoutSha, "checked-out SHA");
  const head = normalizeSha(mainHeadSha, "live main HEAD");
  const matches = checkout === head;
  return {
    checked: true,
    matches,
    checkoutSha: checkout,
    mainHeadSha: head,
    summary: matches
      ? "Validated main SHA " + checkout + " (reason: " + RECOVERY_REASON + ")."
      : "Rejected manual CI recovery: checked-out SHA " +
        checkout +
        " is not the live refs/heads/main HEAD " +
        head +
        " (reason: " +
        RECOVERY_REASON +
        ").",
  };
}

export async function fetchMainHeadSha({
  repository,
  apiUrl = "https://api.github.com",
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    fail("GITHUB_REPOSITORY must look like owner/repo, got '" + repository + "'");
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    fail("a GitHub token is required to read the live refs/heads/main HEAD");
  }
  const url = apiUrl.replace(/\/+$/, "") + "/repos/" + repository + "/git/ref/heads/main";
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "user-agent": "startrips-verify-main-sha",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    fail("main ref lookup failed with HTTP " + response.status);
  }
  return extractMainHeadSha(await response.json());
}

export function selectLastValidatedMainSha(payload, { workflowFile = WORKFLOW_FILE } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.workflow_runs)) {
    fail("workflow run lookup must return a workflow_runs array");
  }
  const validated = payload.workflow_runs.filter(
    (run) =>
      run &&
      typeof run === "object" &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.conclusion === "success",
  );
  if (validated.length === 0) {
    fail(
      "no previously validated main commit could be determined: " +
        workflowFile +
        " has no successful push run on main (reason: " +
        RECOVERY_REASON +
        ")",
    );
  }
  const newest = validated.slice().sort(byRecencyDescending)[0];
  return normalizeSha(newest.head_sha, "previously validated main HEAD");
}

function byRecencyDescending(left, right) {
  const delta = runStartedAt(right) - runStartedAt(left);
  if (delta !== 0) return delta;
  return runId(right) - runId(left);
}

function runStartedAt(run) {
  const parsed = Date.parse(run.run_started_at || run.created_at || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function runId(run) {
  return Number.isFinite(run.id) ? run.id : 0;
}

export async function fetchLastValidatedMainSha({
  repository,
  apiUrl = "https://api.github.com",
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workflowFile = WORKFLOW_FILE,
}) {
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    fail("GITHUB_REPOSITORY must look like owner/repo, got '" + repository + "'");
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    fail("a GitHub token is required to read the last validated main push run");
  }
  const url =
    apiUrl.replace(/\/+$/, "") +
    "/repos/" +
    repository +
    "/actions/workflows/" +
    encodeURIComponent(workflowFile) +
    "/runs?branch=main&event=push&status=success&per_page=100";
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "user-agent": "startrips-verify-main-sha",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    fail("last validated main push run lookup failed with HTTP " + response.status);
  }
  return selectLastValidatedMainSha(await response.json(), { workflowFile });
}

export function appendOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return false;
  fs.appendFileSync(outputPath, name + "=" + value + "\n", "utf8");
  return true;
}

export function appendSummary(line, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return false;
  fs.appendFileSync(summaryPath, line + "\n", "utf8");
  return true;
}

function checkedOutSha(root = ROOT) {
  return normalizeSha(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
    "checked-out SHA",
  );
}

async function verifyMainHead() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== "workflow_dispatch") {
    console.log("event is '" + eventName + "'; the exact-main dispatch guard only applies to workflow_dispatch");
    return;
  }

  const checkout = checkedOutSha();
  const reportedSha = process.env.GITHUB_SHA;
  if (reportedSha && normalizeSha(reportedSha, "GITHUB_SHA") !== checkout) {
    fail("checkout " + checkout + " does not match the dispatched GITHUB_SHA " + normalizeSha(reportedSha, "GITHUB_SHA"));
  }

  const mainHeadSha = await fetchMainHeadSha({
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    token: process.env.GITHUB_TOKEN,
  });

  const result = evaluateDispatch({ eventName, checkoutSha: checkout, mainHeadSha });
  appendSummary(result.summary);
  if (!result.matches) fail(result.summary);
  console.log(result.summary);
}

async function deriveBeforeSha() {
  const afterSha = checkedOutSha();
  const beforeSha = await fetchLastValidatedMainSha({
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    token: process.env.GITHUB_TOKEN,
  });
  const line =
    "Derived previously validated main commit " +
    beforeSha +
    "; ledger immutability range " +
    beforeSha +
    ".." +
    afterSha +
    " (reason: " +
    RECOVERY_REASON +
    ").";
  appendSummary(line);
  appendOutput("before-sha", beforeSha);
  console.log(line);
}

async function main(command = process.argv[2] || "verify-main-head") {
  if (command === "verify-main-head") return verifyMainHead();
  if (command === "derive-before-sha") return deriveBeforeSha();
  fail("usage: node scripts/verify-main-sha.mjs <verify-main-head|derive-before-sha>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
