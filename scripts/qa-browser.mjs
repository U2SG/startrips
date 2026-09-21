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

/**
 * #349: the sign-in gate reads which providers this deployment configured from
 * `GET /api/account-identities/providers` before deciding whether to offer a
 * provider button. Browser QA serves the client from the Vite dev server with
 * no API behind it, so any unstubbed `/api/*` read resolves to a proxy 500 that
 * every "no console errors" assertion in the suite then catches.
 *
 * The answer belongs here rather than in each suite because it is a property of
 * the harness -- there is no API -- not of any one suite. `[]` is the truthful
 * answer for a harness with no deployment configuration: no provider button
 * renders, which is exactly what an unconfigured deployment shows. A suite that
 * wants the button routes the same path itself; its later, page-level route
 * takes precedence over this context-level one.
 */
async function installHarnessRoutes(context) {
  await context.route("**/api/account-identities/providers", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ signInProviders: [] }),
  }));
  return context;
}

export async function launchQaBrowser(options = {}) {
  const executablePath = browserCandidates().find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      "No Chromium browser found. Set QA_BROWSER_PATH or run `pnpm exec playwright-core install chromium`.",
    );
  }
  const browser = await chromium.launch({ executablePath, headless: true, ...options });
  // Suites create pages both ways, and `browser.newPage()` makes its own
  // context, so both entry points have to install the harness routes.
  const openContext = browser.newContext.bind(browser);
  const openPage = browser.newPage.bind(browser);
  browser.newContext = async (...args) => await installHarnessRoutes(await openContext(...args));
  browser.newPage = async (...args) => {
    const page = await openPage(...args);
    await installHarnessRoutes(page.context());
    return page;
  };
  return browser;
}
