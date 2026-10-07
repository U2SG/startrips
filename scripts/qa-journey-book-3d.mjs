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
//   5. Desktop: while a sheet is in flight the camera pulls back by at most
//      MAX_PULLBACK of the rest frame's height, and the sheet passes the canvas
//      top by no more than that cap implies: under the hover lift of a page
//      edge, at several progresses of a held drag across a sheet of paper, and
//      through the front cover's turn. The scene reports the highest point of
//      the sheet's deformed geometry and both frames in DEV
//      (`data-qa-book-flight`); a hover must not visibly pull the camera back.
//   6. Desktop: the same rule holds at every rendered frame of an automatic
//      turn (the footer button) of the rigid front cover and of a sheet of
//      paper, within 1% of the stage, while the camera moves; frames of the
//      cover's turn are saved as evidence (desktop-auto-*.png).
//
// Two sessions run it. Desktop (1440x1000, mouse) reads spreads in landscape
// and navigates with the footer buttons and the keyboard. Phone (390x844, DPR 3,
// touch) reads one page at a time in portrait: a real touch drag turns the
// cover, the camera pans between pages, and every check is repeated on the
// page in focus after its pan. The desktop mouse never moves over the stage
// while sampling, so no page edge is lifted by hover; only afterwards does it
// hover and drag (check 5) and drag the front cover to save frames of its
// rigid turn. The phone session
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
const TILT = (15 * Math.PI) / 180;
// journeyBook3dModel: MAX_PULLBACK, the live frame's height over the rest
// frame's, minus 1, may not exceed it while a sheet is in flight.
const MAX_PULLBACK = 0.08;
// Float and rounding slack on the pull-back fraction and the overshoot (px).
const PULLBACK_TOLERANCE = 0.002;
const OVERSHOOT_TOLERANCE_PX = 1;
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

