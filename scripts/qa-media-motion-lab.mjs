// #392: exercise the real StoryMediaPages and PlaybackMediaStage with public
// fixtures. Capture pointer samples while a gesture owns pixels, not just its
// before/after result. The lab carries no private Journey or auth session.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const artifactDir = path.resolve("artifacts/media-motion-lab");
const browser = await launchQaBrowser();
const checks = [];
const viewports = [
  { name: "desktop", width: 1280, height: 800, mobile: false },
  { name: "phone-320", width: 320, height: 760, mobile: true },
  { name: "phone-360", width: 360, height: 780, mobile: true },
  { name: "phone-390", width: 390, height: 844, mobile: true },
  { name: "phone-430", width: 430, height: 920, mobile: true },
  { name: "phone-landscape", width: 844, height: 390, mobile: true },
];

await fs.mkdir(artifactDir, { recursive: true });

async function open({ mode = "explore", density = "sequence", scenario = "direct",
  viewport = viewports[0], reducedMotion = false, holdTargetBytes = null } = {}) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile, hasTouch: viewport.mobile,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  let releaseTargetBytes = () => undefined;
  if (holdTargetBytes) {
    const gate = new Promise((resolve) => { releaseTargetBytes = resolve; });
    const asset = holdTargetBytes === "video" ? "east-star-orbit.webm" : "greek-amphora.jpg";
    await page.route(`**/${asset}`, async (route) => { await gate; await route.continue(); });
  }
  const params = new URLSearchParams({ qaState: "media-motion-lab", mode, density, scenario });
  await page.goto(`${origin}/?${params}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-media-motion-lab]").waitFor({ timeout: 20_000 });
  if (density !== "empty") {
    await page.locator('[data-media-motion-lab][data-stage-covered="true"]').waitFor({ timeout: 20_000 });
  }
  return { page, errors, mode, density, scenario, viewport: viewport.name, reducedMotion, releaseTargetBytes };
}

async function evidence(name, opened, detail = {}) {
  const { page, errors } = opened;
  const trace = await page.evaluate(() => window.__mediaMotionLab ?? { marks: [], native: [] });
  const state = await page.locator("[data-media-motion-lab]").evaluate((node) => ({ ...node.dataset }));
  const screenshot = `${name}.png`;
  await page.screenshot({ path: path.join(artifactDir, screenshot), fullPage: true });
  assert.deepEqual(errors, [], `browser errors in ${name}`);
  checks.push({ name, passed: true, ...detail, state, trace, screenshot });
}

async function run(name, config, exercise) {
  let opened;
  try {
    opened = await open(config);
    const detail = await exercise(opened.page, opened);
    await evidence(name, opened, detail);
  } catch (error) {
    checks.push({ name, passed: false, error: error instanceof Error ? error.stack : String(error) });
    if (opened?.page) {
      await opened.page.screenshot({ path: path.join(artifactDir, `${name}-failed.png`), fullPage: true }).catch(() => undefined);
    }
  } finally {
    await opened?.page.close();
  }
}

for (const mode of ["explore", "playback"]) {
  for (const density of ["empty", "single", "few", "sequence", "dense"]) {
    await run(`${mode}-${density}-portrait`, { mode, density, viewport: viewports[3] }, async (page) => {
      const lab = page.locator("[data-media-motion-lab]");
      assert.equal(await lab.getAttribute("data-mobile-v2"), "on");
      if (density === "empty") {
        assert.equal(await page.locator("[data-lab-empty-chapter]").count(), 1);
        assert.equal(await page.locator("[data-media-presentation]").count(), 0);
      } else {
        assert.equal(await lab.getAttribute("data-stage-covered"), "true");
        assert.equal(await lab.getAttribute("data-presented-media"), "lab-1");
        if (density === "single") {
          assert.equal(await page.getByRole("button", { name: "Next" }).count(), 0);
          assert.equal(await page.getByRole("button", { name: "Previous" }).count(), 0);
        }
        if (density === "dense" && mode === "playback") {
          assert.equal(await page.locator("[data-sequence-peek-count]").getAttribute("data-sequence-peek-count"), "2");
        }
      }
      return { mode, density };
    });
  }
}

for (const viewport of viewports) {
  await run(`layout-${viewport.name}`, { mode: "explore", density: "single", viewport }, async (page) => {
    const lab = page.locator("[data-media-motion-lab]");
    assert.equal(await lab.getAttribute("data-stage-covered"), "true");
    assert.equal(await lab.getAttribute("data-mobile-v2"), viewport.mobile ? "on" : "off");
    return { viewport };
  });
}

await run("direct-drag-reversal", { scenario: "direct", viewport: viewports[3] }, async (page) => {
  const stage = page.locator("[data-story-media-pages]");
  const box = await stage.boundingBox();
  assert.ok(box);
  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.5;
  const sample = () => stage.evaluate((node) => ({
    phase: node.dataset.mediaPresentation,
    owner: node.querySelector('[data-media-presented="true"]')?.getAttribute("data-media-page-id"),
    transform: node.querySelector('[data-media-page-id="lab-1"]')?.style.transform,
    dragX: node.style.getPropertyValue("--story-drag-x"),
    physicalSlots: [...node.querySelectorAll("[data-media-page-id]")].map((slot) => slot.getAttribute("data-media-page-id")),
  }));
  const samples = [await sample()];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const offset of [-28, -74, -box.width * 0.4, -box.width * 0.2, 18]) {
    await page.mouse.move(x + offset, y);
    samples.push(await sample());
    assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  }
  await page.mouse.up();
  await page.locator('[data-story-media-pages][data-media-presentation="settled"]').waitFor({ timeout: 10_000 });
  assert.ok(samples.some((entry) => entry.phase === "dragging"));
  assert.ok(new Set(samples.map((entry) => entry.transform)).size >= 3, "pointermove must change the real page transform");
  assert.ok(samples.every((entry) => entry.physicalSlots.includes("lab-1")), "the source stays in a physical slot throughout reversal");
  assert.equal(await page.locator("[data-lab-current]").textContent(), "lab-1");
  return { pointerSamples: samples };
});

await run("delayed-neighbor-covered", { scenario: "delayed", viewport: viewports[3] }, async (page) => {
  const stage = page.locator("[data-story-media-pages]");
  const box = await stage.boundingBox();
  assert.ok(box);
  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.5;
  const samples = [];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const offset of [-35, -80, -box.width * 0.4]) {
    await page.mouse.move(x + offset, y);
    samples.push(await page.locator("[data-media-motion-lab]").evaluate((lab) => ({
      covered: lab.dataset.stageCovered,
      presented: lab.dataset.presentedMedia,
      targetRead: lab.querySelector('[data-media-page-id="lab-2"]')?.getAttribute("data-media-read-state"),
      dragX: lab.querySelector("[data-story-media-pages]")?.style.getPropertyValue("--story-drag-x"),
    })));
  }
  await page.mouse.up();
  assert.ok(samples.every((entry) => entry.covered === "true" && entry.presented === "lab-1"));
  assert.ok(samples.some((entry) => entry.dragX && entry.dragX !== "0px"));
  await page.getByRole("button", { name: "Next" }).click();
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-presented-media"), "lab-1");
  await page.getByRole("button", { name: "Release target" }).click();
  await page.waitForFunction(() => document.querySelector("[data-lab-current]")?.textContent === "lab-2", null, { timeout: 15_000 });
  await page.locator('[data-media-motion-lab][data-presented-media="lab-2"]').waitFor({ timeout: 15_000 });
  return { pointerSamples: samples };
});

await run("held-image-bytes-and-decode", {
  mode: "explore", density: "few", scenario: "direct", holdTargetBytes: "image", viewport: viewports[3],
}, async (page, opened) => {
  await page.getByRole("button", { name: "Next" }).click();
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-presented-media"), "lab-1");
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  opened.releaseTargetBytes();
  await page.locator('[data-media-motion-lab][data-presented-media="lab-2"]').waitFor({ timeout: 15_000 });
  return { heldAsset: "lab-2", retainedAsset: "lab-1", release: "actual public image bytes" };
});

await run("held-video-first-frame", {
  mode: "playback", density: "few", scenario: "mixed", holdTargetBytes: "video",
}, async (page, opened) => {
  await page.getByRole("button", { name: "Next" }).click();
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-presented-media"), "lab-1");
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  opened.releaseTargetBytes();
  await page.locator('[data-media-motion-lab][data-presented-media="lab-2"]').waitFor({ timeout: 20_000 });
  return { heldAsset: "lab-2", retainedAsset: "lab-1", release: "actual public video bytes" };
});

await run("stale-completion-cannot-reclaim", { scenario: "stale" }, async (page) => {
  await page.getByRole("button", { name: "Request B" }).click();
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-presented-media"), "lab-1");
  await page.getByRole("button", { name: "Return to A" }).click();
  await page.getByRole("button", { name: "Release target" }).click();
  assert.equal(await page.locator("[data-lab-current]").textContent(), "lab-1");
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-presented-media"), "lab-1");
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  return { staleTarget: "lab-2", winningIntent: "lab-1" };
});

for (const mode of ["explore", "playback"]) {
  await run(`${mode}-image-video-image`, { mode, density: "few", scenario: "mixed" }, async (page) => {
    await page.getByRole("button", { name: "Next" }).click();
    await page.waitForFunction(() => document.querySelector("[data-lab-current]")?.textContent === "lab-2", null, { timeout: 15_000 });
    await page.locator('[data-media-motion-lab][data-presented-media="lab-2"]').waitFor({ timeout: 20_000 });
    const videos = page.locator("[data-lab-stage] video");
    assert.ok(await videos.count() <= 1, "one physical video transport");
    await videos.first().evaluate((video) => video.play());
    await page.locator('[data-media-motion-lab][data-live-video-count="1"]').waitFor({ timeout: 8_000 });
    await page.getByRole("button", { name: "Next" }).click();
    await page.locator('[data-media-motion-lab][data-presented-media="lab-3"]').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
    assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-live-video-count"), "0");
    return { topology: "image-video-image", peakLiveVideos: 1 };
  });
}

await run("shared-entry-return", { mode: "explore", density: "single", scenario: "shared" }, async (page) => {
  const source = page.locator("[data-lab-shared-source]");
  const target = page.locator('[data-shared-media-id="lab-1"]');
  await target.waitFor();
  const sourceRect = await source.boundingBox();
  const targetRect = await target.boundingBox();
  assert.ok(sourceRect && targetRect && sourceRect.width < targetRect.width);
  await page.getByRole("button", { name: "Enter immersive" }).click();
  const clone = page.locator('[data-shared-element-clone="media-motion-lab"]');
  await clone.waitFor({ state: "attached", timeout: 3_000 });
  const cloneRect = await clone.boundingBox();
  assert.ok(cloneRect && cloneRect.width > 0);
  await page.locator("[data-lab-stage].is-immersive").waitFor();
  const immersiveRect = await target.boundingBox();
  assert.ok(immersiveRect && immersiveRect.width > targetRect.width);
  await page.getByRole("button", { name: "Return from immersive" }).click();
  await page.locator("[data-lab-stage]:not(.is-immersive)").waitFor();
  return { sourceRect, targetRect, cloneRect, immersiveRect };
});

await run("reduced-motion-same-owner", { mode: "explore", density: "few", scenario: "direct", reducedMotion: true }, async (page) => {
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-reduced-motion"), "true");
  await page.getByRole("button", { name: "Next" }).click();
  await page.locator('[data-media-motion-lab][data-presented-media="lab-2"]').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  return { finalAsset: "lab-2" };
});

await run("truthful-target-failure", { scenario: "failure" }, async (page) => {
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Fail target" }).click();
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-presented-media"), "lab-1");
  assert.equal(await page.locator("[data-media-motion-lab]").getAttribute("data-stage-covered"), "true");
  await page.getByRole("alert").waitFor();
  return { failure: "Synthetic read failure", retainedAsset: "lab-1" };
});

await fs.writeFile(path.join(artifactDir, "results.json"), JSON.stringify({ checks }, null, 2), "utf8");
await browser.close();
const failed = checks.filter((check) => !check.passed);
console.log(`Media Motion Lab: ${checks.length - failed.length}/${checks.length} checks passed; artifacts/media-motion-lab/results.json`);
if (failed.length) {
  for (const check of failed) console.error(`${check.name}: ${check.error}`);
  process.exitCode = 1;
}
