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
// A THIRD colour, for the canonical original of the NEXT cover revision. The
// re-signed case below deliberately serves the same bytes under a new url, so
// without a distinct colour "the final image is the current revision's cover"
// would be indistinguishable from "the final image is the previous revision's
// cover", and the revision case would grade nothing.
const REPLACED_ORIGINAL_COLOR = { r: 46, g: 158, b: 82 };

const DERIVATIVE_URL = "https://qa-storage.invalid/cover-reveal/derivative.png?sig=qa-display";
const ORIGINAL_URL = "https://qa-storage.invalid/media/original.png?sig=qa-original";
// The same canonical original photograph, re-signed. The Atlas refreshes a
// signed read on its own timer, so the url under a mounted opening changes
// without the viewer doing anything at all.
const ORIGINAL_URL_RESIGNED = "https://qa-storage.invalid/media/original.png?sig=qa-original-2";
// The replacement cover bytes behind the SAME cover asset id, and the
// derivative the server generated from them.
const REPLACED_ORIGINAL_URL = "https://qa-storage.invalid/media/original-replaced.png?sig=qa-original-v2";
const REPLACED_DERIVATIVE_URL = "https://qa-storage.invalid/cover-reveal/derivative-replaced.png?sig=qa-display-v2";

const COVER_ASSET_ID = "qa-asset-cover";
const COVER_HASH = "sha256:qa-cover-bytes";
const REPLACED_COVER_HASH = "sha256:qa-replacement-bytes";
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
const REPLACED_ORIGINAL_PNG = solidPng(REPLACED_ORIGINAL_COLOR);

const results = [];
const failures = [];

function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
}

