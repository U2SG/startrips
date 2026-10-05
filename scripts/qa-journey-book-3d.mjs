// 3D Journey Book browser QA: the rendered paper matches the geometry the
// product reports, on a deep book, on a desktop and on a phone.
//
// #622 shipped with no browser check of the book, and a table plane drawn above
// the deepest sheets hid the outer part of the first spread's left page (#630).
// This lane opens `?qaState=journey-book-3d` (40 sheets, 80 faces) and samples a
// real screenshot at coordinates derived from the face rects the book publishes
// in DEV (`data-qa-book` on the stage):
//
//   1. On the first spread the left page's outer margin, and on the last
//      interior spread the right page's outer margin, are paper, not table.
//   2. Under the tilted camera every settled page's rect matches the rendered
//      paper: paper just inside its outer, top and bottom edges, not paper just
//      outside (below the near edge, outside means past the page block).
//   3. The page block shows as a strip under the near edge of a thick stack.
//   4. No console error and no page error.
//
// Two sessions run it. Desktop (1440x1000, mouse) reads spreads in landscape
// and navigates with the footer buttons and the keyboard. Phone (390x844, DPR 3,
// touch) reads one page at a time in portrait: a real touch drag turns the
// cover, the camera pans between pages, and every check is repeated on the
// page in focus after its pan. The desktop mouse never moves over the stage
// while sampling, so no page edge is lifted by hover; only afterwards does it
// drag the front cover to save frames of its rigid turn. The phone session
// checks that a tap leaves no edge lifted.
//
// Expectations are fixed by the fixture: 40 sheets, quick_flipbook's sheet
// spacing and the camera tilt below.
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const artifactDir = "artifacts/journey-book-3d";
const SHEETS = 40;
const FACES = 80;
// journeyBook3dModel: BOOK_SHEET_SPACING and BOOK_CAMERA_TILT.
const SHEET_SPACING = 0.0012;
const TILT = (20 * Math.PI) / 180;
// Samples sit this far inside / outside an edge, clear of its antialiasing.
const INSIDE_PX = 3;
const OUTSIDE_PX = 4;
// The page block must be at least this tall on screen for check 3 to mean anything.
const MIN_BLOCK_PX = 5;
const PHOTOS = [
  "/artworks/china-handscroll.jpg",
  "/artworks/hokusai-wave.jpg",
  "/artworks/mughal-akbarnama.jpg",
  "/artworks/monet-water-lilies.jpg",
  "/artworks/egypt-coffin.jpg",
  "/artworks/greek-amphora.jpg",
];
const FIRST_ASSET = 5000;
// SwiftShader renders a frame of the book in hundreds of milliseconds and the
// scene advances a turn by at most 40 ms per frame, so one turn can take tens
// of seconds on a CI runner.
const SETTLE_TIMEOUT_MS = 120_000;

const checks = [];
let failed = false;
function record(name, detail, ok) {
  const row = { name, ...detail, failed: !ok };
  checks.push(row);
  console.log(JSON.stringify(row));
  if (!ok) failed = true;
}

// Lit paper and cloth are bright; the table is #020706, darker still under the
// contact shadow. Anything between is neither and fails both tests.
const isPaper = ([r, g, b]) => Math.min(r, g, b) >= 120;
const isCloth = ([r, g, b]) => Math.min(r, g, b) >= 60;
const isTable = ([r, g, b]) => Math.max(r, g, b) <= 60;
const isBlock = ([r, g, b]) => Math.max(r, g, b) >= 90;

/** Sheets in the stack under a settled side. */
function stackCount(side, spread) {
  return side === "left" || side === "closed-back" ? spread : SHEETS - spread;
}

/**
 * Edge probes for one face: outer edges (a closed cover has two), and the far
 * and near edges where the page lies flat (quick_flipbook curves it up nearer
 * the spine). The spine edge of an open page meets its neighbour and is skipped.
 */
