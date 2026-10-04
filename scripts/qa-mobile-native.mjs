// Native-feeling touch baseline. In a phone touch context (390x844, isMobile,
// hasTouch) this lane asserts the platform-layer contract the stylesheet and
// index.html now carry:
//   - hover effects are gated to fine pointers, so a tapped control keeps its
//     resting style (no sticky hover), while a mouse still gets the effect;
//   - controls carry `touch-action: manipulation` from the shared baseline
//     without clobbering gesture surfaces that state their own (Story sheet
//     handle and media stage, globe canvas);
//   - the viewport meta opts into safe areas and never disables zoom, and
//     theme-color is stated per colour scheme;
//   - text fields are at least 16px on a coarse pointer (no focus zoom), and a
//     field designed larger keeps its size;
//   - the auth gate fills exactly the visible viewport (no vh overflow).
//
// What emulation cannot prove, and this lane therefore does not claim: real
// sticky hover after a finger lifts, the tap delay, safe-area insets under a
// notch or home indicator (env() is 0 here), and the software keyboard. Those
// need a real device.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const ONE_PIXEL_GIF = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
// .auth-password-toggle in src/styles/auth-gate.css: resting #8f9c97, hover #d0d8d4.
const TOGGLE_REST = "rgb(143, 156, 151)";
const TOGGLE_HOVER = "rgb(208, 216, 212)";
// --archive-bg in src/styles/tokens.css, the painted top surface.
const THEME_COLOR = "#020706";

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(entry) {
  checks.push(entry);
  if (entry.failed) failed = true;
}

async function openPage(path, { mobile }) {
  const page = await browser.newPage({
    viewport: mobile ? PHONE : DESKTOP,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: ONE_PIXEL_GIF, expiresAt: "2027-01-01T00:00:00.000Z" }),
  }));
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  return { page, consoleErrors, pageErrors };
}

// A thrown page error always fails. Console errors fail on the auth gate, which
// the harness fully stubs; the dev previews may log unstubbed API reads that
// other lanes own, so there they are recorded as diagnostics only.
function recordRuntimeErrors(name, opened, { consoleFails }) {
  if (opened.consoleErrors.length || opened.pageErrors.length) {
    record({
      name: `${name}/runtime-errors`,
      consoleErrors: opened.consoleErrors,
      pageErrors: opened.pageErrors,
      failed: opened.pageErrors.length > 0 || (consoleFails && opened.consoleErrors.length > 0),
    });
  }
}

const readColor = (page, selector) => page.locator(selector).first()
  .evaluate((element) => getComputedStyle(element).color);