/** One browser context, its page and the helpers that read it. */
async function openSession(browser, name, contextOptions) {
  const context = await browser.newContext(contextOptions);
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
  await page.goto(`${origin}/?qaState=journey-book-3d`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-book-3d").waitFor({ state: "visible", timeout: 30_000 });

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

  /**
   * Wait until the scene has rendered the book at `progress` (within `tolerance`)
   * with the camera's damped follow landed on its frame, and read where the
   * sheet in flight reaches (`data-qa-book-flight`).
   */
  async function flightAt(progress, tolerance) {
    await page.waitForFunction(({ want, tol }) => {
      const raw = document.querySelector(".journey-book-3d__stage")?.dataset.qaBookFlight;
      if (!raw) return false;
      const flight = JSON.parse(raw);
      return Math.abs(flight.progress - want) <= tol && !flight.following;
    }, { want: progress, tol: tolerance }, { timeout: SETTLE_TIMEOUT_MS });
    return page.evaluate(() => JSON.parse(document.querySelector(".journey-book-3d__stage").dataset.qaBookFlight));
  }

  return { page, context, settledAt, flightAt, checkAlignment, checkOuterMargin, recordErrors };
}

/**
 * Check 5: the camera pulls back by at most MAX_PULLBACK, and the sheet in
 * flight passes the canvas top by no more than the cap implies. The scene
 * measures the highest point of the sheet's deformed geometry (curl included)
 * and reports it with the live and rest frames, in screen-up world units.
 *
 * Pull-back: the live frame's height over the rest frame's, minus 1.
 * Overshoot: how far the sheet rises above the live frame's top, in stage px.
 * Its bound: how far the sheet rises above the top of a frame pulled back
 * exactly to the cap (the rest frame's bottom plus (1 + MAX_PULLBACK) times its
 * height; a frame taller than the rest frame has no slack), at that frame's
 * scale, and 0 when it does not. The desktop stage is wide enough that the
 * rest frame itself has no slack either.
 */
const flights = [];
function recordFlight(label, flight) {
  const restHeight = flight.rest.top - flight.rest.bottom;
  const liveHeight = flight.live.top - flight.live.bottom;
  const pullBack = liveHeight / restHeight - 1;
  const capHeight = (1 + MAX_PULLBACK) * restHeight;
  const overshootPx = flight.sheetTop === null ? null : (flight.sheetTop - flight.live.top) * (flight.cssHeight / liveHeight);
  const boundPx = flight.sheetTop === null ? null
    : Math.max(0, flight.sheetTop - (flight.rest.bottom + capHeight)) * (flight.cssHeight / capHeight);
  if (overshootPx !== null) flights.push({ pullBack, overshootPx });
  record(`desktop ${label}: the camera pulls back at most ${MAX_PULLBACK * 100}% and the sheet passes the top only as far as the cap allows`, {
    progress: Number(flight.progress.toFixed(4)),
    pullBack: Number(pullBack.toFixed(4)),
    pullBackPx: Number(flight.pullBackPx.toFixed(2)),
    overshootPx: overshootPx === null ? null : Number(overshootPx.toFixed(2)),
    boundPx: boundPx === null ? null : Number(boundPx.toFixed(2)),
  }, overshootPx !== null && pullBack <= MAX_PULLBACK + PULLBACK_TOLERANCE
    && overshootPx <= boundPx + OVERSHOOT_TOLERANCE_PX);
}

/** Desktop hover lift and a held drag across one interior sheet of paper. */
async function checkFlight(session) {
  const { page } = session;
  await page.mouse.move(0, 0);
  await page.keyboard.press("Home");
  await session.settledAt(0);
  await page.locator('button[aria-label="下一页"]').click();
  const spread = await session.settledAt(2);
  const rect = spread.rects.right;
  const centerY = spread.stage.top + rect.top + rect.height / 2;
  const outerX = spread.stage.left + rect.left + rect.width;

  // The pointer resting on the right page's outer edge lifts it (EDGE_LIFT).
  await page.mouse.move(outerX - 8, centerY);
  const hover = await session.flightAt(1 + EDGE_LIFT, 1e-6);
  recordFlight("hover", hover);
  // The rest frame already holds the uncurled hover edge; the paper's twist
  // may add a hair, but the camera must not visibly pump (under 1% of the stage).
  record("desktop hover: the lifted edge leaves the camera at rest", {
    pullBackPx: Number(hover.pullBackPx.toFixed(2)), limitPx: Number((spread.stage.height * 0.01).toFixed(2)),
  }, hover.pullBackPx >= 0 && hover.pullBackPx <= spread.stage.height * 0.01);

  // Off the edge it lays back down; then a held drag turns the sheet by
  // `fraction` of the page width the book reports.
  const grabX = spread.stage.left + rect.left + rect.width * 0.6;
  await page.mouse.move(grabX, centerY);
  await session.flightAt(1, 0);
  await session.settledAt(2);
  await page.mouse.down();
  for (const fraction of DRAG_FRACTIONS) {
    await page.mouse.move(grabX - rect.width * fraction, centerY, { steps: 2 });
    recordFlight(`drag ${fraction}`, await session.flightAt(1 + fraction, 0.01));
  }
  await page.mouse.up();
  await session.settledAt(4);
  await page.mouse.move(0, 0);
}

const EDGE_LIFT = 0.055;
const DRAG_FRACTIONS = [0.1, 0.25, 0.5, 0.75, 0.9];
// Check 6: an automatic turn may crop the sheet by its held-pose bound plus this
// share of the stage while the camera moves.
const DYNAMIC_OVERSHOOT_STAGE_SHARE = 0.01;
// Frames of a turn that must be sampled with the camera still easing, so the
// dynamic check cannot pass on a turn the camera never moved through.
const MIN_FOLLOWING_FRAMES = 4;

/**
 * Check 6: automatic turns, every rendered frame. The scene feeds the DEV probe
 * (`window.__qaJourneyBookFlight`) each frame's flight readout and captures
 * the canvas at the frame of maximum overshoot and at `marks`.
 *
 * Every frame with a sheet in flight under the automatic turn is asserted:
 * the pull-back stays at or under MAX_PULLBACK, and the overshoot stays at or
 * under the turn's held-pose bound at the cap (the largest per-frame cap
 * bound over the turn, as in check 5) plus 1% of the stage height.
 */
const dynamicTurns = [];
async function checkAutoTurn(session, label, from, to, marks) {
  const { page } = session;
  await page.evaluate((wanted) => {
    window.__qaJourneyBookFlight = { frames: [], marks: wanted, shots: {}, maxOvershootPx: -Infinity };
  }, marks);
  await page.locator('button[aria-label="下一页"]').click();
  await session.settledAt(to);
  const probe = await page.evaluate(() => {
    const value = window.__qaJourneyBookFlight;
    delete window.__qaJourneyBookFlight;
    return value;
  });
  for (const [shot, { progress, dataUrl }] of Object.entries(probe.shots)) {
    const name = `desktop-auto-${label}-${shot}.png`;
    await writeFile(`${artifactDir}/${name}`, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
    console.log(JSON.stringify({ evidence: name, progress: Number(progress.toFixed(4)) }));
  }
  const frames = probe.frames.filter((frame) => frame.sheetTop !== null && frame.auto);
  const stageHeight = frames[0]?.cssHeight ?? 0;
  const measured = frames.map((frame) => {
    const restHeight = frame.rest.top - frame.rest.bottom;
    const liveHeight = frame.live.top - frame.live.bottom;
    const capHeight = (1 + MAX_PULLBACK) * restHeight;
    return {
      progress: frame.progress,
      following: frame.following,
      pullBack: liveHeight / restHeight - 1,
      overshootPx: (frame.sheetTop - frame.live.top) * (frame.cssHeight / liveHeight),
      heldBoundPx: Math.max(0, frame.sheetTop - (frame.rest.bottom + capHeight)) * (frame.cssHeight / capHeight),
    };
  });
  const boundPx = measured.length ? Math.max(...measured.map((frame) => frame.heldBoundPx)) : 0;
  const limitPx = boundPx + DYNAMIC_OVERSHOOT_STAGE_SHARE * stageHeight;
  const bad = measured.filter((frame) => frame.pullBack > MAX_PULLBACK + PULLBACK_TOLERANCE || frame.overshootPx > limitPx);
  const following = measured.filter((frame) => frame.following).length;
  const maxDynamicPullBack = measured.length ? Math.max(...measured.map((frame) => frame.pullBack)) : null;
  const maxDynamicOvershootPx = measured.length ? Math.max(...measured.map((frame) => frame.overshootPx)) : null;
  dynamicTurns.push({ maxDynamicPullBack, maxDynamicOvershootPx, boundPx, limitPx });
  const round = (value, digits) => (value === null ? null : Number(value.toFixed(digits)));
  record(`desktop auto-turn ${label}: every frame pulls back at most ${MAX_PULLBACK * 100}% and crops at most the held-pose bound plus 1% of the stage`, {
    from, to,
    frames: measured.length, followingFrames: following, minFollowingFrames: MIN_FOLLOWING_FRAMES,
    maxDynamicPullBack: round(maxDynamicPullBack, 4),
    maxDynamicOvershootPx: round(maxDynamicOvershootPx, 2),
    heldBoundPx: round(boundPx, 2), limitPx: round(limitPx, 2),
    shots: Object.keys(probe.shots),
    bad: bad.slice(0, 8).map((frame) => ({ ...frame, progress: round(frame.progress, 4), pullBack: round(frame.pullBack, 4), overshootPx: round(frame.overshootPx, 2), heldBoundPx: round(frame.heldBoundPx, 2) })),
  }, measured.length > 0 && following >= MIN_FOLLOWING_FRAMES && bad.length === 0
    && probe.frames.length < 4096 && Object.keys(probe.shots).length >= 1 + marks.length);
}

/** Desktop: spreads in landscape, mouse and keyboard. */
async function desktopSession(browser) {
  const session = await openSession(browser, "desktop", { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
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

    // The mouse enters the stage from here on.
    await checkFlight(session);

    // The front cover turning as a rigid board under a held mouse drag
    // (cover-turn-000..004.png), each pose also checked against the cap.
    // While the pointer holds the cover the book's clock is paused, so each
    // frame is a fixed pose.
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
      recordFlight(`cover-turn ${fraction}`, await session.flightAt(fraction, 0.01));
      await writeFile(`${artifactDir}/desktop-cover-turn-${String(index).padStart(3, "0")}.png`, await page.screenshot({ type: "png" }));
    }
    await page.mouse.up();
    await page.mouse.move(0, 0);
    record("desktop cover-turn: front cover drag frames saved for review", { fractions }, true);

    // Check 6: automatic turns from the footer button, frame by frame: the
    // rigid front cover, then a sheet of paper.
    await page.keyboard.press("Home");
    await session.settledAt(0);
    await checkAutoTurn(session, "cover", 0, 2, [0.25, 0.5, 0.75]);
    await checkAutoTurn(session, "paper", 2, 4, []);
    record("desktop auto-turns: dynamic maxima", {
      maxDynamicPullBack: Number(Math.max(...dynamicTurns.map((turn) => turn.maxDynamicPullBack ?? -Infinity)).toFixed(4)),
      maxDynamicOvershootPx: Number(Math.max(...dynamicTurns.map((turn) => turn.maxDynamicOvershootPx ?? -Infinity)).toFixed(2)),
      boundsPx: dynamicTurns.map((turn) => Number(turn.boundPx.toFixed(2))),
      limitsPx: dynamicTurns.map((turn) => Number(turn.limitPx.toFixed(2))),
    }, dynamicTurns.length === 2);
    const maxPullBack = flights.length ? Math.max(...flights.map((flight) => flight.pullBack)) : null;
    const maxOvershootPx = flights.length ? Math.max(...flights.map((flight) => flight.overshootPx)) : null;
    record("desktop: every sheet in flight was sampled under the pull-back cap", {
      samples: flights.length,
      maxPullBack: maxPullBack === null ? null : Number(maxPullBack.toFixed(4)),
      maxOvershootPx: maxOvershootPx === null ? null : Number(maxOvershootPx.toFixed(2)),
    }, maxPullBack !== null && flights.length === 1 + DRAG_FRACTIONS.length + fractions.length
      && maxPullBack <= MAX_PULLBACK + PULLBACK_TOLERANCE);
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

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  await mkdir(artifactDir, { recursive: true });
  await desktopSession(browser);
  await phoneSession(browser);
} finally {
  await writeFile(`${artifactDir}/checks.json`, `${JSON.stringify(checks, null, 2)}\n`).catch(() => {});
  await browser.close();
}

if (failed) {
  console.error(`3D Journey Book QA failed: ${checks.filter((check) => check.failed).map((check) => check.name).join("; ")}`);
  process.exitCode = 1;
}