function probes(state, side) {
  const rect = state.rects[side];
  const left = state.stage.left + rect.left;
  const right = left + rect.width;
  const top = state.stage.top + rect.top;
  const bottom = top + rect.height;
  const blockPx = stackCount(side, state.spread) * SHEET_SPACING * Math.sin(TILT) * state.pixelsPerUnit;
  const outerEdges = side === "left" ? [{ x: left, out: -1 }]
    : side === "right" ? [{ x: right, out: 1 }]
      : [{ x: left, out: -1 }, { x: right, out: 1 }];
  const flatXs = side === "left" ? [0.05, 0.1].map((f) => left + rect.width * f)
    : side === "right" ? [0.9, 0.95].map((f) => left + rect.width * f)
      : [0.1, 0.5, 0.9].map((f) => left + rect.width * f);
  const list = [];
  for (const edge of outerEdges) {
    for (const f of [0.3, 0.5, 0.7]) {
      const y = top + rect.height * f;
      list.push({ kind: "outer-in", x: edge.x - edge.out * INSIDE_PX, y });
      list.push({ kind: "outer-out", x: edge.x + edge.out * OUTSIDE_PX, y });
    }
  }
  for (const x of flatXs) {
    list.push({ kind: "top-in", x, y: top + INSIDE_PX });
    list.push({ kind: "top-out", x, y: top - OUTSIDE_PX });
    list.push({ kind: "bottom-in", x, y: bottom - INSIDE_PX });
    list.push({ kind: "bottom-out", x, y: bottom + blockPx + OUTSIDE_PX });
    if (blockPx >= MIN_BLOCK_PX) list.push({ kind: "block", x, y: bottom + blockPx / 2 });
  }
  return { list, rect, blockPx };
}

// The cover's goat (journeyBookGoatPull.ts): the fixture Journey, the device's
// played list, and the filmstrip times (ms into the performance).
const FIXTURE_JOURNEY_ID = "00000000-0000-4000-8000-000000000001";
const GOAT_PLAYED_KEY = "startrips.journeyBook3d.goatPull.played";
const FILMSTRIP_MS = [0, 400, 1000, 1600, 2200, 2800, 3400];
// The goat is quiet this long after the idle threshold before "no replay" is believed.
const GOAT_QUIET_MS = 2_500;
// An input must end the performance within this.
const INTERRUPT_BUDGET_MS = 200;
// ... and the goat must be gone from the screen within this of the press.
const LET_GO_BUDGET_MS = 400;
// A whole performance steps through about 85 book frames, each up to a second or two under SwiftShader.
const GOAT_PLAY_TIMEOUT_MS = 240_000;

/**
 * One browser context, its page and the helpers that read it. `goatPlayed`
 * marks the fixture's goat as already played on this device, so the lanes
 * that check settled geometry are not interrupted by its performance.
 */
