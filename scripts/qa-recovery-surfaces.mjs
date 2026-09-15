import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const results = [];
let failed = false;

function record(name, data, condition) {
  const row = { name, ...data, failed: !condition };
  results.push(row);
  console.log(JSON.stringify(row));
  if (!condition) failed = true;
}

function nearlyEqual(a, b, tolerance = 0.75) {
  return Math.abs(a - b) <= tolerance;
}

async function openRecovery(browser, kind, { width = 1100, height = 760, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const url = new URL(`/?qaState=recovery-surfaces&qaMode=${kind}`, baseUrl).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const surface = page.locator(`[data-qa-recovery-surface="${kind}"] .startrips-recovery-surface`);
  await surface.waitFor({ state: "visible", timeout: 10_000 });
  return { context, page, surface, pageErrors };
}

async function snapshot(page) {
  return page.evaluate(() => {
    const motion = document.querySelector(".startrips-signature-motion");
    const actions = [...document.querySelectorAll(".startrips-recovery-surface__action")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        text: node.textContent?.trim() ?? "",
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      kind: document.querySelector("[data-qa-recovery-surface]")?.getAttribute("data-qa-recovery-surface") ?? null,
      intent: document.querySelector("[data-qa-recovery-intent]")?.getAttribute("data-qa-recovery-intent") ?? null,
      status: motion?.getAttribute("data-signature-status") ?? null,
      driverCount: Number(motion?.getAttribute("data-signature-driver-count") ?? "NaN"),
      elapsedMs: Number(motion?.getAttribute("data-signature-elapsed-ms") ?? "NaN"),
      durationMs: Number(motion?.getAttribute("data-signature-clip-duration-ms") ?? "NaN"),
      actions,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

function stableActions(first, settled) {
  if (first.length !== settled.length || first.length === 0) return false;
  return first.every((action, index) => {
    const later = settled[index];
    return action.text === later.text
      && action.width >= 44
      && action.height >= 44
      && later.width >= 44
      && later.height >= 44
      && nearlyEqual(action.x, later.x)
      && nearlyEqual(action.y, later.y)
      && nearlyEqual(action.width, later.width)
      && nearlyEqual(action.height, later.height);
  });
}

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  for (const kind of ["not-found", "empty", "error"]) {
    const run = await openRecovery(browser, kind);
    try {
      const first = await snapshot(run.page);
      await run.page.waitForFunction(() => (
        document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "settled"
      ), null, { timeout: 7_000 });
      const settled = await snapshot(run.page);
      const expectedActionCount = kind === "not-found" ? 2 : 1;
      record(`recovery:${kind}:stable-cta`, { first, settled, pageErrors: run.pageErrors },
        first.kind === kind
        && first.actions.length === expectedActionCount
        && settled.status === "settled"
        && settled.driverCount === 0
        && stableActions(first.actions, settled.actions)
        && run.pageErrors.length === 0);
    } finally {
      await run.context.close();
    }
  }

  const interrupted = await openRecovery(browser, "error");
  try {
    await interrupted.page.waitForFunction(() => {
      const motion = document.querySelector(".startrips-signature-motion");
      return motion?.getAttribute("data-signature-status") === "running"
        && Number(motion.getAttribute("data-signature-elapsed-ms") ?? "0") > 100;
    });
    await interrupted.page.locator(".startrips-recovery-surface__action").first().click();
    await interrupted.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "interrupted"
    ));
    const first = await snapshot(interrupted.page);
    await interrupted.page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await interrupted.page.waitForTimeout(250);
    const later = await snapshot(interrupted.page);
    record("recovery:interruption-newest-intent", { first, later, pageErrors: interrupted.pageErrors },
      first.intent === "retry"
      && first.status === "interrupted"
      && first.driverCount === 0
      && later.status === "interrupted"
      && later.driverCount === 0
      && later.elapsedMs === first.elapsedMs
      && interrupted.pageErrors.length === 0);
  } finally {
    await interrupted.context.close();
  }

  const keyboard = await openRecovery(browser, "empty");
  try {
    const action = keyboard.page.locator(".startrips-recovery-surface__action").first();
    await action.focus();
    await keyboard.page.keyboard.press("Enter");
    await keyboard.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "interrupted"
    ));
    const sample = await snapshot(keyboard.page);
    record("recovery:keyboard-intent", { sample, pageErrors: keyboard.pageErrors },
      sample.intent === "create"
      && sample.status === "interrupted"
      && sample.driverCount === 0
      && keyboard.pageErrors.length === 0);
  } finally {
    await keyboard.context.close();
  }

  const navigation = await openRecovery(browser, "not-found");
  try {
    await navigation.page.locator(".startrips-recovery-surface__action").first().click();
    await navigation.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "interrupted"
    ));
    const sample = await snapshot(navigation.page);
    record("recovery:navigation-intent", { sample, pageErrors: navigation.pageErrors },
      sample.intent === "home"
      && sample.status === "interrupted"
      && sample.driverCount === 0
      && navigation.pageErrors.length === 0);
  } finally {
    await navigation.context.close();
  }

  const reduced = await openRecovery(browser, "empty", { reducedMotion: "reduce" });
  try {
    await reduced.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "reduced"
    ));
    const first = await snapshot(reduced.page);
    await reduced.page.waitForTimeout(250);
    const later = await snapshot(reduced.page);
    record("recovery:reduced-motion-static", { first, later, pageErrors: reduced.pageErrors },
      first.status === "reduced"
      && first.driverCount === 0
      && first.elapsedMs === first.durationMs
      && later.status === "reduced"
      && later.driverCount === 0
      && later.elapsedMs === first.elapsedMs
      && reduced.pageErrors.length === 0);
  } finally {
    await reduced.context.close();
  }

  for (const kind of ["not-found", "empty", "error"]) {
    const mobile = await openRecovery(browser, kind, { width: 390, height: 844 });
    try {
      const sample = await snapshot(mobile.page);
      record(`recovery:${kind}:compact-mobile-targets`, { sample, pageErrors: mobile.pageErrors },
        sample.viewport.width <= 430
        && sample.actions.length > 0
        && sample.actions.every((action) => action.width >= 44 && action.height >= 44 && action.x >= 0 && action.x + action.width <= sample.viewport.width + 0.5)
        && mobile.pageErrors.length === 0);
    } finally {
      await mobile.context.close();
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ summary: "recovery-surfaces", failed, results }, null, 2));
if (failed) process.exitCode = 1;
