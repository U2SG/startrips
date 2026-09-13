import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const qaUrl = new URL("/?qaState=brand-signature-motion", baseUrl).toString();
const results = [];
let failed = false;

function record(name, data, condition) {
  const row = { name, ...data, failed: !condition };
  results.push(row);
  console.log(JSON.stringify(row));
  if (!condition) failed = true;
}

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function openPage(reducedMotion = "no-preference") {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    reducedMotion,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(qaUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const motion = page.locator(".startrips-signature-motion");
  await motion.waitFor({ state: "visible", timeout: 10_000 });
  return { context, page, motion, pageErrors };
}

async function openInitiallyHiddenPage() {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    reducedMotion: "no-preference",
  });
  await context.addInitScript(() => {
    window.__qaSignatureHidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => window.__qaSignatureHidden,
    });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(qaUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const motion = page.locator(".startrips-signature-motion");
  await motion.waitFor({ state: "visible", timeout: 10_000 });
  return { context, page, motion, pageErrors };
}

async function readMotion(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".startrips-signature-motion");
    const svg = root?.querySelector("svg");
    const bbox = svg instanceof SVGGraphicsElement ? svg.getBBox() : null;
    return {
      clip: root?.getAttribute("data-signature-clip") ?? null,
      status: root?.getAttribute("data-signature-status") ?? null,
      cycle: Number(root?.getAttribute("data-signature-cycle") ?? "-1"),
      elapsedMs: Number(root?.getAttribute("data-signature-elapsed-ms") ?? "NaN"),
      durationMs: Number(root?.getAttribute("data-signature-clip-duration-ms") ?? "NaN"),
      driverCount: Number(root?.getAttribute("data-signature-driver-count") ?? "NaN"),
      listenerCount: Number(root?.getAttribute("data-signature-listener-count") ?? "NaN"),
      declaredNodeCount: Number(root?.getAttribute("data-signature-node-count") ?? "NaN"),
      actualNodeCount: root?.querySelectorAll("*").length ?? -1,
      useCount: root?.querySelectorAll("use").length ?? 0,
      bbox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null,
    };
  });
}