try {
  // 1. Phone, signed out: the auth gate.
  {
    const opened = await openPage("/", { mobile: true });
    const { page } = opened;
    try {
      await page.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 15_000 });
      const toggle = ".auth-password-toggle";
      await page.locator(toggle).waitFor({ state: "visible", timeout: 8_000 });

      const platform = await page.evaluate(() => {
        const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
        const themeColors = [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({
          media: meta.getAttribute("media"),
          content: meta.getAttribute("content"),
        }));
        return {
          hoverFine: matchMedia("(hover: hover) and (pointer: fine)").matches,
          coarse: matchMedia("(pointer: coarse)").matches,
          viewport,
          themeColors,
          htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
          bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
        };
      });
      record({
        name: "phone/no-hover-capability",
        ...platform,
        failed: platform.hoverFine !== false || platform.coarse !== true,
      });
      const viewportTokens = platform.viewport.split(",").map((token) => token.trim().replace(/\s+/g, ""));
      record({
        name: "viewport-meta/cover-without-zoom-lock",
        viewport: platform.viewport,
        failed: !viewportTokens.includes("viewport-fit=cover")
          || !viewportTokens.includes("width=device-width")
          || viewportTokens.some((token) => token.startsWith("maximum-scale") || token.startsWith("user-scalable")),
      });
      const light = platform.themeColors.find((meta) => meta.media === "(prefers-color-scheme: light)");
      const dark = platform.themeColors.find((meta) => meta.media === "(prefers-color-scheme: dark)");
      record({
        name: "theme-color/per-scheme",
        themeColors: platform.themeColors,
        failed: platform.themeColors.length !== 2
          || light?.content !== THEME_COLOR
          || dark?.content !== THEME_COLOR,
      });
      record({
        name: "root/no-pull-to-refresh",
        html: platform.htmlOverscroll,
        body: platform.bodyOverscroll,
        failed: platform.htmlOverscroll !== "none" || platform.bodyOverscroll !== "none",
      });

      // Sticky hover: the toggle's tap changes the password field type, not
      // its own colour, so any colour change after a tap is the hover rule.
      const before = await readColor(page, toggle);
      await page.locator(toggle).tap();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await readColor(page, toggle);
      const hoverMatchedAfterTap = await page.locator(toggle).evaluate((element) => element.matches(":hover"));
      record({
        name: "sticky-hover/tap-keeps-resting-style",
        before,
        after,
        hoverMatchedAfterTap,
        failed: before !== TOGGLE_REST || after !== TOGGLE_REST,
      });

      const controls = await page.evaluate(() => {
        const primary = document.querySelector(".auth-primary");
        const copy = document.querySelector(".auth-card--login-v3 h1, .auth-card--login-v3 p");
        const userSelect = (element) => {
          const style = getComputedStyle(element);
          return style.getPropertyValue("user-select") || style.getPropertyValue("-webkit-user-select");
        };
        return {
          primaryTouchAction: primary ? getComputedStyle(primary).touchAction : null,
          primaryUserSelect: primary ? userSelect(primary) : null,
          copyUserSelect: copy ? userSelect(copy) : null,
        };
      });
      record({
        name: "controls/touch-action-and-label-selection",
        ...controls,
        failed: controls.primaryTouchAction !== "manipulation"
          || controls.primaryUserSelect !== "none"
          || controls.copyUserSelect === null
          || controls.copyUserSelect === "none",
      });

      const email = await page.locator("#auth-email").evaluate((element) => getComputedStyle(element).fontSize);
      record({
        name: "inputs/no-focus-zoom",
        emailFontSize: email,
        failed: email !== "16px",
      });

      const gate = await page.evaluate(() => {
        const element = document.querySelector(".auth-gate");
        const vhRules = [];
        for (const sheet of document.styleSheets) {
          let rules;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          const visit = (list) => {
            for (const rule of list) {
              if (rule.cssRules) visit(rule.cssRules);
              if (!rule.selectorText || !/auth-gate|persistent-earth-shell|auth-continuity/.test(rule.selectorText)) continue;
              for (const property of ["height", "min-height", "max-height"]) {
                const value = rule.style.getPropertyValue(property);
                if (/(^|[^a-z])[\d.]+vh\b/.test(value)) vhRules.push(`${rule.selectorText} { ${property}: ${value} }`);
              }
            }
          };
          visit(rules);
        }
        return {
          innerHeight,
          computedHeight: element ? getComputedStyle(element).height : null,
          rectHeight: element ? element.getBoundingClientRect().height : null,
          vhRules,
        };
      });
      record({
        name: "auth-gate/fills-visible-viewport",
        ...gate,
        failed: gate.innerHeight !== PHONE.height
          || gate.computedHeight !== `${PHONE.height}px`
          || gate.rectHeight !== PHONE.height
          || gate.vhRules.length > 0,
      });
      recordRuntimeErrors("auth-gate", opened, { consoleFails: true });
    } finally {
      await page.close();
    }
  }

  // 2. Desktop control: the same rule still lights up under a mouse, so the
  //    phone result above is the gate working, not a dead selector.
  {
    const opened = await openPage("/", { mobile: false });
    const { page } = opened;
    try {
      await page.locator(".auth-password-toggle").waitFor({ state: "visible", timeout: 15_000 });
      const hoverFine = await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches);
      const rest = await readColor(page, ".auth-password-toggle");
      await page.locator(".auth-password-toggle").hover();
      await page.waitForFunction(
        ({ selector, wanted }) => getComputedStyle(document.querySelector(selector)).color === wanted,
        { selector: ".auth-password-toggle", wanted: TOGGLE_HOVER },
        { timeout: 2_000 },
      ).catch(() => undefined);
      const hovered = await readColor(page, ".auth-password-toggle");
      const touchAction = await page.locator(".auth-primary").evaluate((element) => getComputedStyle(element).touchAction);
      record({
        name: "desktop/hover-still-applies",
        hoverFine,
        rest,
        hovered,
        touchAction,
        failed: hoverFine !== true || rest !== TOGGLE_REST || hovered !== TOGGLE_HOVER || touchAction !== "manipulation",
      });
      recordRuntimeErrors("desktop-auth-gate", opened, { consoleFails: true });
    } finally {
      await page.close();
    }
  }

  // 3. Story on a phone: its gesture surfaces keep their own touch-action.
  {
    const opened = await openPage("/?qaState=journey-story", { mobile: true });
    const { page } = opened;
    try {
      await page.locator(".journey-story").waitFor({ state: "visible", timeout: 15_000 });
      await page.locator('.journey-story__media[data-mobile-layout="true"]').waitFor({ state: "attached", timeout: 15_000 });
      const story = await page.evaluate(() => {
        const read = (selector) => {
          const element = document.querySelector(selector);
          return element ? getComputedStyle(element).touchAction : null;
        };
        return {
          mediaStage: read('.journey-story__media[data-mobile-layout="true"]'),
          sheetHandle: read(".journey-story__sheet-handle"),
          closeButton: read(".journey-story > header button"),
        };
      });
      record({
        name: "story/gesture-surfaces-keep-touch-action",
        ...story,
        failed: story.mediaStage !== "pan-y"
          || story.sheetHandle !== "none"
          || story.closeButton !== "manipulation",
      });
      recordRuntimeErrors("journey-story", opened, { consoleFails: false });
    } finally {
      await page.close();
    }
  }

  // 4. Globe on a phone: the drag-rotation canvas keeps `none`.
  {
    const opened = await openPage("/?qaState=journey-routes", { mobile: true });
    const { page } = opened;
    try {
      await page.locator('.particle-earth-scene[data-drag-rotation="true"] canvas').first()
        .waitFor({ state: "attached", timeout: 30_000 });
      const canvas = await page.locator('.particle-earth-scene[data-drag-rotation="true"] canvas').first()
        .evaluate((element) => getComputedStyle(element).touchAction);
      record({
        name: "globe/canvas-keeps-touch-action",
        canvas,
        failed: canvas !== "none",
      });
      recordRuntimeErrors("journey-routes", opened, { consoleFails: false });
    } finally {
      await page.close();
    }
  }

  // 5. Composer on a phone: every text field is at least 16px, and the title
  //    field keeps its larger editorial size.
  {
    const opened = await openPage("/?qaState=journey-composer", { mobile: true });
    const { page } = opened;
    try {
      await page.locator(".journey-composer").waitFor({ state: "visible", timeout: 15_000 });
      const fields = await page.evaluate(() => {
        const skip = new Set(["checkbox", "radio", "range", "file", "color", "button", "submit", "reset", "image", "hidden"]);
        const all = [...document.querySelectorAll(".journey-composer :is(input, textarea, select)")]
          .filter((element) => !(element instanceof HTMLInputElement && skip.has(element.type)))
          .map((element) => ({
            name: element.getAttribute("aria-label") || element.closest("label")?.textContent?.trim().slice(0, 40) || element.tagName,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          }));
        const title = document.querySelector(".journey-title-field input");
        return {
          count: all.length,
          undersized: all.filter((field) => field.fontSize < 16),
          titleFontSize: title ? getComputedStyle(title).fontSize : null,
        };
      });
      record({
        name: "composer/fields-at-least-16px",
        ...fields,
        // clamp(23px, 2.2vw, 31px) resolves to its 23px floor at 390px wide.
        failed: fields.count === 0 || fields.undersized.length > 0 || fields.titleFontSize !== "23px",
      });
      recordRuntimeErrors("journey-composer", opened, { consoleFails: false });
    } finally {
      await page.close();
    }
  }
} catch (error) {
  console.log(JSON.stringify(checks, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
