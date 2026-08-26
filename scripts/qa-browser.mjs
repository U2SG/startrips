import fs from "node:fs";
import { chromium } from "playwright-core";

function browserCandidates() {
  const candidates = [process.env.QA_BROWSER_PATH];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
  } else if (process.platform === "linux") {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  candidates.push(chromium.executablePath());
  return [...new Set(candidates.filter(Boolean))];
}

export async function launchQaBrowser(options = {}) {
  const executablePath = browserCandidates().find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      "No Chromium browser found. Set QA_BROWSER_PATH or run `pnpm exec playwright-core install chromium`.",
    );
  }
  return chromium.launch({ executablePath, headless: true, ...options });
}
