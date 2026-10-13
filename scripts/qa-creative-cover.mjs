import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const dir = path.resolve("artifacts/cover-reveal/creative");
await mkdir(dir, { recursive: true });
const original = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#759fc4" } }).jpeg().toBuffer();
const generated = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#d4a262" } }).jpeg().toBuffer();
const sourceHash = createHash("sha256").update(original).digest("hex");
const cover = { id: "source", journeyId: "journey", routePointId: null, fileName: "source.jpg", mimeType: "image/jpeg", bytes: original.length, sortOrder: 0, contentHash: sourceHash, contentHashVerified: true, createdAt: "2026-10-12T00:00:00Z" };
const recipes = [
  { id: "ink-wash-memory", title: "水墨记忆", generationKind: "ink-wash-poster", presetId: "reveal-flow-ink-wash-v1" },
  { id: "poetic-line-memory", title: "线条记忆", generationKind: "poetic-line-memory", presetId: "brush-sweep" },
  { id: "paper-collage-memory", title: "纸上记忆", generationKind: "paper-collage-memory", presetId: "guided-ribbon" },
];
const harness = path.join(dir, "harness.tsx");
await writeFile(harness, `import React from 'react'; import {createRoot} from 'react-dom/client';
import {CoverRevealRequest} from '/src/journey/CoverRevealRequest';
import {enqueueCoverReveal,listCreativeCoverRecipes,readCreativeCoverStatus,readCoverRevealDisplay,getPrivateMediaRead} from '/src/journey/journeyApi';
const client={readRecipes:listCreativeCoverRecipes,readStatus:readCreativeCoverStatus,readDisplay:readCoverRevealDisplay,readSource:getPrivateMediaRead};
createRoot(document.getElementById('root')!).render(<CoverRevealRequest journeyId="journey" cover={${JSON.stringify(cover)}} disabled={false} enqueue={enqueueCoverReveal} client={client}/>);`);
const browser = await launchQaBrowser();
const page = await browser.newPage({ viewport: { width: 760, height: 880 }, reducedMotion: "no-preference" });
page.setDefaultTimeout(15000);
const errors = [], submitted = [];
page.on("pageerror", (error) => errors.push(error.message));
let selected = recipes[0], state = "idle", count = 0, statusReads = 0;
const signed = (url) => ({ url, expiresAt: new Date(Date.now() + 60000).toISOString() });
const reply = (route, value) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
await page.route("**/api/cover-reveal/recipes", (route) => reply(route, { recipes }));
await page.route("**/api/cover-reveal/journeys/journey/status", (route) => {
  statusReads++;
  return reply(route, { state, recipeId: selected.id, sourceMediaAssetId: cover.id, derivativeId: state === "idle" ? null : `d${count}` });
});
await page.route("**/api/cover-reveal/journeys/journey", async (route) => {
  if (route.request().method() === "POST") {
    const id = route.request().postDataJSON().recipeId;
    selected = recipes.find((recipe) => recipe.id === id); assert(selected);
    submitted.push(id); count++; state = "queued";
    return reply(route, { derivative: { id: `d${count}`, sourceMediaAssetId: cover.id, state } });
  }
  return reply(route, { derivative: { id: `d${count}`, journeyId: "journey", sourceMediaAssetId: cover.id, sourceContentHash: sourceHash,
    generationKind: selected.generationKind, generationVersion: 1, presetId: selected.presetId, mimeType: "image/jpeg", width: 300, height: 200 }, display: signed(`${origin}/creative-generated.jpg`) });
});
await page.route("**/api/uploads/assets/source/read-url", (route) => reply(route, signed(`${origin}/creative-original.jpg`)));
await page.route("**/creative-original.jpg", (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: original }));
await page.route("**/creative-generated.jpg", (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: generated }));
await page.route("**/creative-cover-harness", (route) => route.fulfill({ status: 200, contentType: "text/html", body: '<html><body><main id="root" style="width:500px;margin:20px"></main><script type="module" src="/artifacts/cover-reveal/creative/harness.tsx"></script></body></html>' }));
try {
  await page.goto(`${origin}/creative-cover-harness`);
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="开场风格"] option').length === 3);
  for (const recipe of recipes) {
    await page.getByRole("combobox", { name: "开场风格" }).selectOption(recipe.id);
    await page.getByRole("button", { name: recipe.id === "ink-wash-memory" ? "生成水墨开场图" : `生成${recipe.title}开场图`, exact: true }).click();
    await page.getByRole("status").filter({ hasText: "加入生成队列" }).waitFor();
    state = "leased"; await page.getByRole("button", { name: "刷新生成状态" }).click();
    await page.getByRole("status").filter({ hasText: "正在生成和审阅" }).waitFor();
    state = "ready"; await page.getByRole("button", { name: "刷新生成状态" }).click();
    await page.getByRole("button", { name: "预览开场" }).click();
    await page.locator('[data-cover-reveal-phase="settled"]').waitFor();
    const stage = page.locator('[data-cover-reveal-phase="settled"]');
    assert.equal(await stage.getAttribute("data-cover-reveal-composited"), "original-cover");
    const png = await stage.screenshot({ path: path.join(dir, `${recipe.id}-final.png`) });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    const expected = [117, 159, 196];
    for (let channel = 0; channel < 3; channel++) assert(Math.abs(data[offset + channel] - expected[channel]) < 15, "reveal final pixels must be the original");
  }
  state = "failed"; await page.getByRole("button", { name: "刷新生成状态" }).click();
  await page.getByRole("status").filter({ hasText: "生成失败" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "预览开场" }).count(), 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  state = "ready"; await page.getByRole("button", { name: "刷新生成状态" }).click();
  await page.getByRole("button", { name: "预览开场" }).click();
  await page.locator('[data-cover-reveal-settle-reason="reduced-motion"] [data-cover-reveal-image="original-cover"]').waitFor();
  // #694/P2: use the real component/client with controlled browser time and
  // visibility. runFor executes every due timer (unlike a clock jump), so the
  // former ++attempts-before-hidden-check loop exhausts its budget here.
  const clockStart = new Date("2026-10-13T10:00:00Z");
  await page.clock.install({ time: clockStart });
  state = "queued"; count++;
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  });
  await page.reload();
  await page.getByRole("status").filter({ hasText: "加入生成队列" }).waitFor();
  await page.clock.pauseAt(new Date(clockStart.getTime() + 60_000));
  const hiddenReads = statusReads;
  await page.clock.runFor(6 * 60_000);
  assert.equal(statusReads, hiddenReads, "hidden time must not issue status reads");
  state = "ready";
  const resumedResponse = page.waitForResponse((response) => response.url().endsWith("/journeys/journey/status"), { timeout: 15000 });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await resumedResponse;
  await page.clock.resume();
  await page.getByRole("status").filter({ hasText: "已生成，原封面保持不变" }).waitFor();
  await page.getByRole("button", { name: "预览开场" }).waitFor();
  assert.equal(statusReads, hiddenReads + 1, "returning must resume without a manual refresh or duplicate read");
  const pollingEvidence = { hiddenMs: 6 * 60_000, readsWhileHidden: 0, readsOnReturn: statusReads - hiddenReads, state: "ready" };
  assert.deepEqual(errors, []);
  assert.deepEqual(submitted, recipes.map((recipe) => recipe.id));
  await writeFile(path.join(dir, "evidence.json"), JSON.stringify({ passed: true, cases: ["three-recipe-owner-selection", "pending-and-ready-status", "real-reveal-original-final-pixels", "failed-no-preview", "reduced-motion-original", "background-six-minutes-then-automatic-foreground-ready"], submitted, polling: pollingEvidence }, null, 2));
} finally { await browser.close(); await rm(harness, { force: true }); }
