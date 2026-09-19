// #379 - the approved Journey cover opening, driven at the REAL product
// surface in a real browser.
//
// `scripts/qa-cover-reveal.mjs` grades the vendored renderer through the
// dev-only preview. This lane grades something the preview cannot answer: that
// the opening appears at the existing Journey cover the owner approved, on the
// desktop active panel and the mobile sheet, that every failure mode leaves the
// canonical original cover immediately reachable, that a newer intent takes the
// surface at once, that a cover revision opens at most once, and that nothing
// the browser sends carries an authority beyond the ordinary session.
//
// The Atlas API is stubbed at the network boundary because this lane has no
// database, exactly as `qa-owner-share.mjs` does. The two fixture images are
// served over HTTP with CORS rather than inlined, so "the first frame came from
// the authorized ready derivative" is observable as a request the browser
// actually made, and so the renderer's real cross-origin texture path runs.
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";
const artifactDir = "artifacts/cover-reveal-opening";

// Flat colours, so "which image is on screen" is one sampled pixel rather than
// an image-diff judgement. Distinct enough that a blend is neither.
const DERIVATIVE_COLOR = { r: 214, g: 74, b: 42 };
const ORIGINAL_COLOR = { r: 36, g: 92, b: 176 };

const DERIVATIVE_URL = "https://qa-storage.invalid/cover-reveal/derivative.png?sig=qa-display";
const ORIGINAL_URL = "https://qa-storage.invalid/media/original.png?sig=qa-original";

const COVER_ASSET_ID = "qa-asset-cover";
const COVER_HASH = "sha256:qa-cover-bytes";
const JOURNEY_ID = "qa-journey-opening";

/** A 1x1 PNG of one colour, scaled by the browser. Small enough to inline here. */
function solidPng({ r, g, b }) {
  // Hand-built so this lane needs no image dependency: an 8-bit RGB PNG with a
  // single IDAT holding one filtered scanline.
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // zlib stream with one stored deflate block: filter byte 0 plus one RGB pixel.
  const raw = Buffer.from([0, r, g, b]);
  let a = 1;
  let s = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    s = (s + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((s << 16) | a) >>> 0);
  const stored = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, raw.length & 0xff, 0x00, ~raw.length & 0xff, 0xff]),
    raw,
    adler,
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", stored),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DERIVATIVE_PNG = solidPng(DERIVATIVE_COLOR);
const ORIGINAL_PNG = solidPng(ORIGINAL_COLOR);

const results = [];
const failures = [];

function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
}

function journeyFixture({ coverAssetId = COVER_ASSET_ID, contentHash = COVER_HASH } = {}) {
  return {
    id: JOURNEY_ID,
    atlasId: "qa-atlas",
    title: "水墨开场回归旅程",
    startedOn: "2026-05-04",
    endedOn: null,
    note: "这段旅程用于验证封面开场。",
    lightColor: "#77c8c2",
    lightEffect: null,
    coverMediaAssetId: coverAssetId,
    revision: 1,
    createdByUserId: "qa-user",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    routePoints: [{
      id: "qa-point-0",
      journeyId: JOURNEY_ID,
      sortOrder: 0,
      latitude: 22.5,
      longitude: 114.05,
      label: "深圳湾",
      isStop: true,
      occurredAt: null,
      note: null,
      createdAt: "2026-05-04T00:00:00.000Z",
    }],
    media: [{
      id: coverAssetId,
      journeyId: JOURNEY_ID,
      routePointId: null,
      storageDriver: "qa",
      storageKey: `qa/${coverAssetId}`,
      fileName: "cover.png",
      mimeType: "image/png",
      bytes: 4096,
      sortOrder: 0,
      uploadedByUserId: "qa-user",
      contentHash,
      contentHashVerified: true,
      displayWidth: 1600,
      displayHeight: 1200,
      previewState: "none",
      createdAt: "2026-05-04T00:00:00.000Z",
    }],
  };
}