async function openSession(browser, name, contextOptions, { query = "", goatPlayed = false } = {}) {
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(({ key, id, played }) => {
    if (played) localStorage.setItem(key, JSON.stringify([id]));
    // In-page stamp of the latest press as it is dispatched (ahead of the
    // book's own capture listener), for the interrupt budget.
    window.addEventListener("pointerdown", () => { window.__qaPointerDownAt = performance.now(); }, { capture: true });
  }, { key: GOAT_PLAYED_KEY, id: FIXTURE_JOURNEY_ID, played: goatPlayed });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => {
    const id = /\/assets\/([^/]+)\/read-url/.exec(new URL(route.request().url()).pathname)?.[1] ?? "";
    const index = Number.parseInt(id.slice(-12), 10) - FIRST_ASSET;
    if (!(index >= 0)) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ url: PHOTOS[index % PHOTOS.length], expiresAt: new Date(Date.now() + 900_000).toISOString() }),
    });
  });
  await page.goto(`${origin}/?qaState=journey-book-3d${query}`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-book-3d").waitFor({ state: "visible", timeout: 30_000 });

  /** The book's report the moment it rests with the reader on `face` (no picture wait: the goat may wake). */
  async function restingAt(face) {
    await page.waitForFunction((want) => {
      const raw = document.querySelector(".journey-book-3d__stage")?.dataset.qaBook;
      return raw ? JSON.parse(raw).face === want : false;
    }, face, { timeout: SETTLE_TIMEOUT_MS });
    return page.evaluate(() => {
      const stage = document.querySelector(".journey-book-3d__stage");
      const box = stage.getBoundingClientRect();
      return { ...JSON.parse(stage.dataset.qaBook), stage: { left: box.left, top: box.top, width: box.width, height: box.height } };
    });
  }

  /** What the goat reports (`data-goat-pull`), and whether it is on screen. */
  function goat() {
    return page.evaluate(() => {
      const stage = document.querySelector(".journey-book-3d__stage");
      const overlay = document.querySelector(".journey-book-3d__goat");
      const place = document.querySelector("[data-goat-place]");
      const state = JSON.parse(stage?.dataset.goatPull ?? "null");
      const shown = Boolean(overlay) && overlay.style.display !== "none" && Number(getComputedStyle(overlay).opacity) > 0.01;
      const stageBox = stage.getBoundingClientRect();
      const box = shown ? place.getBoundingClientRect() : null;
      return {
        ...state,
        shown,
        opacity: overlay ? Number(getComputedStyle(overlay).opacity) : 0,
        box: box ? { left: box.left - stageBox.left, top: box.top - stageBox.top, width: box.width, height: box.height } : null,
        pointerDownAt: window.__qaPointerDownAt ?? null,
      };
    });
  }

  async function waitForGoat(predicate, arg, timeout = SETTLE_TIMEOUT_MS) {
    await page.waitForFunction(predicate, arg, { timeout });
    return goat();
  }

  /** Two animation frames, so the last WebGL frame and overlay write are on screen. */
  const presented = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  /** Wait until the book has settled with the reader on `face`, then read what it reports. */
  async function settledAt(face) {
    await page.waitForFunction((want) => {
      const raw = document.querySelector(".journey-book-3d__stage")?.dataset.qaBook;
      return raw ? JSON.parse(raw).face === want : false;
    }, face, { timeout: SETTLE_TIMEOUT_MS });
    // Let pictures near the spread land so the evidence shows real pages; the
    // sampled margins are paper either way.
    await page.waitForTimeout(1_200);
    return page.evaluate(() => {
      const stage = document.querySelector(".journey-book-3d__stage");
      const box = stage.getBoundingClientRect();
      return { ...JSON.parse(stage.dataset.qaBook), stage: { left: box.left, top: box.top, width: box.width, height: box.height } };
    });
  }

  /** Screenshot at CSS scale and read the given viewport pixels back from it. */
  async function sample(label, points) {
    const png = await page.screenshot({ type: "png", scale: "css" });
    await writeFile(`${artifactDir}/${name}-${label}.png`, png);
    return page.evaluate(async ({ data, points: wanted }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return wanted.map(({ x, y }) => Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3));
    }, { data: png.toString("base64"), points });
  }

  async function checkAlignment(label, state, sides, paperTest) {
    const groups = sides.map((side) => ({ side, ...probes(state, side) }));
    const pixels = await sample(label, groups.flatMap((group) => group.list));
    let cursor = 0;
    for (const group of groups) {
      const bad = [];
      for (const probe of group.list) {
        const rgb = pixels[cursor++];
        const ok = probe.kind === "block" ? isBlock(rgb) : probe.kind.endsWith("-in") ? paperTest(rgb) : isTable(rgb);
        if (!ok) bad.push({ ...probe, x: Math.round(probe.x), y: Math.round(probe.y), rgb });
      }
      const alignment = bad.filter((probe) => probe.kind !== "block");
      record(`${name} ${label}: ${group.side} face rect matches the rendered page`, {
        rect: group.rect, probes: group.list.filter((probe) => probe.kind !== "block").length, bad: alignment,
      }, alignment.length === 0);
      const blocks = group.list.filter((probe) => probe.kind === "block");
      if (blocks.length) {
        const badBlocks = bad.filter((probe) => probe.kind === "block");
        record(`${name} ${label}: ${group.side} page block shows under the near edge`, {
          blockPx: Number(group.blockPx.toFixed(2)), probes: blocks.length, bad: badBlocks,
        }, badBlocks.length === 0);
      }
    }
  }

  /** Check 1: the outer margin of a page is paper all the way to its edge. */
  async function checkOuterMargin(label, state, side) {
    const rect = state.rects[side];
    const points = [];
    for (const f of [0.015, 0.03, 0.05]) {
      const x = state.stage.left + (side === "left" ? rect.left + rect.width * f : rect.left + rect.width * (1 - f));
      for (const g of [0.15, 0.3, 0.5, 0.7, 0.85]) points.push({ x, y: state.stage.top + rect.top + rect.height * g });
    }
    const pixels = await sample(`${label}-margin`, points);
    const bad = points.map((point, index) => ({ x: Math.round(point.x), y: Math.round(point.y), rgb: pixels[index] }))
      .filter((point) => !isPaper(point.rgb));
    record(`${name} ${label}: ${side} page's outer margin is paper, not table`, { rect, probes: points.length, bad }, bad.length === 0);
  }

  function recordErrors() {
    record(`${name}: no console or page errors`, { consoleErrors, pageErrors },
      consoleErrors.length === 0 && pageErrors.length === 0);
  }

  return { page, context, settledAt, restingAt, goat, waitForGoat, presented, checkAlignment, checkOuterMargin, recordErrors };
}

