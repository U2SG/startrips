// #194: every mobile-sensitive product surface must agree with the shared
// compact-mobile contract for the same viewport. This lane drives the real
// browser across the QA matrix in the issue and compares, per viewport, what
// `matchMedia(COMPACT_MOBILE_MEDIA_QUERY)` resolves to against the
// `data-mobile-v2` marker each mounted surface publishes.
//
// What this lane deliberately does NOT cover: label/header collision and
// connector geometry, because neither QA preview mounts the Atlas header, the
// mobile chrome or the journey connector; and the compact route-label
// typography, because a route label only exists once a route is active, which
// this lane does not drive. Those stay unmeasured and are recorded as a gap
// rather than claimed here. The route-label rule's own cascade is instead
// argued statically: `.particle-earth-route__label text` is styled in exactly
// two places, both in src/app.css, the compact one second.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const ONE_PIXEL_GIF = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

// The exact literal from src/journey/mobileLayout.ts. A drift between the two
// is caught by the core lane (src/journey/compactMobileContract.test.ts); this
// copy exists only so the browser can evaluate the query it is asserting.
const COMPACT_MOBILE_MEDIA_QUERY =
  "(max-width: 760px), (max-width: 960px) and (max-height: 480px) and (any-pointer: coarse)";

// The matrix #194 asks for, plus the expectation for each entry. Coarse-pointer
// landscape wider than 760px is the whole point: 844x390 and 932x430 must be
// compact even though a width-only breakpoint would call them desktop.
const MATRIX = [
  { name: "portrait-320x700", width: 320, height: 700, mobile: true, compact: true },
  { name: "portrait-390x844", width: 390, height: 844, mobile: true, compact: true },
  { name: "landscape-667x375", width: 667, height: 375, mobile: true, compact: true },
  { name: "landscape-740x360", width: 740, height: 360, mobile: true, compact: true },
  { name: "landscape-780x360", width: 780, height: 360, mobile: true, compact: true },
  { name: "landscape-844x390", width: 844, height: 390, mobile: true, compact: true },
  { name: "landscape-932x430", width: 932, height: 430, mobile: true, compact: true },
  { name: "desktop-1024x768", width: 1024, height: 768, mobile: false, compact: false },
];

// The surfaces that publish the marker, and the preview that mounts each.
const SURFACES = {
  "journey-playback": [".journey-playback"],
  "journey-routes": [".particle-earth-scene"],
};

// The journey-routes preview needs a real WebGL context for the particle globe
// to build its route layer, and the CI runner has no GPU - the same software
// rasteriser the other globe lanes use.
const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(entry) {
  checks.push(entry);
  if (entry.failed) failed = true;
}

async function readContract(page, selectors) {
  return page.evaluate(({ query, selectors: wanted }) => {
    const surfaces = wanted.map((selector) => {
      const element = document.querySelector(selector);
      return {
        selector,
        mounted: Boolean(element),
        marker: element?.getAttribute("data-mobile-v2") ?? null,
      };
    });
    return {
      matches: matchMedia(query).matches,
      coarsePointer: matchMedia("(any-pointer: coarse)").matches,
      viewport: [innerWidth, innerHeight],
      surfaces,
    };
  }, { query: COMPACT_MOBILE_MEDIA_QUERY, selectors });
}

/** Every visible control in the overlay, with its bounds. */
async function scanControls(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [];
    return [...root.querySelectorAll("button, select")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0.05
          && bounds.width > 1
          && bounds.height > 1;
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          name: (element.getAttribute("aria-label") || element.textContent || element.tagName)
            .trim().replace(/\s+/g, " ").slice(0, 60),
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      });
  }, rootSelector);
}

async function openPreview(qaState, { width, height, mobile }) {
  const page = await browser.newPage({
    viewport: { width, height },
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
  // The Playback preview opens a media chapter, and there is no API behind the
  // Vite dev server in this lane. Serve the same one-pixel asset the media
  // lanes use so a 500 does not masquerade as a contract failure.
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: ONE_PIXEL_GIF, expiresAt: "2027-01-01T00:00:00.000Z" }),
  }));
  await page.goto(`${origin}/?qaState=${qaState}`, { waitUntil: "domcontentloaded" });
  return { page, consoleErrors, pageErrors };
}

