// 3D Journey Book browser QA: the rendered paper matches the geometry the
// product reports, on a deep book.
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
//   3. The page block shows as a strip under the near edge of the thick stack.
//   4. No console error and no page error.
//
// Expectations are fixed by the fixture: 40 sheets, quick_flipbook's sheet
// spacing and the camera tilt below. The mouse never moves over the stage, so
// no page edge is lifted by hover while sampling.
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

const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const consoleErrors = [];
const pageErrors = [];

try {
  await mkdir(artifactDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
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

  /** Wait until the book has settled at `spread`, then read what it reports. */
  async function settledAt(spread) {
    await page.waitForFunction((want) => {
      const raw = document.querySelector(".journey-book-3d__stage")?.dataset.qaBook;
      return raw ? JSON.parse(raw).spread === want : false;
    }, spread, { timeout: 30_000 });
    // Let pictures near the spread land so the evidence shows real pages; the
    // sampled margins are paper either way.
    await page.waitForTimeout(1_200);
    return page.evaluate(() => {
      const stage = document.querySelector(".journey-book-3d__stage");
      const box = stage.getBoundingClientRect();
      return { ...JSON.parse(stage.dataset.qaBook), stage: { left: box.left, top: box.top, width: box.width, height: box.height } };
    });
  }

  /** Screenshot the page and read the given viewport pixels back from it. */
  async function sample(name, points) {
    const png = await page.screenshot({ type: "png" });
    await writeFile(`${artifactDir}/${name}.png`, png);
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

  /** Sheets in the stack under a settled side. */
  function stackCount(side, spread) {
    return side === "left" || side === "closed-back" ? spread : SHEETS - spread;
  }

  /**
   * Edge probes for one face. `outer` is the x of its outer edge and the
   * direction away from the spine; a closed cover has two outer edges.
   */
  function probes(state, side) {
    const rect = state.rects[side];
    const ox = state.stage.left;
    const oy = state.stage.top;
    const left = ox + rect.left;
    const right = left + rect.width;
    const top = oy + rect.top;
    const bottom = top + rect.height;
    const blockPx = stackCount(side, state.spread) * SHEET_SPACING * Math.sin(TILT) * state.pixelsPerUnit;
    const outerEdges = side === "left" ? [{ x: left, out: -1 }]
      : side === "right" ? [{ x: right, out: 1 }]
        : [{ x: left, out: -1 }, { x: right, out: 1 }];
    // Fractions of the width away from the spine where the page lies flat
    // (quick_flipbook curves it up nearer the spine).
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

  async function checkAlignment(label, state, sides, paperTest) {
    const groups = sides.map((side) => ({ side, ...probes(state, side) }));
    const points = groups.flatMap((group) => group.list);
    const pixels = await sample(label, points);
    let cursor = 0;
    for (const group of groups) {
      const bad = [];
      for (const probe of group.list) {
        const rgb = pixels[cursor++];
        const inside = probe.kind.endsWith("-in");
        const ok = probe.kind === "block" ? isBlock(rgb) : inside ? paperTest(rgb) : isTable(rgb);
        if (!ok) bad.push({ ...probe, x: Math.round(probe.x), y: Math.round(probe.y), rgb });
      }
      const alignment = bad.filter((probe) => probe.kind !== "block");
      record(`${label}: ${group.side} face rect matches the rendered page`, {
        rect: group.rect, probes: group.list.filter((probe) => probe.kind !== "block").length, bad: alignment,
      }, alignment.length === 0);
      const blocks = group.list.filter((probe) => probe.kind === "block");
      if (blocks.length) {
        const badBlocks = bad.filter((probe) => probe.kind === "block");
        record(`${label}: ${group.side} page block shows under the near edge`, {
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
    record(`${label}: ${side} page's outer margin is paper, not table`, { rect, probes: points.length, bad }, bad.length === 0);
  }

  // Closed front cover.
  const cover = await settledAt(0);
  record("fixture: the book has 40 sheets", { sheets: cover.sheets, orientation: cover.orientation },
    cover.sheets === SHEETS && cover.sheets * 2 === FACES && cover.orientation === "landscape");
  await checkAlignment("cover", cover, ["closed-front"], isCloth);

  // First spread: the deep left page (#630).
  await page.locator('button[aria-label="下一页"]').click();
  const first = await settledAt(1);
  await checkOuterMargin("first-spread", first, "left");
  await checkAlignment("first-spread", first, ["left", "right"], isPaper);
  const offset = first.rects.left.top - first.rects.right.top;
  const expected = (SHEETS - 1) * SHEET_SPACING * Math.sin(TILT) * first.pixelsPerUnit;
  record("first-spread: the deep left page rests lower on screen by its stack depth", {
    offset: Number(offset.toFixed(2)), expected: Number(expected.toFixed(2)),
  }, Math.abs(offset - expected) < 0.5);

  // Last interior spread: the deep right page.
  await page.locator(".journey-book-3d").focus();
  await page.keyboard.press("End");
  await settledAt(SHEETS);
  await page.locator('button[aria-label="上一页"]').click();
  const last = await settledAt(SHEETS - 1);
  await checkOuterMargin("last-spread", last, "right");
  await checkAlignment("last-spread", last, ["left", "right"], isPaper);
} catch (error) {
  record("lane ran to completion", { error: error instanceof Error ? error.stack ?? error.message : String(error) }, false);
} finally {
  record("no console or page errors", { consoleErrors, pageErrors }, consoleErrors.length === 0 && pageErrors.length === 0);
  await writeFile(`${artifactDir}/checks.json`, `${JSON.stringify(checks, null, 2)}\n`).catch(() => {});
  await browser.close();
}

if (failed) {
  console.error(`3D Journey Book QA failed: ${checks.filter((check) => check.failed).map((check) => check.name).join("; ")}`);
  process.exitCode = 1;
}