/** Desktop: spreads in landscape, mouse and keyboard. */
async function desktopSession(browser) {
  const session = await openSession(browser, "desktop", { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }, { goatPlayed: true });
  const { page } = session;
  try {
    const cover = await session.settledAt(0);
    record("desktop fixture: the book has 40 sheets in landscape", { sheets: cover.sheets, orientation: cover.orientation },
      cover.sheets === SHEETS && cover.sheets * 2 === FACES && cover.orientation === "landscape");
    await session.checkAlignment("cover", cover, ["closed-front"], isCloth);

    // First spread: the deep left page (#630).
    await page.locator('button[aria-label="下一页"]').click();
    const first = await session.settledAt(2);
    await session.checkOuterMargin("first-spread", first, "left");
    await session.checkAlignment("first-spread", first, ["left", "right"], isPaper);
    const offset = first.rects.left.top - first.rects.right.top;
    const expected = (SHEETS - 1) * SHEET_SPACING * Math.sin(TILT) * first.pixelsPerUnit;
    record("desktop first-spread: the deep left page rests lower on screen by its stack depth", {
      offset: Number(offset.toFixed(2)), expected: Number(expected.toFixed(2)),
    }, Math.abs(offset - expected) < 0.5);

    // Last interior spread: the deep right page.
    await page.locator(".journey-book-3d").focus();
    await page.keyboard.press("End");
    await session.settledAt(FACES - 1);
    await page.locator('button[aria-label="上一页"]').click();
    const last = await session.settledAt(FACES - 2);
    await session.checkOuterMargin("last-spread", last, "right");
    await session.checkAlignment("last-spread", last, ["left", "right"], isPaper);

    // Evidence, not a check: the front cover turning as a rigid board under a
    // held mouse drag (cover-turn-000..004.png). While the pointer holds the
    // cover the book's clock is paused, so each frame is a fixed pose. It runs
    // last because the mouse enters the stage here.
    await page.keyboard.press("Home");
    const closed = await session.settledAt(0);
    const coverRect = closed.rects["closed-front"];
    const grabX = closed.stage.left + coverRect.left + coverRect.width * 0.6;
    const grabY = closed.stage.top + coverRect.top + coverRect.height * 0.5;
    const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    for (const [index, fraction] of fractions.entries()) {
      await page.mouse.move(grabX - coverRect.width * fraction, grabY, { steps: 2 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await writeFile(`${artifactDir}/desktop-cover-turn-${String(index).padStart(3, "0")}.png`, await page.screenshot({ type: "png" }));
    }
    await page.mouse.up();
    record("desktop cover-turn: front cover drag frames saved for review", { fractions }, true);
  } catch (error) {
    record("desktop: session ran to completion", { error: error instanceof Error ? error.stack ?? error.message : String(error) }, false);
  } finally {
    session.recordErrors();
    await session.context.close();
  }
}

/**
 * Phone: one page at a time in portrait, real touch input through CDP (the
 * same browser-level injection `page.touchscreen.tap` uses, so pointer events
 * arrive as `pointerType: "touch"`).
 */
async function phoneSession(browser) {
  const session = await openSession(browser, "phone", {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    // Turns and pans settle in one frame, so a DPR 3 SwiftShader canvas stays
    // within budget; the drag itself is still driven by real touch moves.
    reducedMotion: "reduce",
  });
  const { page } = session;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
    type, touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y), id: 1 }],
  });
  try {
    const hover = await page.evaluate(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    record("phone: the emulated device has no fine hover pointer", { hover }, hover === false);

    const cover = await session.settledAt(0);
    record("phone fixture: the book has 40 sheets in portrait", { sheets: cover.sheets, orientation: cover.orientation },
      cover.sheets === SHEETS && cover.orientation === "portrait");
    await session.checkAlignment("cover", cover, ["closed-front"], isCloth);

    // Reduced motion: the cover's goat never wakes, and a tap on its mark
    // plays nothing (it is an ordinary tap on the cover's left third).
    await page.waitForTimeout(GOAT_QUIET_MS);
    const quiet = await session.goat();
    record("phone reduced motion: the goat never wakes on the closed cover", { status: quiet.status, shown: quiet.shown },
      quiet.status === "idle" && !quiet.shown);
    const mark = cover.goatMark;
    await touch("touchStart", cover.stage.left + mark.left + mark.width / 2, cover.stage.top + mark.top + mark.height / 2);
    await touch("touchEnd");
    await page.waitForTimeout(1_500);
    const tapped = await session.goat();
    const stillClosed = await session.restingAt(0);
    record("phone reduced motion: a tap on the goat mark plays nothing", { status: tapped.status, shown: tapped.shown, face: stillClosed.face },
      tapped.status === "idle" && !tapped.shown && stillClosed.face === 0);

    // A touch drag from the cover's right side to its left turns the cover;
    // the reader lands on the first page (the left page of spread 1).
    const rect = cover.rects["closed-front"];
    const y = cover.stage.top + rect.top + rect.height * 0.5;
    const from = cover.stage.left + rect.left + rect.width * 0.85;
    const to = cover.stage.left + rect.left + rect.width * 0.1;
    await touch("touchStart", from, y);
    for (let step = 1; step <= 12; step += 1) await touch("touchMove", from + ((to - from) * step) / 12, y);
    await touch("touchEnd");
    const first = await session.settledAt(1);
    record("phone: a touch drag turns the cover to the first page", { spread: first.spread, face: first.face },
      first.spread === 1 && first.face === 1);
    await session.checkOuterMargin("first-page", first, "left");
    await session.checkAlignment("first-page", first, ["left"], isPaper);

    // A tap on the step button pans to the facing page without turning paper,
    // and leaves no page edge lifted.
    await page.locator('button[aria-label="下一页"]').tap();
    const facing = await session.settledAt(2);
    await session.checkAlignment("first-spread-right-after-pan", facing, ["right"], isPaper);

    // Last interior spread: its right page, then the pan back to its left page.
    await page.locator(".journey-book-3d").focus();
    await page.keyboard.press("End");
    await session.settledAt(FACES - 1);
    await page.locator('button[aria-label="上一页"]').tap();
    const last = await session.settledAt(FACES - 2);
    await session.checkOuterMargin("last-page", last, "right");
    await session.checkAlignment("last-page", last, ["right"], isPaper);
    await page.locator('button[aria-label="上一页"]').tap();
    const lastLeft = await session.settledAt(FACES - 3);
    await session.checkAlignment("last-spread-left-after-pan", lastLeft, ["left"], isPaper);
  } catch (error) {
    record("phone: session ran to completion", { error: error instanceof Error ? error.stack ?? error.message : String(error) }, false);
  } finally {
    session.recordErrors();
    await session.context.close();
  }
}