function derivativePayload(overrides = {}) {
  return {
    derivative: {
      id: "qa-derivative-1",
      journeyId: JOURNEY_ID,
      generationKind: "cover-reveal",
      generationVersion: 1,
      presetId: "ink-bloom",
      sourceMediaAssetId: COVER_ASSET_ID,
      sourceContentHash: COVER_HASH,
      mimeType: "image/png",
      width: 1600,
      height: 1200,
      ...overrides,
    },
    display: {
      url: DERIVATIVE_URL,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  };
}

/**
 * The Atlas as a small mutable server.
 *
 * `state.derivative` is a function so a case can answer differently per call,
 * and `state.calls` records every request this surface made — including the
 * headers, because "no worker credential ever reaches the browser" is only
 * falsifiable if what the browser sent is recorded.
 */
async function installAtlasApi(page, state) {
  await page.route("**/qa-storage.invalid/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
    body: route.request().url().includes("derivative") ? DERIVATIVE_PNG : ORIGINAL_PNG,
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: [state.journey] }),
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      url: ORIGINAL_URL,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  }));
  await page.route("**/api/cover-reveal/**", async (route) => {
    const request = route.request();
    state.calls.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
    });
    const answer = state.derivative();
    if (answer.status !== 200) {
      await route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify({ error: answer.error ?? "REQUEST_FAILED" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "private, no-store" },
      body: JSON.stringify(answer.body),
    });
  });
}

/** Everything about the cover surface, read straight from the DOM. */
async function coverState(page) {
  return page.evaluate(() => {
    const figure = document.querySelector(".living-atlas__active-media");
    const stage = document.querySelector(".living-atlas__active-media-reveal");
    const original = figure?.querySelector('img:not([data-cover-reveal-image])') ?? null;
    return {
      figure: Boolean(figure),
      stage: Boolean(stage),
      phase: stage?.getAttribute("data-cover-reveal-phase") ?? null,
      degraded: stage?.getAttribute("data-cover-reveal-degraded") ?? null,
      settleReason: stage?.getAttribute("data-cover-reveal-settle-reason") ?? null,
      canvases: figure ? figure.querySelectorAll("canvas").length : 0,
      originalSrc: original instanceof HTMLImageElement ? original.src : null,
      originalComplete: original instanceof HTMLImageElement ? original.complete : false,
    };
  });
}

/**
 * The colour actually composited over the cover, via a real screenshot.
 *
 * A WebGL drawing buffer without `preserveDrawingBuffer` cannot be read back
 * from a later task, so the frame is captured by the browser's own compositor
 * and then decoded in the page. What is graded is what a person would see.
 */
async function compositedColor(page) {
  const figure = page.locator(".living-atlas__active-media");
  const shot = await figure.screenshot({ type: "png" });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
    bitmap.close();
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  }, shot.toString("base64"));
}

function classify(sample) {
  const distance = (color) => Math.abs(sample.r - color.r)
    + Math.abs(sample.g - color.g) + Math.abs(sample.b - color.b);
  if (distance(DERIVATIVE_COLOR) <= 40) return "derivative";
  if (distance(ORIGINAL_COLOR) <= 40) return "original-cover";
  return "blend";
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, compact: false },
  { name: "portrait-phone", width: 390, height: 844, compact: true },
];

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

/**
 * Open the Atlas and bring the Journey cover surface on screen.
 *
 * On desktop the last Journey is already the active one. The compact layout
 * puts the same cover inside the sheet, which is exactly why the
 * once-per-cover-revision ledger cannot live in the cover component.
 */
async function showCoverSurface(page, viewport) {
  if (viewport.compact) {
    const chip = page.locator(".mobile-v2__journey-chip, [data-mobile-sheet-trigger]").first();
    await chip.waitFor({ timeout: 20_000 });
    await chip.click();
  }
  await page.locator(".living-atlas__active-media").waitFor({ timeout: 20_000 });
}

async function openCoverSurface(page, viewport) {
  await page.goto(`${origin}/?qaState=living-atlas`, { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ timeout: 20_000 });
  await showCoverSurface(page, viewport);
}

async function openCase(viewport, { derivative, reducedMotion = false, journey = journeyFixture() } = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    ...(reducedMotion ? { reducedMotion: "reduce" } : {}),
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const imageRequests = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://qa-storage.invalid/")) imageRequests.push(request.url());
  });
  const state = {
    journey,
    calls: [],
    derivative: derivative ?? (() => ({ status: 200, body: derivativePayload() })),
  };
  await installAtlasApi(page, state);
  await openCoverSurface(page, viewport);
  return { context, page, state, pageErrors, imageRequests };
}

await mkdir(artifactDir, { recursive: true });