try {
  // 0. The second clause of the shared query is `any-pointer: coarse`. If this
  //    browser does not report it, every landscape-phone case below would
  //    silently fall back to the width-only clause and prove nothing, so fail
  //    loudly here instead of passing on a false premise.
  {
    const probe = await openPreview("journey-playback", MATRIX[6]);
    try {
      const contract = await readContract(probe.page, SURFACES["journey-playback"]);
      record({
        name: "coarse-pointer-available",
        coarsePointer: contract.coarsePointer,
        viewport: contract.viewport,
        failed: contract.coarsePointer !== true,
      });
    } finally {
      await probe.page.close();
    }
  }

  // 1. Every viewport, every mounted surface: the marker equals the query.
  for (const [qaState, selectors] of Object.entries(SURFACES)) {
    for (const entry of MATRIX) {
      const preview = await openPreview(qaState, entry);
      try {
        await preview.page.waitForSelector(selectors[0], { timeout: 15_000 });
        const contract = await readContract(preview.page, selectors);
        const expectedMarker = entry.compact ? "on" : "off";
        const disagreeing = contract.surfaces.filter(
          (surface) => !surface.mounted || surface.marker !== expectedMarker,
        );
        record({
          name: `${qaState}/${entry.name}`,
          viewport: contract.viewport,
          expectedCompact: entry.compact,
          queryMatches: contract.matches,
          coarsePointer: contract.coarsePointer,
          surfaces: contract.surfaces,
          disagreeing: disagreeing.map((surface) => surface.selector),
          failed: contract.matches !== entry.compact || disagreeing.length > 0,
        });
        if (preview.consoleErrors.length || preview.pageErrors.length) {
          record({
            name: `${qaState}/${entry.name}/runtime-errors`,
            consoleErrors: preview.consoleErrors,
            pageErrors: preview.pageErrors,
            failed: true,
          });
        }
      } finally {
        await preview.page.close();
      }
    }
  }

  // 2. Playback controls stay reachable at the two landscape sizes #194 names.
  for (const entry of MATRIX.filter((size) => size.name.endsWith("844x390") || size.name.endsWith("932x430"))) {
    const preview = await openPreview("journey-playback", entry);
    try {
      await preview.page.waitForSelector(".journey-playback__controls", { timeout: 15_000 });
      const controls = await scanControls(preview.page, ".journey-playback__controls");
      const offscreen = controls.filter((control) => (
        control.left < 0
        || control.top < 0
        || control.right > entry.width + 0.5
        || control.bottom > entry.height + 0.5
      ));
      // 44px is the touch target floor the repo already applies elsewhere; the
      // control grid states 44px columns, so a compact layout has to keep them.
      const undersized = controls.filter(
        (control) => Math.min(control.width, control.height) < 43.5,
      );
      record({
        name: `playback-controls-reachable/${entry.name}`,
        controlCount: controls.length,
        offscreen: offscreen.map((control) => control.name),
        undersized: undersized.map((control) => ({
          name: control.name,
          size: [Math.round(control.width), Math.round(control.height)],
        })),
        failed: controls.length === 0 || offscreen.length > 0 || undersized.length > 0,
      });
    } finally {
      await preview.page.close();
    }
  }

  // 2b. The attribute being right is not the same as the compact styling
  //     applying: moving a rule out of a media query changes its specificity,
  //     and a rule that silently loses the cascade would still pass every
  //     assertion above. Compare a computed property against the base value on
  //     the surface #194 names.
  for (const [qaState, selector, property, compactValue, baseValue] of [
    ["journey-playback", ".journey-playback__stage", "padding", "24px", "48px"],
  ]) {
    const observed = {};
    for (const entry of [MATRIX[6], MATRIX[7]]) {
      const preview = await openPreview(qaState, entry);
      try {
        // `attached`, not `visible`: a route label is an SVG <text> whose group
        // may still be at zero reveal opacity, and the computed value is what
        // this case is about.
        await preview.page.waitForSelector(selector, { state: "attached", timeout: 30_000 });
        observed[entry.compact ? "compact" : "base"] = await preview.page.evaluate(
          ({ target, prop }) => {
            const element = document.querySelector(target);
            return element ? getComputedStyle(element).getPropertyValue(prop).trim() : null;
          },
          { target: selector, prop: property },
        );
      } finally {
        await preview.page.close();
      }
    }
    record({
      name: `computed-style/${selector}/${property}`,
      compact: observed.compact,
      base: observed.base,
      expected: { compact: compactValue, base: baseValue },
      failed: observed.compact !== compactValue || observed.base !== baseValue,
    });
  }

  // 3. An orientation flip must not leave a stale marker behind. The page is
  //    never reloaded: the media-query listener is what has to react.
  {
    const preview = await openPreview("journey-playback", MATRIX[6]);
    try {
      await preview.page.waitForSelector(".journey-playback", { timeout: 15_000 });
      const steps = [];
      for (const [width, height, expected] of [
        [932, 430, true],
        [430, 932, true],
        [1024, 768, false],
        [932, 430, true],
      ]) {
        await preview.page.setViewportSize({ width, height });
        await preview.page.waitForTimeout(120);
        const contract = await readContract(preview.page, SURFACES["journey-playback"]);
        steps.push({
          viewport: [width, height],
          expectedCompact: expected,
          queryMatches: contract.matches,
          marker: contract.surfaces[0]?.marker ?? null,
          agrees: contract.matches === expected
            && contract.surfaces[0]?.marker === (expected ? "on" : "off"),
        });
      }
      record({
        name: "orientation-flip-keeps-the-contract",
        steps,
        failed: steps.some((step) => !step.agrees),
      });
    } finally {
      await preview.page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
