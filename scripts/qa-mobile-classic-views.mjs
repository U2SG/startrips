import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "vite";
import { launchQaBrowser } from "./qa-browser.mjs";

// Real product fixture + browser, not reconstructed prototype markup.
const width = Number(process.argv[2] ?? 390);
const height = Number(process.argv[3] ?? 844);
const output = `artifacts/mobile-classic/${width}x${height}`;
await fs.mkdir(output, { recursive: true });
const server = process.env.QA_ORIGIN ? null : await createServer({
  server: { host: "127.0.0.1", port: 4186, strictPort: true }, logLevel: "error",
});
if (server) await server.listen();
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4186";
const browser = await launchQaBrowser({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true,
  deviceScaleFactor: 1, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
const results = [];
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/api/auth/get-session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
await context.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({ status: 200,
  contentType: "application/json", body: JSON.stringify({
    url: `${origin}/artworks/monet-water-lilies.jpg`, expiresAt: "2027-01-01T00:00:00.000Z",
  }) }));
const root = page.locator(".journey-story");
const current = page.locator('.journey-story [data-media-page="current"] img[data-shared-media-id]').first();
async function rememberStage() {
  await current.waitFor({ state: "visible" });
  await current.evaluate((image) => image.decode());
  return current.evaluate((image) => {
    window.__classicImage = image;
    window.__classicStage = image.closest("[data-story-media-pages]");
    return image.getAttribute("data-shared-media-id");
  });
}
async function unchanged(asset) {
  assert.equal(await current.evaluate((image) => image === window.__classicImage
    && image.closest("[data-story-media-pages]") === window.__classicStage), true, "layout remounted the live stage");
  assert.equal(await current.getAttribute("data-shared-media-id"), asset);
}
try {
  await page.goto(`${origin}/?qaState=journey-story`, { waitUntil: "networkidle" });
  const asset = await rememberStage();
  for (const [index, view] of ["light", "thumb", "photo", "earth"].entries()) {
    assert.equal(await root.getAttribute("data-classic-view"), view);
    assert.equal(await root.getAttribute("data-classic-panel"), "none");
    await unchanged(asset);
    const geometry = await root.evaluate((story) => {
      const visible = (element) => { const r = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
      const controls = [...story.querySelectorAll("header button, .journey-story__mobile-media-actions button")]
        .filter(visible).map((button) => ({ label: button.getAttribute("aria-label") ?? button.textContent,
          ...button.getBoundingClientRect().toJSON() }));
      const collisions = [];
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) collisions.push([a.label,b.label]);
      }
      const stage = story.querySelector("[data-story-media-pages]").getBoundingClientRect().toJSON();
      return { controls, collisions, stage, story: story.getBoundingClientRect().toJSON(),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.deepEqual(geometry.collisions, [], `overlapping controls in ${view}`);
    assert.ok(geometry.controls.every((control) => control.width >= 43.5 && control.height >= 43.5), `small touch control in ${view}`);
    assert.ok(geometry.controls.every((control) => control.left >= -1 && control.right <= width + 1), `clipped control in ${view}`);
    assert.ok(geometry.stage.height > 80, `empty media aperture in ${view}`);
    assert.ok(geometry.overflow <= 1, `horizontal document overflow in ${view}`);
    assert.equal(await page.getByRole("button", { name: "管理旅程", exact: true }).isVisible(), false);
    if (view === "photo") {
      await page.getByRole("button", { name: "选择停靠点", exact: true }).tap();
      assert.equal(await root.getAttribute("data-classic-panel"), "chapters");
      await current.tap();
      assert.equal(await root.getAttribute("data-classic-panel"), "more", "photo tap must replace chapters with More");
      await current.tap();
      assert.equal(await root.getAttribute("data-classic-panel"), "none");
      await unchanged(asset);
    }
    await page.screenshot({ path: `${output}/${view}.png` });
    results.push({ view, ...geometry });
    await page.getByRole("button", { name: /切换经典视图/ }).tap();
  }
  assert.equal(await root.getAttribute("data-classic-view"), "light");
  await page.getByRole("button", { name: "更多查看选项" }).tap();
  assert.equal(await root.getAttribute("data-classic-panel"), "more");
  await unchanged(asset);
  assert.equal(await page.getByRole("button", { name: "管理旅程", exact: true }).isVisible(), true);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-classic-panel") === "none");
  await unchanged(asset);
  await page.getByRole("button", { name: "展开旅程故事", exact: true }).tap();
  await page.getByRole("button", { name: "更多查看选项" }).tap();
  await page.keyboard.press("Escape");
  assert.equal(await root.getAttribute("data-classic-panel"), "none", "Escape must close disclosure before expanded Story");
  assert.equal(await root.getAttribute("data-mobile-presentation"), "expanded");
  await page.getByRole("button", { name: /切换经典视图/ }).tap();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await root.getAttribute("data-classic-view"), "thumb", "reload lost preference");
  if (width === 390) {
    await context.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({ status: 200,
      contentType: "application/json", body: JSON.stringify({
        url: `${origin}${route.request().url().includes("000000000152") ? "/demo-media/east-star-orbit.webm" : "/artworks/monet-water-lilies.jpg"}`,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }) }));
    await page.goto(`${origin}/?qaState=journey-story&qaMode=mixed-media`, { waitUntil: "networkidle" });
    await current.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "更多查看选项" }).tap();
    await page.getByRole("button", { name: /^查看第 2 个视频/ }).tap();
    const video = page.locator('.journey-story video[data-shared-media-id]');
    await video.waitFor({ state: "visible" });
    await video.evaluate(async (element) => {
      element.muted = true; element.loop = true; element.playbackRate = 0.25;
      element.currentTime = Math.min(0.4, element.duration / 3);
      await element.play(); window.__classicVideo = element;
    });
    for (let i = 0; i < 4; i++) {
      const before = await video.evaluate((element) => element.currentTime);
      await page.getByRole("button", { name: /切换经典视图/ }).tap();
      const state = await video.evaluate((element) => ({ same: element === window.__classicVideo,
        time: element.currentTime, paused: element.paused, controls: element.controls }));
      assert.equal(state.same, true, "layout replaced the video element");
      assert.equal(state.paused, false, "layout paused the native video");
      assert.equal(state.controls, true, "layout removed native video controls");
      assert.ok(state.time >= before - 0.05, "layout reset video time");
    }
    results.push({ videoContinuity: true });
  }
  // An external tab can change the preference while this Story is closed.
  await page.getByRole("button", { name: "退出旅程故事", exact: true }).click();
  await root.waitFor({ state: "detached" });
  const other = await page.context().newPage();
  await other.goto(`${origin}/?qaState=journey-story`, { waitUntil: "networkidle" });
  const remote = other.locator(".journey-story");
  for (let i = 0; i < 4 && await remote.getAttribute("data-classic-view") !== "earth"; i++) {
    await other.getByRole("button", { name: /切换经典视图/ }).tap();
  }
  assert.equal(await remote.getAttribute("data-classic-view"), "earth");
  await other.close();
  await page.locator("[data-qa-story-reopen]").click();
  await page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-classic-view") === "earth");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.querySelector(".journey-story")?.getAttribute("data-story-layout") === "desktop");
  assert.equal(await root.getAttribute("data-classic-view"), null);
  assert.equal(await page.getByRole("button", { name: /切换经典视图/ }).count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(`${output}/result.json`, JSON.stringify({ ok: true, width, height, results, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, width, height, views: results.map((result) => result.view).filter(Boolean),
    checks: ["44px targets", "no overlap", "no overflow", "stage identity", "Back", "expanded Escape", "reload preference", "desktop isolation"] }));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await fs.writeFile(`${output}/failure.json`, JSON.stringify({ message: error.message, errors, results }, null, 2));
  throw error;
} finally {
  await browser.close();
  await server?.close();
}
