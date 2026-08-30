import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const browser = await launchQaBrowser();
const checks = [];
let failed = false;

async function createStory(viewport) {
  const page = await browser.newPage({
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: onePixelGif, expiresAt: "2026-09-01T00:00:00.000Z" }),
  }));
  await page.goto(`${origin}/?qaState=journey-story`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-story").waitFor({state: "visible"});
  return page;
}

async function touchSwipe(page, selector, dx, dy) {
  const target = page.locator(selector);
  const box = await target.boundingBox();
  if (!box) throw new Error(`${selector} has no bounds`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x + dx, y: y + dy }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(80);
}

function add(check) {
  checks.push(check);
  if (check.failed) failed = true;
}

try {
  for (const [label, viewport] of [
    ["320", { width: 320, height: 700 }],
    ["360", { width: 360, height: 780 }],
    ["390", { width: 390, height: 844 }],
    ["430", { width: 430, height: 900 }],
    ["844x390", { width: 844, height: 390 }],
    ["932x430", { width: 932, height: 430 }],
  ]) {
    const page = await createStory(viewport);
    try {
      const story = page.locator(".journey-story");
      const handle = page.locator(".journey-story__sheet-handle");
      const initialPresentation = await story.getAttribute("data-mobile-presentation");
      const initialModal = await story.getAttribute("aria-modal");
      const handleBox = await handle.boundingBox();
      const handleHit = handleBox ? Math.min(handleBox.width, handleBox.height) : 0;
      add({
        name: `story-sheet-contract-${label}`,
        initialPresentation,
        initialModal,
        handleHit,
        failed: initialPresentation !== "in-context" || initialModal !== null || handleHit < 44,
      });

      await handle.click();
      await page.waitForFunction(() =>
        document.querySelector(".journey-story")?.getAttribute("data-mobile-presentation") === "expanded"
      );
      const expandedModal = await story.getAttribute("aria-modal");
      const atlasInertWhileExpanded = await page.locator(".living-atlas").evaluate((atlas) =>
        [...atlas.children].some((child) => child instanceof HTMLElement && child.inert)
      );
      add({
        name: `story-sheet-expanded-modal-${label}`,
        expandedModal,
        atlasInertWhileExpanded,
        failed: expandedModal !== "true" || !atlasInertWhileExpanded,
      });

      await page.evaluate(() => history.back());
      await page.waitForFunction(() =>
        document.querySelector(".journey-story")?.getAttribute("data-mobile-presentation") === "in-context"
      );
      const backModal = await story.getAttribute("aria-modal");
      const atlasInertAfterBack = await page.locator(".living-atlas").evaluate((atlas) =>
        [...atlas.children].some((child) => child instanceof HTMLElement && child.inert)
      );
      add({
        name: `story-sheet-back-${label}`,
        backModal,
        atlasInertAfterBack,
        failed: backModal !== null || atlasInertAfterBack,
      });
    } finally {
      await page.close();
    }
  }

  const page = await createStory({ width: 390, height: 844 });
  try {
    const story = page.locator(".journey-story");
    const handle = page.locator(".journey-story__sheet-handle");

    await touchSwipe(page, ".journey-story__sheet-handle", 0, -80);
    await page.waitForFunction(() =>
      document.querySelector(".journey-story")?.getAttribute("data-mobile-presentation") === "expanded"
    );
    add({
      name: "story-sheet-handle-vertical-swipe",
      presentation: await story.getAttribute("data-mobile-presentation"),
      failed: (await story.getAttribute("data-mobile-presentation")) !== "expanded",
    });

    await page.evaluate(() => history.back());
    await page.waitForFunction(() =>
      document.querySelector(".journey-story")?.getAttribute("data-mobile-presentation") === "in-context"
    );

    await touchSwipe(page, ".journey-story__media", -90, 0);
    add({
      name: "story-sheet-media-horizontal-ownership",
      presentation: await story.getAttribute("data-mobile-presentation"),
      failed: (await story.getAttribute("data-mobile-presentation")) !== "in-context",
    });

    const scroll = await story.evaluate((element) => {
      element.scrollTop = 0;
      element.scrollBy(0, 160);
      return { scrollTop: element.scrollTop, presentation: element.getAttribute("data-mobile-presentation") };
    });
    add({
      name: "story-sheet-scroll-ownership",
      ...scroll,
      failed: scroll.presentation !== "in-context",
    });

    const media = page.locator(
      ".journey-story__media > img:not(.journey-story__media-incoming), .journey-story__media > video:not(.journey-story__media-incoming)"
    ).first();
    await media.click();
    await page.locator(".journey-story-fullscreen").waitFor({state: "visible"});
    await page.evaluate(() => history.back());
    await page.locator(".journey-story-fullscreen").waitFor({ state: "detached" });
    add({
      name: "story-sheet-fullscreen-restores-snap",
      presentation: await story.getAttribute("data-mobile-presentation"),
      failed: (await story.getAttribute("data-mobile-presentation")) !== "in-context",
    });
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exit(1);