/**
 * The cover's goat, frame by frame: the fixture's scrub hook holds the
 * performance at each filmstrip time (`goatPull=scrub`; the goat never wakes by
 * itself there), and each frame is saved for the owner's motion review.
 */
async function goatFilmstripSession(browser, name, contextOptions) {
  const session = await openSession(browser, `${name}-goat-film`, contextOptions, { query: "&goatPull=scrub" });
  const { page } = session;
  try {
    const cover = await session.restingAt(0);
    const mark = cover.goatMark;
    const frames = [];
    for (const [index, ms] of FILMSTRIP_MS.entries()) {
      await page.evaluate((elapsed) => window.__journeyBookGoatPull.scrub(elapsed), ms);
      await session.waitForGoat((want) => {
        const raw = document.querySelector(".journey-book-3d__stage")?.dataset.goatPull;
        return raw ? JSON.parse(raw).elapsedMs === want : false;
      }, ms, 60_000);
      // The first frame waits for the cover's repaint without its embossed goat.
      await page.waitForTimeout(index === 0 ? 800 : 250);
      await session.presented();
      const state = await session.goat();
      frames.push({ ms, progress: Number(state.progress.toFixed(4)), opacity: Number(state.opacity.toFixed(3)), box: state.box });
      await writeFile(`${artifactDir}/${name}-goat-pull-${String(index).padStart(3, "0")}.png`,
        await page.screenshot({ type: "png", scale: "css" }));
    }
    record(`${name} goat filmstrip: ${FILMSTRIP_MS.length} frames saved`, { frames }, frames.length === FILMSTRIP_MS.length);

    const [wake, , walking, tug1, tug2, , gone] = frames;
    // Wake: the live goat stands exactly where its emboss was stamped.
    const inside = wake.box && wake.box.left >= mark.left - 2 && wake.box.top >= mark.top - 2
      && wake.box.left + wake.box.width <= mark.left + mark.width + 2
      && wake.box.top + wake.box.height <= mark.top + mark.height + 2
      && wake.box.width >= mark.width * 0.5;
    record(`${name} goat filmstrip: the goat wakes over its embossed mark`, { mark, goat: wake.box }, Boolean(inside));
    record(`${name} goat filmstrip: it walks toward the fore-edge`, { mark, goat: walking.box },
      Boolean(walking.box) && walking.box.left > mark.left + mark.width);
    const awake = frames[1];
    record(`${name} goat filmstrip: awake, the goat has grown from its stamp`, { stamp: wake.box, awake: awake.box },
      Boolean(wake.box && awake.box) && awake.box.height >= wake.box.height * 1.35);
    // The cover lies flat until the grip, so the published plate rect holds.
    const plate = cover.coverPlate;
    const overlapping = frames.filter((frame) => frame.ms > 0 && frame.ms <= 1_000 && frame.box
      && frame.box.left < plate.left + plate.width && frame.box.left + frame.box.width > plate.left
      && frame.box.top < plate.top + plate.height && frame.box.top + frame.box.height > plate.top);
    record(`${name} goat filmstrip: the walk never crosses the tipped-in plate`, { plate, overlapping },
      Boolean(plate) && overlapping.length === 0);
    record(`${name} goat filmstrip: the cover lifts under the tugs and the goat rides its edge`, {
      tug1: tug1.progress, tug2: tug2.progress, tug1Bottom: tug1.box?.top + tug1.box?.height, tug2Bottom: tug2.box?.top + tug2.box?.height,
    }, tug1.progress > 0.01 && tug2.progress > tug1.progress && Boolean(tug1.box && tug2.box)
      && tug2.box.top + tug2.box.height < tug1.box.top + tug1.box.height - 2);
    record(`${name} goat filmstrip: the goat is gone as the cover turns on`, { last: gone }, gone.opacity < 0.05 && gone.progress > 0.55);
  } catch (error) {
    record(`${name} goat filmstrip: session ran to completion`, { error: error instanceof Error ? error.stack ?? error.message : String(error) }, false);
  } finally {
    session.recordErrors();
    await session.context.close();
  }
}