try {
  // Actual cycle + bounded rendering + hidden/offscreen suspension.
  const continuity = await openPage();
  try {
    await continuity.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "running"
    ));
    const initial = await readMotion(continuity.page);
    await continuity.page.waitForFunction(() => Number(
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-cycle") ?? "0",
    ) >= 1, null, { timeout: 6_000 });
    const cycleOneAt = await continuity.page.evaluate(() => performance.now());
    const afterOne = await readMotion(continuity.page);
    await continuity.page.waitForFunction(() => Number(
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-cycle") ?? "0",
    ) >= 2, null, { timeout: 6_000 });
    const cycleTwoAt = await continuity.page.evaluate(() => performance.now());
    const afterTwo = await readMotion(continuity.page);
    const measuredCycleMs = cycleTwoAt - cycleOneAt;
    record("brand-signature:loading-cycle", {
      initial,
      afterOne,
      afterTwo,
      measuredCycleMs,
      pageErrors: continuity.pageErrors,
    }, initial.clip === "loading"
      && initial.durationMs <= 4_000
      && measuredCycleMs > 3_200
      && measuredCycleMs <= 4_200
      && initial.declaredNodeCount === initial.actualNodeCount
      && initial.actualNodeCount === afterOne.actualNodeCount
      && afterOne.actualNodeCount === afterTwo.actualNodeCount
      && initial.listenerCount === afterOne.listenerCount
      && afterOne.listenerCount === afterTwo.listenerCount
      && initial.driverCount === 1
      && afterOne.driverCount === 1
      && afterTwo.driverCount === 1
      && initial.useCount >= 16
      && Boolean(initial.bbox && initial.bbox.width > 100 && initial.bbox.height > 40)
      && continuity.pageErrors.length === 0);

    // Hidden tab simulation follows the actual visibilitychange path.
    const beforeHidden = await readMotion(continuity.page);
    await continuity.page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await continuity.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "suspended"
    ));
    const hiddenStart = await readMotion(continuity.page);
    await continuity.page.waitForTimeout(350);
    const hiddenEnd = await readMotion(continuity.page);
    await continuity.page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await continuity.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "running"
    ));
    record("brand-signature:hidden-suspension", { beforeHidden, hiddenStart, hiddenEnd },
      hiddenStart.driverCount === 0
      && hiddenEnd.driverCount === 0
      && Math.abs(hiddenEnd.elapsedMs - hiddenStart.elapsedMs) < 1);

    // Move the real loader offscreen; IntersectionObserver must cancel the driver.
    await continuity.page.evaluate(() => {
      const root = document.querySelector(".startrips-signature-motion");
      if (root instanceof HTMLElement) root.style.transform = "translateY(200vh)";
    });
    await continuity.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "suspended"
    ), null, { timeout: 5_000 });
    const offscreenStart = await readMotion(continuity.page);
    await continuity.page.waitForTimeout(350);
    const offscreenEnd = await readMotion(continuity.page);
    await continuity.page.evaluate(() => {
      const root = document.querySelector(".startrips-signature-motion");
      if (root instanceof HTMLElement) root.style.transform = "";
    });
    await continuity.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "running"
    ), null, { timeout: 5_000 });
    record("brand-signature:offscreen-suspension", { offscreenStart, offscreenEnd },
      offscreenStart.driverCount === 0
      && offscreenEnd.driverCount === 0
      && Math.abs(offscreenEnd.elapsedMs - offscreenStart.elapsedMs) < 1);
  } finally {
    await continuity.context.close();
  }

  // A loader mounted while the tab is already hidden must never accumulate
  // the hidden interval before its first visible frame.
  const initiallyHidden = await openInitiallyHiddenPage();
  try {
    await initiallyHidden.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "suspended"
    ));
    const hiddenMount = await readMotion(initiallyHidden.page);
    await initiallyHidden.page.waitForTimeout(700);
    const hiddenLater = await readMotion(initiallyHidden.page);
    await initiallyHidden.page.evaluate(() => {
      window.__qaSignatureHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await initiallyHidden.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "running"
    ));
    await initiallyHidden.page.waitForTimeout(80);
    const resumed = await readMotion(initiallyHidden.page);
    record("brand-signature:initial-hidden-mount", {
      hiddenMount, hiddenLater, resumed, pageErrors: initiallyHidden.pageErrors,
    }, hiddenMount.status === "suspended"
      && hiddenMount.driverCount === 0
      && hiddenMount.cycle === 0
      && hiddenMount.elapsedMs === 0
      && hiddenLater.driverCount === 0
      && hiddenLater.cycle === 0
      && hiddenLater.elapsedMs === 0
      && resumed.status === "running"
      && resumed.driverCount === 1
      && resumed.cycle === 0
      && resumed.elapsedMs >= 0
      && resumed.elapsedMs < 500
      && initiallyHidden.pageErrors.length === 0);
  } finally {
    await initiallyHidden.context.close();
  }

  // Pointer interruption settles once and never restarts.
  for (const input of ["pointer", "keyboard"]) {
    const run = await openPage();
    try {
      await run.page.waitForFunction(() => {
        const root = document.querySelector(".startrips-signature-motion");
        return root?.getAttribute("data-signature-status") === "running"
          && Number(root.getAttribute("data-signature-elapsed-ms") ?? "0") > 500;
      });
      if (input === "pointer") await run.page.mouse.click(20, 20);
      else await run.page.keyboard.press("Space");
      await run.page.waitForFunction(() => (
        document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "interrupted"
      ));
      const interrupted = await readMotion(run.page);
      await run.page.waitForTimeout(550);
      const later = await readMotion(run.page);
      record(`brand-signature:${input}-interrupt`, { interrupted, later, pageErrors: run.pageErrors },
        interrupted.driverCount === 0
        && later.driverCount === 0
        && interrupted.status === "interrupted"
        && later.status === "interrupted"
        && later.cycle === interrupted.cycle
        && later.elapsedMs === interrupted.elapsedMs
        && run.pageErrors.length === 0);
    } finally {
      await run.context.close();
    }
  }

  // Reduced motion renders the approved final geometry without scheduling the timeline.
  const reduced = await openPage("reduce");
  try {
    await reduced.page.waitForFunction(() => (
      document.querySelector(".startrips-signature-motion")?.getAttribute("data-signature-status") === "reduced"
    ));
    const sample = await readMotion(reduced.page);
    await reduced.page.waitForTimeout(350);
    const later = await readMotion(reduced.page);
    record("brand-signature:reduced-motion", { sample, later, pageErrors: reduced.pageErrors },
      sample.driverCount === 0
      && later.driverCount === 0
      && sample.cycle === 0
      && later.cycle === 0
      && sample.elapsedMs === sample.durationMs
      && later.elapsedMs === sample.elapsedMs
      && reduced.pageErrors.length === 0);
  } finally {
    await reduced.context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ summary: "brand-signature-motion", failed, results }, null, 2));
if (failed) process.exitCode = 1;
