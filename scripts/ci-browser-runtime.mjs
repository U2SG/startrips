import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function assertRuntimeVersion(expected, installed, declared) {
  if (!/^\d+\.\d+\.\d+$/.test(expected || "") || installed !== expected || declared !== expected) {
    throw new Error(`CI Playwright package mismatch: expected=${expected}, installed=${installed}, declared=${declared}`);
  }
}

export function selectHostedBrowser(override, exists = fs.existsSync) {
  const candidates = [override, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
  const executable = candidates.find((candidate) => exists(candidate));
  if (!executable) throw new Error("Hosted Chrome is missing; update the CI runner image rather than silently changing browsers");
  return executable;
}

/** Check capabilities on the real suite browser, not a second cold launch. */
export async function verifyBrowserRuntime(browser) {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ci-browser-"));
  let context;
  try {
    context = await browser.newContext({ recordVideo: { dir: recordingDir } });
    const page = await context.newPage();
    await page.setContent("<h1>Startrips CI browser readiness</h1>");
    const h264 = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"'));
    if (!h264) throw new Error("Hosted browser lacks H.264 support required for media QA");
    // Request a painted frame before flushing the recorder; no fixed sleep.
    await page.screenshot();
    const video = page.video();
    await context.close();
    context = null;
    if (!video || fs.statSync(await video.path()).size === 0) throw new Error("Playwright recording smoke produced no video");
    console.log(`CI_BROWSER_RUNTIME=${JSON.stringify({ version: browser.version(), runnerImage: process.env.ImageVersion || "unknown", h264, recordingVerified: true })}`);
  } finally {
    if (context) await context.close().catch(() => {});
    fs.rmSync(recordingDir, { recursive: true, force: true });
  }
}

export async function launchWithRuntimeCheck(launch, {
  enabled = process.env.QA_VERIFY_RUNTIME === "1",
  verify = verifyBrowserRuntime,
} = {}) {
  const browser = await launch();
  try {
    if (enabled) await verify(browser);
    return browser;
  } catch (error) {
    // Preserve the failed assertion even if cleanup itself fails.
    await browser.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const require = createRequire(import.meta.url);
  const project = require("../package.json");
  assertRuntimeVersion(process.env.QA_PLAYWRIGHT_VERSION,
    require("playwright-core/package.json").version, project.devDependencies["playwright-core"]);
  const executablePath = selectHostedBrowser(process.env.QA_BROWSER_PATH);
  fs.accessSync(executablePath, fs.constants.X_OK);
  const version = execFileSync(executablePath, ["--version"], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  console.log(`CI_BROWSER_SELECTION=${JSON.stringify({ executablePath, version, runnerImage: process.env.ImageVersion || "unknown" })}`);
  // Capability/recording assertions remain mandatory in each real suite. Reuse
  // its launch/options/budget rather than imposing a separate 20s cold start.
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV,
    `QA_BROWSER_PATH=${executablePath}\nQA_VERIFY_RUNTIME=1\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::CI browser infrastructure failed: ${error.message}`);
    process.exitCode = 1;
  });
}
