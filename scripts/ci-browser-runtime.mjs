import fs from "node:fs";
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

async function main() {
  const require = createRequire(import.meta.url);
  const project = require("../package.json");
  assertRuntimeVersion(process.env.QA_PLAYWRIGHT_VERSION,
    require("playwright-core/package.json").version, project.devDependencies["playwright-core"]);
  const { chromium } = await import("playwright-core");
  const executablePath = selectHostedBrowser(process.env.QA_BROWSER_PATH);
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ci-browser-"));
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000 });
    const context = await browser.newContext({ recordVideo: { dir: recordingDir } });
    const page = await context.newPage();
    await page.setContent("<h1>Startrips CI browser readiness</h1>");
    const h264 = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"'));
    if (!h264) throw new Error("Hosted browser lacks H.264 support required for media QA");
    const video = page.video();
    await context.close();
    if (!video || fs.statSync(await video.path()).size === 0) throw new Error("Playwright recording smoke produced no video");
    console.log(`CI_BROWSER_RUNTIME=${JSON.stringify({ executablePath, version: browser.version(), runnerImage: process.env.ImageVersion || "unknown", h264 })}`);
  } finally {
    if (browser) await browser.close();
    fs.rmSync(recordingDir, { recursive: true, force: true });
  }
  // Preserve qa-browser.mjs's hosted Chrome preference and record its exact version.
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `QA_BROWSER_PATH=${executablePath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::CI browser infrastructure failed: ${error.message}`);
    process.exitCode = 1;
  });
}