function journeyFixture({
  coverAssetId = COVER_ASSET_ID,
  contentHash = COVER_HASH,
  title = "水墨开场回归旅程",
} = {}) {
  return {
    id: JOURNEY_ID,
    atlasId: "qa-atlas",
    title,
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

function derivativePayload(overrides = {}, displayUrl = DERIVATIVE_URL) {
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
      url: displayUrl,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  };
}

/** The derivative the server pinned to whichever cover revision is current. */
function currentDerivativePayload(state) {
  return state.coverHash === REPLACED_COVER_HASH
    ? derivativePayload(
      { id: "qa-derivative-2", sourceContentHash: REPLACED_COVER_HASH },
      REPLACED_DERIVATIVE_URL,
    )
    : derivativePayload();
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
  await page.route("**/qa-storage.invalid/**", (route) => {
    const url = route.request().url();
    const body = url.includes("derivative")
      ? DERIVATIVE_PNG
      : url.includes("original-replaced") ? REPLACED_ORIGINAL_PNG : ORIGINAL_PNG;
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
      body,
    });
  });
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: [state.journey] }),
  }));
  // The owner edits the Journey, and the server answers with a cover whose
  // stored bytes have moved behind the SAME asset id. That is a new cover
  // revision, and everything downstream - the pin, the derivative and the
  // canonical original read - has to move with it.
  await page.route(`**/api/journeys/${JOURNEY_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ journey: state.journey }),
      });
      return;
    }
    state.coverHash = REPLACED_COVER_HASH;
    state.journey = journeyFixture({
      contentHash: REPLACED_COVER_HASH,
      title: JSON.parse(route.request().postData() ?? "{}").title ?? state.journey.title,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ journey: state.journey }),
    });
  });
  await page.route("**/api/uploads/assets/*/read-url", (route) => {
    state.originalReads += 1;
    if (state.coverHash === REPLACED_COVER_HASH) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: REPLACED_ORIGINAL_URL,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
      });
    }
    // An already-expired answer puts the client's own refresh timer on its one
    // second floor - the #200 case of a grant with seconds left - so the
    // canonical cover is genuinely re-signed inside one reveal.
    const expiring = state.expireOriginalRead === true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: expiring && state.originalReads > 1 ? ORIGINAL_URL_RESIGNED : ORIGINAL_URL,
        expiresAt: new Date(Date.now() + (expiring ? -10_000 : 10 * 60 * 1000)).toISOString(),
      }),
    });
  });
  await page.route("**/api/cover-reveal/**", async (route) => {
    const request = route.request();
    state.calls.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
    });
    // Holding the answer open is how the PENDING window becomes observable:
    // the guard against an opening starting behind a viewer who has already
    // moved on lives in that window, not in the mounted opening.
    if (state.gate) await state.gate;
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

/**
 * Record, in the page, every image identity the renderer reports it composited.
 *
 * `data-cover-reveal-composited` is written by `CoverRevealStage` from the
 * renderer's own frame reports, so the sequence this collects is the opening's
 * real frame identity. Collecting it inside the page is what makes the verdict
 * independent of when a screenshot round-trip comes back: a sample raced
 * against the animation can miss the opening entirely, a mutation record
 * cannot. The array also outlives the stage, which the product unmounts as
 * soon as the opening settles.
 */
async function recordCompositedFrames(page) {
  await page.addInitScript(() => {
    const composited = [];
    window.__qaCompositedFrames = composited;
    const note = (node) => {
      if (!(node instanceof Element)) return;
      const identity = node.getAttribute("data-cover-reveal-composited");
      // Empty means the renderer has composited nothing yet, and a repeat is
      // the same identity across many frames.
      if (!identity || composited[composited.length - 1] === identity) return;
      composited.push(identity);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") note(record.target);
        else record.addedNodes.forEach(note);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-cover-reveal-composited"],
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
async function compositedColor(page, at = { x: 0.5, y: 0.5 }) {
  const figure = page.locator(".living-atlas__active-media");
  const shot = await figure.screenshot({ type: "png" });
  return page.evaluate(async ({ base64, at: point }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(
      bitmap,
      Math.floor(bitmap.width * point.x),
      Math.floor(bitmap.height * point.y),
      1, 1, 0, 0, 1, 1,
    );
    bitmap.close();
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  }, { base64: shot.toString("base64"), at });
}

/**
 * Where to probe a reveal that is still running.
 *
 * Every preset's mask grows from its origin, which is the centre of the stage
 * for `ink-bloom`, so the centre is the FIRST pixel to become the cover and
 * therefore the worst possible probe for "what did this open with". The corner
 * is the last region to convert. It is also above the figure's own bottom
 * gradient, which starts at 46% height.
 */
const REVEAL_PROBE = { x: 0.1, y: 0.12 };

function classify(sample) {
  const distance = (color) => Math.abs(sample.r - color.r)
    + Math.abs(sample.g - color.g) + Math.abs(sample.b - color.b);
  if (distance(DERIVATIVE_COLOR) <= 40) return "derivative";
  if (distance(ORIGINAL_COLOR) <= 40) return "original-cover";
  if (distance(REPLACED_ORIGINAL_COLOR) <= 40) return "replaced-original-cover";
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

async function openCase(viewport, {
  derivative,
  reducedMotion = false,
  gated = false,
  expireOriginalRead = false,
  journey = journeyFixture(),
} = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    ...(reducedMotion ? { reducedMotion: "reduce" } : {}),
  });
  const page = await context.newPage();
  await recordCompositedFrames(page);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const imageRequests = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://qa-storage.invalid/")) imageRequests.push(request.url());
  });
  const state = {
    journey,
    calls: [],
    gate: null,
    originalReads: 0,
    expireOriginalRead,
    coverHash: journey.media[0]?.contentHash ?? COVER_HASH,
    derivative: derivative ?? (() => ({ status: 200, body: currentDerivativePayload(state) })),
  };
  if (gated) {
    state.gate = new Promise((resolve) => { state.openGate = resolve; });
  }
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
      // Each sampled colour is bracketed by the renderer's own report of what
      // it was compositing, so a sample the reveal moved through can be told
      // apart from one taken wholly inside a single frame identity.
      const opened = [];
      const samples = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const before = await page.evaluate(() => {
          const stage = document.querySelector(".living-atlas__active-media-reveal");
          return {
            revealing: stage?.getAttribute("data-cover-reveal-phase") === "revealing",
            composited: stage?.getAttribute("data-cover-reveal-composited") ?? "",
          };
        });
        if (!before.revealing) break;
        const color = classify(await compositedColor(page, REVEAL_PROBE));
        const after = await page.evaluate(() => document.querySelector(
          ".living-atlas__active-media-reveal",
        )?.getAttribute("data-cover-reveal-composited") ?? "");
        opened.push(color);
        samples.push({ composited: before.composited === after ? before.composited : "moved", color });
      }
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

      // Graded here, once the opening is provably over, on what the renderer
      // reported it composited rather than on what a screenshot happened to
      // catch: `opened` above is a race by construction, because a slow runner
      // can finish the whole reveal before its first sample returns and then
      // grade the settled cover as the opening frame (#454). The sampled
      // colours stay attached, so which cover identity was actually on screen
      // is still reported.
      const composited = await page.evaluate(() => window.__qaCompositedFrames ?? []);
      // The rendered pixels stay in the first-frame verdict, but each sample is
      // only held to what its reported identity actually determines. A sample
      // the renderer spent entirely on `generated-first` composited nothing but
      // the opening asset, so it must LOOK like it. A `blend` sample cannot be
      // pinned to a colour at all: `blend` is every progress strictly between 0
      // and 1, and the mask reaches the probed corner at a progress that
      // depends on the stage's aspect, so on the narrow portrait stage the
      // corner is already the canonical cover while progress is still short of
      // 1 (#454). What a blend sample still proves is DIRECTION: the mask only
      // ever grows, so once the probe has converted to the canonical cover it
      // can never show the opening asset again, and a swapped or reversed draw
      // is caught by that. A sample whose window the reveal moved through
      // grades nothing, because grading it is exactly the defect.
      const stable = samples.filter((sample) => sample.composited !== "moved"
        && sample.composited !== "");
      const openingFrames = stable.filter((sample) => sample.composited === "generated-first");
      const converted = stable.findIndex((sample) => sample.color === "original-cover");
      const reopened = converted !== -1
        && stable.slice(converted + 1).some((sample) => sample.color === "derivative");
      check(
        `${label}/first-frame-is-the-derivative`,
        composited[0] === "generated-first"
          && openingFrames.every((sample) => sample.color === "derivative")
          && !reopened,
        { composited, opened, samples },
      );
      check(
        `${label}/the-reveal-actually-transitions`,
        composited.includes("generated-first") && composited.at(-1) !== "generated-first",
        { composited, opened, samples },
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
      // Bounded rather than zero-frame: the yield is a React commit, and the
      // shortest preset still runs for 3.4s, so one second separates "yielded
      // at once" from "played on to the end" without grading a paint deadline.
      let yielded = true;
      try {
        await page.waitForFunction(
          () => document.querySelector(".living-atlas__active-media-reveal") === null,
          undefined,
          { timeout: 1000 },
        );
      } catch {
        yielded = false;
      }
      const interrupted = await coverState(page);
      check(`${label}/intent-ends-the-opening-immediately`, yielded && interrupted.stage === false, interrupted);
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

  // 7. An intent DURING the pending read. The answer must not start a reveal
  //    behind a viewer who has already moved on, and must not allocate a
  //    graphics context for one.
  {
    const viewport = VIEWPORTS[0];
    const run = await openCase(viewport, { gated: true });
    const { page } = run;
    await page.waitForFunction(() => document.querySelector(".living-atlas__active-media") !== null,
      undefined, { timeout: 20_000 });
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 40);
    await page.keyboard.press("Shift");
    run.state.openGate();
    await page.waitForTimeout(2500);
    const afterAnswer = await coverState(page);
    check("pending-read/intent-supersedes-an-answer-in-flight", afterAnswer.stage === false, afterAnswer);
    check("pending-read/no-graphics-context-is-allocated", afterAnswer.canvases === 0, afterAnswer);
    check(
      "pending-read/canonical-original-is-on-screen",
      afterAnswer.originalSrc === ORIGINAL_URL && classify(await compositedColor(page)) === "original-cover",
      afterAnswer,
    );
    check("pending-read/no-page-errors", run.pageErrors.length === 0, run.pageErrors);
    await run.context.close();
  }

  // 8. Entering Story is a newer intent, and the opening yields the surface to
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

  // 9. The canonical original is re-signed WHILE the opening is on screen. The
  //    reveal runs with the pair it opened with: a re-signed read of the same
  //    photograph is not a new cover revision and must not restart it.
  {
    const viewport = VIEWPORTS[0];
    const run = await openCase(viewport, { expireOriginalRead: true });
    const { page } = run;
    await page.waitForFunction(
      () => document.querySelector(".living-atlas__active-media-reveal")
        ?.getAttribute("data-cover-reveal-phase") === "revealing",
      undefined,
      { timeout: 20_000 },
    );
    // Sampled through the whole reveal, because a restart is only visible as the
    // derivative coming BACK after the cover had begun to take over.
    const samples = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const stage = await page.evaluate(() => document.querySelector(
        ".living-atlas__active-media-reveal",
      )?.getAttribute("data-cover-reveal-phase") ?? null);
      if (stage === null) break;
      samples.push(classify(await compositedColor(page, REVEAL_PROBE)));
    }
    const leftTheDerivative = samples.findIndex((sample) => sample !== "derivative");
    check(
      "resigned-original/the-original-read-actually-refreshed",
      run.state.originalReads > 1,
      run.state.originalReads,
    );
    check(
      "resigned-original/the-reveal-never-restarts",
      leftTheDerivative >= 0 && !samples.slice(leftTheDerivative).includes("derivative"),
      samples,
    );
    // This case keeps re-signing on a one second cycle, so the canonical image
    // is briefly absent while each refresh is in flight. Wait for the stage to
    // be gone AND a fresh read to be on screen before grading the final state.
    await page.waitForFunction(
      () => document.querySelector(".living-atlas__active-media-reveal") === null
        && document.querySelector(".living-atlas__active-media img") !== null,
      undefined,
      { timeout: 40_000 },
    );
    const settled = await coverState(page);
    check("resigned-original/settles-on-the-canonical-original", settled.stage === false, settled);
    check(
      "resigned-original/the-fresh-signed-read-is-the-final-image",
      settled.originalSrc === ORIGINAL_URL_RESIGNED,
      settled,
    );
    check("resigned-original/no-renderer-survives", settled.canvases === 0, settled);
    check("resigned-original/no-page-errors", run.pageErrors.length === 0, run.pageErrors);
    await run.context.close();
  }

  // 10. The CURRENT cover revision changes under a mounted opening, with the
  //     cover asset id unchanged. #379 is explicit that old cover data cannot
  //     attach to a new revision, and the same asset id carrying replacement
  //     bytes is exactly the case where that is easy to get wrong: the opening
  //     identity moves while a read keyed only by the asset id would not.
  //
  //     Driven at the real product surface. The owner opens the Journey, edits
  //     it, and saves; the Atlas refreshes and the server reports a cover whose
  //     stored bytes have moved. Entering Story is itself a newer intent, so the
  //     first revision's opening is already gone before the edit - what is
  //     graded here is the SECOND revision's opening and the pixels it settles
  //     onto, not the handoff, which is case 4 and case 8.
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
    const readsBeforeReplacement = run.state.originalReads;
    const callsBeforeReplacement = run.state.calls.length;
    // Marks the exact DOM node the cover figure is mounted on, from the page
    // rather than from product code. If the surface were torn down and rebuilt
    // across this flow, its canonical read would restart for that reason alone
    // and every assertion below would hold whether or not the read is keyed by
    // the cover revision - i.e. the case would grade nothing. The marker
    // surviving is what makes "a fresh read was issued BECAUSE the revision
    // moved" the only reading left.
    await page.evaluate(() => {
      document.querySelector(".living-atlas__active-media").dataset.qaMountMark = "cover-revision";
    });

    await page.locator(".living-atlas__active-hit-area").click();
    await page.locator(".journey-story").waitFor({ timeout: 20_000 });
    await page.locator(".journey-story").getByRole("button", { name: "编辑故事", exact: true }).click();
    await page.getByRole("button", { name: "编辑旅程" }).click();
    await page.locator(".journey-composer").waitFor({ timeout: 20_000 });
    await page.locator(".journey-title-field input").fill("换过封面的旅程");
    await page.getByRole("button", { name: "保存修改" }).click();
    // The save has no media, so the composer closes itself and hands the
    // viewer back to the cover surface - now on the next cover revision.
    await page.locator(".journey-composer").waitFor({ state: "detached", timeout: 20_000 });
    await page.locator(".living-atlas__active-media").waitFor({ timeout: 20_000 });

    const stillTheSameMount = await page.evaluate(() => document.querySelector(
      ".living-atlas__active-media",
    )?.dataset.qaMountMark ?? null);
    check(
      "cover-revision-change/the-cover-surface-was-never-remounted",
      stillTheSameMount === "cover-revision",
      stillTheSameMount,
    );
    check(
      "cover-revision-change/a-fresh-canonical-read-is-issued-for-the-new-revision",
      run.state.originalReads > readsBeforeReplacement
        && run.imageRequests.includes(REPLACED_ORIGINAL_URL),
      { before: readsBeforeReplacement, after: run.state.originalReads },
    );

    // The new revision buys its own opening: a different identity, so the
    // once-per-revision ledger does not suppress it.
    await page.waitForFunction(
      () => document.querySelector(".living-atlas__active-media-reveal")
        ?.getAttribute("data-cover-reveal-phase") === "revealing",
      undefined,
      { timeout: 20_000 },
    );
    check(
      "cover-revision-change/the-new-revision-asks-for-its-own-derivative",
      run.state.calls.length > callsBeforeReplacement
        && run.imageRequests.includes(REPLACED_DERIVATIVE_URL),
      { before: callsBeforeReplacement, after: run.state.calls.length },
    );
    // Sampled across the whole second opening: the previous revision's cover
    // bytes must not appear in it at any point, which is what a canonical read
    // still pinned to the old revision would put on screen.
    const samples = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const stage = await page.evaluate(() => document.querySelector(
        ".living-atlas__active-media-reveal",
      )?.getAttribute("data-cover-reveal-phase") ?? null);
      if (stage === null) break;
      samples.push(classify(await compositedColor(page, REVEAL_PROBE)));
    }
    check("cover-revision-change/the-new-opening-starts-on-its-own-derivative",
      samples[0] === "derivative", samples);
    check(
      "cover-revision-change/the-previous-cover-bytes-never-appear",
      !samples.includes("original-cover"),
      samples,
    );

    await page.waitForFunction(
      () => document.querySelector(".living-atlas__active-media-reveal") === null
        && document.querySelector(".living-atlas__active-media img") !== null,
      undefined,
      { timeout: 40_000 },
    );
    const settled = await coverState(page);
    const settledColor = classify(await compositedColor(page));
    check(
      "cover-revision-change/settles-on-the-new-canonical-original",
      settledColor === "replaced-original-cover",
      settledColor,
    );
    check(
      "cover-revision-change/the-final-image-is-the-new-revisions-read",
      settled.originalSrc === REPLACED_ORIGINAL_URL,
      settled,
    );
    check("cover-revision-change/no-renderer-survives", settled.canvases === 0, settled);
    check("cover-revision-change/no-page-errors", run.pageErrors.length === 0, run.pageErrors);
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