let thrown = null;
try {
  for (const viewport of VIEWPORTS) {
    const label = viewport.name;

    // 1. Normal completion: the opening runs at the real cover surface, the
    //    first composited frame is the authorized derivative, and the settled
    //    surface is the canonical original with no renderer left behind.
    {
      const run = await openCase(viewport);
      const { page } = run;
      await page.waitForFunction(
        () => document.querySelector(".living-atlas__active-media-reveal")
          ?.getAttribute("data-cover-reveal-phase") === "revealing",
        undefined,
        { timeout: 20_000 },
      );
      const revealing = classify(await compositedColor(page));
      check(`${label}/first-frame-is-the-derivative`, revealing === "derivative", revealing);
      check(
        `${label}/derivative-was-actually-fetched`,
        run.imageRequests.includes(DERIVATIVE_URL),
        run.imageRequests,
      );

      await page.waitForFunction(
        () => document.querySelector(".living-atlas__active-media-reveal") === null,
        undefined,
        { timeout: 40_000 },
      );
      const settled = await coverState(page);
      const settledColor = classify(await compositedColor(page));
      check(`${label}/settles-on-the-canonical-original`, settledColor === "original-cover", settledColor);
      check(`${label}/original-cover-is-the-product-image`, settled.originalSrc === ORIGINAL_URL, settled);
      check(`${label}/no-renderer-survives-the-opening`, settled.canvases === 0, settled);

      // 2. Once per cover revision. Re-mounting the cover — which is what
      //    closing and reopening the sheet does, and what crossing a
      //    breakpoint does — must not buy a second opening.
      const callsAfterFirst = run.state.calls.length;
      if (viewport.compact) {
        // Without a reload: a reload is a new visit and is allowed its own
        // opening, so it would grade nothing. This is the same session
        // re-mounting the same cover.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        await showCoverSurface(page, viewport);
      }
      await page.waitForTimeout(1500);
      const replayed = await coverState(page);
      check(`${label}/no-replay-for-the-same-cover-revision`, replayed.stage === false, replayed);
      check(
        `${label}/no-second-display-read-for-the-same-revision`,
        run.state.calls.length === callsAfterFirst,
        { before: callsAfterFirst, after: run.state.calls.length },
      );
      check(
        `${label}/remount-still-shows-the-canonical-original`,
        classify(await compositedColor(page)) === "original-cover",
        replayed,
      );

      // 3. Authority: an ordinary session read, and nothing else. The browser
      //    never speaks a worker credential and never touches a worker route.
      const display = run.state.calls[0];
      check(`${label}/display-read-is-a-plain-get`, display?.method === "GET", display?.method);
      check(
        `${label}/display-read-carries-no-bearer-authority`,
        display !== undefined && !("authorization" in display.headers)
          && !Object.keys(display.headers).some((name) => name.includes("worker")),
        Object.keys(display?.headers ?? {}),
      );
      check(
        `${label}/no-worker-route-is-reachable-from-the-browser`,
        run.state.calls.every((call) => !/\/(claim|jobs)\b/.test(new URL(call.url).pathname)),
        run.state.calls.map((call) => call.url),
      );
      check(`${label}/no-page-errors`, run.pageErrors.length === 0, run.pageErrors);
      await run.context.close();
    }

    // 4. A newer intent takes the surface at once, and the opening does not
    //    reclaim it when the renderer would have finished.
    {
      const run = await openCase(viewport);
      const { page } = run;
      await page.waitForFunction(
        () => document.querySelector(".living-atlas__active-media-reveal")
          ?.getAttribute("data-cover-reveal-phase") === "revealing",
        undefined,
        { timeout: 20_000 },
      );
      // A wheel over the cover: a real viewer intent that is deliberately not
      // a navigation, so what is graded here is the handoff itself rather than
      // Story taking the surface. Entering Story is case 7.
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, 40);
      const interrupted = await coverState(page);
      check(`${label}/intent-ends-the-opening-immediately`, interrupted.stage === false, interrupted);
      const interruptedColor = classify(await compositedColor(page));
      check(
        `${label}/interruption-lands-on-the-canonical-original`,
        interruptedColor === "original-cover",
        interruptedColor,
      );
      // Well past the reveal's own duration: completion cannot reclaim focus.
      await page.waitForTimeout(4000);
      const afterCompletion = await coverState(page);
      check(`${label}/completion-cannot-reclaim-the-surface`, afterCompletion.stage === false, afterCompletion);
      check(`${label}/interrupt-leaves-no-renderer`, afterCompletion.canvases === 0, afterCompletion);
      await run.context.close();
    }

    // 5. Every honest degradation keeps the canonical original immediately
    //    reachable, with nothing to interpret over the final pixels.
    const degradations = [
      {
        name: "missing-derivative",
        derivative: () => ({ status: 200, body: { derivative: null, reason: "NO_READY_DERIVATIVE" } }),
      },
      {
        name: "corrupt-derivative",
        derivative: () => ({ status: 200, body: derivativePayload({ width: 0, height: 0 }) }),
      },
      {
        name: "stale-cover",
        derivative: () => ({
          status: 200,
          body: derivativePayload({ sourceContentHash: "sha256:qa-previous-bytes" }),
        }),
      },
      {
        name: "superseded-cover-asset",
        derivative: () => ({
          status: 200,
          body: derivativePayload({ sourceMediaAssetId: "qa-asset-previous-cover" }),
        }),
      },
      {
        name: "unrecognised-preset",
        derivative: () => ({ status: 200, body: derivativePayload({ presetId: "not-a-preset" }) }),
      },
      {
        name: "no-display-capability",
        derivative: () => ({ status: 200, body: { ...derivativePayload(), display: null } }),
      },
      {
        name: "offline-worker-read-fails",
        derivative: () => ({ status: 503, error: "STORAGE_UNAVAILABLE" }),
      },
    ];
    for (const degradation of degradations) {
      const run = await openCase(viewport, degradation);
      const { page } = run;
      await page.waitForTimeout(2500);
      const state = await coverState(page);
      check(`${label}/${degradation.name}/no-opening`, state.stage === false, state);
      check(
        `${label}/${degradation.name}/original-cover-is-on-screen`,
        state.originalSrc === ORIGINAL_URL && state.originalComplete,
        state,
      );
      const color = classify(await compositedColor(page));
      check(`${label}/${degradation.name}/final-pixels-are-the-original`, color === "original-cover", color);
      check(`${label}/${degradation.name}/no-page-errors`, run.pageErrors.length === 0, run.pageErrors);
      await run.context.close();
    }

    // 6. Reduced Motion goes directly to the canonical original, and asks for
    //    no display capability it would never look at.
    {
      const run = await openCase(viewport, { reducedMotion: true });
      const { page } = run;
      await page.waitForTimeout(2500);
      const state = await coverState(page);
      check(`${label}/reduced-motion/no-opening`, state.stage === false, state);
      check(`${label}/reduced-motion/original-cover-is-on-screen`, state.originalSrc === ORIGINAL_URL, state);
      check(`${label}/reduced-motion/no-display-capability-is-minted`, run.state.calls.length === 0, run.state.calls);
      const color = classify(await compositedColor(page));
      check(`${label}/reduced-motion/final-pixels-are-the-original`, color === "original-cover", color);
      await run.context.close();
    }
  }

  // 7. Entering Story is a newer intent, and the opening yields the surface to
  //    it rather than playing on over a narrative the viewer asked for.
  {
    const viewport = VIEWPORTS[0];
    const run = await openCase(viewport);
    const { page } = run;
    await page.waitForFunction(
      () => document.querySelector(".living-atlas__active-media-reveal")
        ?.getAttribute("data-cover-reveal-phase") === "revealing",
      undefined,
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: /打开故事/ }).first().click();
    await page.locator(".journey-story").waitFor({ timeout: 20_000 });
    const duringStory = await page.evaluate(() => ({
      stage: Boolean(document.querySelector(".living-atlas__active-media-reveal")),
      canvasesInCover: document.querySelectorAll(".living-atlas__active-media canvas").length,
    }));
    check("story-entry/opening-yields-to-story", duringStory.stage === false, duringStory);
    check("story-entry/no-renderer-behind-story", duringStory.canvasesInCover === 0, duringStory);
    check("story-entry/no-page-errors", run.pageErrors.length === 0, run.pageErrors);
    await run.context.close();
  }
} catch (error) {
  // The evidence for everything that DID run still has to reach the artifact,
  // so the throw is recorded and re-raised after the file is written.
  thrown = error;
  check("lane/completed", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

await writeFile(
  `${artifactDir}/results.json`,
  `${JSON.stringify({ origin, results }, null, 2)}\n`,
  "utf8",
);
for (const row of results) console.log(JSON.stringify(row));

if (thrown) throw thrown;

if (failures.length > 0) {
  console.error(`\ncover reveal opening QA failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\ncover reveal opening QA passed: ${results.length} checks`);
