import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT_MS = 10000;

export const RECOVERY_REASON = "manual recovery for missing exact-main push run";

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

async function main() {
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
