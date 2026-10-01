import { spawn } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const DEFAULT_SUITE_TIMEOUT_MS = 12 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

export function parseEntries(text) {
  const entries = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf("::");
    if (separator <= 0 || separator === line.length - 2) {
      throw new Error(`Invalid browser QA shard entry: ${line}`);
    }
    const suite = line.slice(0, separator).trim();
    const command = line.slice(separator + 2).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(suite) || !command) {
      throw new Error(`Invalid browser QA shard entry: ${line}`);
    }
    entries.push({ suite, command });
  }
  if (!entries.length) throw new Error("Browser QA shard has no logical suites");
  return entries;
}

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited between timeout and cleanup.
  }
}

export function runCommand(command, { timeoutMs = DEFAULT_SUITE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: process.env,
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let settled = false;
    let killTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => finish({ ok: false, timedOut, code: null, error }));
    child.once("close", (code, signal) => {
      finish({ ok: !timedOut && code === 0, timedOut, code, signal, error: null });
    });
  });
}

export async function runShard(entries, {
  execute = runCommand,
  timeoutMs = DEFAULT_SUITE_TIMEOUT_MS,
  log = console.log,
  error = console.error,
  now = () => performance.now(),
  record = () => {},
} = {}) {
  let failed = false;
  for (const { suite, command } of entries) {
    log(`STARTRIPS_QA_SUITE=${suite}`);
    log(`::group::${suite} :: ${command}`);
    const started = now();
    let result;
    try {
      result = await execute(command, { timeoutMs, suite });
    } catch (executionError) {
      result = { ok: false, timedOut: false, error: executionError };
    }
    if (!result?.ok) {
      failed = true;
      const detail = result?.timedOut
        ? `timed out after ${timeoutMs}ms`
        : `failed${Number.isInteger(result?.code) ? ` with exit code ${result.code}` : ""}`;
      error(`::error::Browser QA suite ${suite} ${detail}: ${command}`);
    }
    const timing = {
      suite,
      status: result?.ok ? "passed" : result?.timedOut ? "timed_out" : "failed",
      durationMs: Math.max(0, Math.round(now() - started)),
      timeoutMs,
    };
    log(`STARTRIPS_QA_RESULT=${JSON.stringify(timing)}`);
    try {
      await record(timing);
    } catch (recordError) {
      failed = true;
      error(`::error::Browser QA timing evidence failed for ${suite}: ${recordError.message}`);
    }
    log("::endgroup::");
  }
  return failed ? 1 : 0;
}

async function main() {
  const timeoutMs = Number(process.env.QA_SUITE_TIMEOUT_MS || DEFAULT_SUITE_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_SUITE_TIMEOUT_MS) {
    throw new Error(`QA_SUITE_TIMEOUT_MS must be > 0 and <= ${DEFAULT_SUITE_TIMEOUT_MS}`);
  }
  const entries = parseEntries(process.env.QA_COMMANDS);
  const target = process.env.QA_TIMINGS_PATH;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "", "utf8");
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, "\n### Browser QA suite timings\n\n| Suite | Result | Seconds |\n|---|---|---:|\n");
  process.exitCode = await runShard(entries, {
    timeoutMs,
    record: (timing) => {
      if (target) fs.appendFileSync(target, `${JSON.stringify(timing)}\n`);
      if (summary) fs.appendFileSync(summary, `| ${timing.suite} | ${timing.status} | ${(timing.durationMs / 1000).toFixed(2)} |\n`);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