/**
 * The cover's goat live on a desktop: it wakes by itself on the closed cover,
 * a press ends it at once and the drag that press began turns the cover, it
 * does not wake again, a click on the mark replays it to the first spread,
 * and after a reload it stays asleep.
 *
 * The performance's clock steps with the book's frames (at most 40 ms each),
 * and a SwiftShader frame of the full desktop stage takes about 2 s on a CI
 * runner, so this session plays it on a smaller landscape stage.
 */
async function goatLiveSession(browser) {
  const session = await openSession(browser, "desktop-goat", { viewport: { width: 1024, height: 720 }, deviceScaleFactor: 1 });
  const { page } = session;
  const playing = (minElapsed) => {
    const raw = document.querySelector(".journey-book-3d__stage")?.dataset.goatPull;
    const state = raw ? JSON.parse(raw) : null;
    return state?.status === "playing" && state.elapsedMs >= minElapsed;
  };
  try {
    const cover = await session.restingAt(0);
    const rect = cover.rects["closed-front"];
    const mark = cover.goatMark;
    const started = await session.waitForGoat(playing, 0, 60_000);
    record("desktop goat: it wakes by itself on the closed cover", { status: started.status }, started.shown);

    // Mid-tug, a press interrupts; the drag it starts turns the cover.
    // Press during the first tug, with the cover lifted.
    await session.waitForGoat(playing, 1_500, SETTLE_TIMEOUT_MS);
    const y = cover.stage.top + rect.top + rect.height * 0.5;
    const from = cover.stage.left + rect.left + rect.width * 0.8;
    const to = cover.stage.left + rect.left + rect.width * 0.05;
    await page.mouse.move(from, y);
    // Record every frame's start and the goat's opacity in it, from just before the press.
    await page.evaluate(() => {
      window.__qaGoatFrames = [];
      const overlay = document.querySelector(".journey-book-3d__goat");
      const sample = (t) => {
        const visible = overlay.style.display !== "none";
        window.__qaGoatFrames.push({ t: Number(t.toFixed(1)), opacity: visible ? Number(getComputedStyle(overlay).opacity) : 0 });
        if (window.__qaGoatFrames.length < 400) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.down();
    const stopped = await session.goat();
    const reaction = stopped.endedAt !== null && stopped.endedAt !== undefined && stopped.pointerDownAt !== null
      ? stopped.endedAt - stopped.pointerDownAt : null;
    record("desktop goat: a press ends the performance within 200 ms", {
      status: stopped.status, reactionMs: reaction === null ? null : Number(reaction.toFixed(1)), progressAtPress: stopped.progress,
    }, stopped.status === "interrupted" && reaction !== null && reaction >= 0 && reaction <= INTERRUPT_BUDGET_MS);
    // The goat lets go at once. Every frame is sampled in page time (its own
    // start): from the press to the first frame without the goat, and no frame
    // later than the 400 ms deadline may still show it. Under SwiftShader a
    // frame can take longer than the deadline itself, so the first frame after
    // the press is recorded as well: when it is already past the deadline it
    // must already show the goat gone (the fade is timed from the input).
    const frames = await page.waitForFunction(({ pressAt, budget }) => {
      const seen = window.__qaGoatFrames ?? [];
      const after = seen.filter((frame) => frame.t >= pressAt);
      const gone = after.find((frame) => frame.opacity <= 0.01);
      if (!gone || after.at(-1).t < pressAt + budget) return false;
      const before = seen.filter((frame) => frame.t < pressAt).slice(-6);
      const gaps = before.slice(1).map((frame, index) => Number((frame.t - before[index].t).toFixed(1)));
      return {
        pressAt,
        goneAt: gone.t,
        firstFrameAfterMs: Number((after[0].t - pressAt).toFixed(1)),
        goneOnFirstFrame: gone === after[0],
        frameGapsBeforeMs: gaps,
        visibleAfterDeadline: after.filter((frame) => frame.t > pressAt + budget && frame.opacity > 0.01),
        frames: after.slice(0, 8),
      };
    }, { pressAt: stopped.pointerDownAt, budget: LET_GO_BUDGET_MS }, { timeout: 30_000 }).then((handle) => handle.jsonValue(), () => null);
    const disappearMs = frames ? Number((frames.goneAt - frames.pressAt).toFixed(1)) : null;
    record("desktop goat: the goat is gone by the first frame after 400 ms from the press, and never seen after it", {
      disappearMs, budgetMs: LET_GO_BUDGET_MS, firstFrameAfterMs: frames?.firstFrameAfterMs ?? null,
      frameGapsBeforeMs: frames?.frameGapsBeforeMs ?? null, goneOnFirstFrame: frames?.goneOnFirstFrame ?? null, visibleAfterDeadline: frames?.visibleAfterDeadline ?? null, frames: frames?.frames ?? null,
    }, Boolean(frames) && frames.visibleAfterDeadline.length === 0
      && (disappearMs <= LET_GO_BUDGET_MS || frames.goneOnFirstFrame));
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(from + ((to - from) * step) / 12, y);
    await page.mouse.up();
    await page.mouse.move(4, 4);
    const turned = await session.restingAt(2);
    const after = await session.goat();
    record("desktop goat: the cover stays the reader's; their drag turns it to the first spread", {
      spread: turned.spread, face: turned.face, goatShown: after.shown,
    }, turned.spread === 1 && turned.face === 2 && !after.shown);

    // Played once on this device: back on the cover it stays asleep.
    await page.locator(".journey-book-3d").focus();
    await page.keyboard.press("Home");
    await session.restingAt(0);
    await page.waitForTimeout(GOAT_QUIET_MS);
    const asleep = await session.goat();
    record("desktop goat: once played, it does not wake again on the cover", { status: asleep.status, shown: asleep.shown },
      asleep.status !== "playing" && !asleep.shown);

    // A click on the mark replays it, through to the first spread.
    await page.mouse.click(cover.stage.left + mark.left + mark.width / 2, cover.stage.top + mark.top + mark.height / 2);
    await page.mouse.move(4, 4);
    const replay = await session.waitForGoat(playing, 0, 60_000);
    record("desktop goat: a click on the goat mark replays it", { status: replay.status }, replay.status === "playing");
    const done = await session.waitForGoat(() => {
      const raw = document.querySelector(".journey-book-3d__stage")?.dataset.goatPull;
      return raw ? JSON.parse(raw).status === "done" : false;
    }, undefined, GOAT_PLAY_TIMEOUT_MS);
    const first = await session.settledAt(2);
    record("desktop goat: the performance leaves the book on the first spread", {
      status: done.status, spread: first.spread, face: first.face, goatShown: done.shown,
    }, first.spread === 1 && first.face === 2 && !done.shown);
    await session.checkOuterMargin("goat-first-spread", first, "left");
    await session.checkAlignment("goat-first-spread", first, ["left", "right"], isPaper);

    // Once per Journey per device: a reload does not replay it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await session.restingAt(0);
    await page.waitForTimeout(GOAT_QUIET_MS);
    const reloaded = await session.goat();
    record("desktop goat: after a reload it does not play again", { status: reloaded.status, shown: reloaded.shown },
      reloaded.status === "idle" && !reloaded.shown);
  } catch (error) {
    record("desktop goat: session ran to completion", { error: error instanceof Error ? error.stack ?? error.message : String(error) }, false);
  } finally {
    session.recordErrors();
    await session.context.close();
  }
}

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  await mkdir(artifactDir, { recursive: true });
  await desktopSession(browser);
  await phoneSession(browser);
  await goatFilmstripSession(browser, "desktop", { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await goatFilmstripSession(browser, "phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await goatLiveSession(browser);
} finally {
  await writeFile(`${artifactDir}/checks.json`, `${JSON.stringify(checks, null, 2)}\n`).catch(() => {});
  await browser.close();
}

if (failed) {
  console.error(`3D Journey Book QA failed: ${checks.filter((check) => check.failed).map((check) => check.name).join("; ")}`);
  process.exitCode = 1;
}
