import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const output = "artifacts/story-repair/stream-input";
await mkdir(output, { recursive: true });
const createdAt = "2026-10-15T00:00:00.000Z";
const journey = {
  id: "stream-input", atlasId: "qa-atlas", title: "沿途慢行", note: "", startedOn: "2026-10-01", endedOn: null,
  lightColor: "#74e7d0", revision: 1, createdByUserId: "qa-owner", createdAt, updatedAt: createdAt,
  routePoints: [], media: ["photo", "video", "photo-next"].map((id, index) => ({
    id, journeyId: "stream-input", routePointId: null, fileName: `${id}.${id === "video" ? "webm" : "jpg"}`,
    mimeType: id === "video" ? "video/webm" : "image/jpeg", bytes: 68, sortOrder: index, createdAt,
  })),
};
// Same production component and styles; only Journey/read inputs are deterministic.
// There are no fixture buttons, forced state setters, modified geometry or fake events.
await writeFile(`${output}/harness.tsx`, `import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import JourneyStream from "/src/journey/JourneyStream";
import "/src/styles/tokens.css";
import "/src/styles/controls.css";
import "/src/app.css";
import "/src/styles/living-atlas.css";
const journey = ${JSON.stringify(journey)};
const journeys = [journey, {...journey, id:"neighbour", title:"另一段旅程", media:[]}];
window.__streamNavigations=[];
function Harness() {
 const [id,setId]=useState(journey.id), [open,setOpen]=useState(true);
 return <main className="living-atlas">{open && <JourneyStream key={id} journeys={journeys} journeyId={id}
 initialAssetId={new URLSearchParams(location.search).get("entry") || "photo"}
 onClose={()=>setOpen(false)} onOpenClassic={(target)=>{window.__streamReturn=target;}}
 onNavigate={(next)=>{window.__streamNavigations.push(next);setId(next);}}
 onObservationChange={(value)=>{window.__streamObservation=value;}} />}</main>;
}
createRoot(document.getElementById("root")).render(<Harness/>);`);

const browser = await launchQaBrowser();
const results = [];
const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
async function settle(page) {
  await page.waitForFunction(() => {
    const strip = document.querySelector(".journey-stream__strip");
    if (!strip) return false;
    const transform = getComputedStyle(strip).transform;
    const prior = window.__streamStable;
    const frames = prior?.transform === transform ? prior.frames + 1 : 0;
    window.__streamStable = { transform, frames };
    return frames >= 4;
  }, null, { polling: "raf", timeout: 3_000 });
}
const state = (page) => page.evaluate(() => ({
  transform: getComputedStyle(document.querySelector(".journey-stream__strip")).transform,
  observation: window.__streamObservation, navigations: window.__streamNavigations,
  paused: Boolean(document.querySelector(".journey-stream__paused")),
}));
async function unchangedForFrames(page, expected) {
  const samples = await page.evaluate(async () => {
    const samples = [];
    for (let frame = 0; frame < 8; frame++) {
      await new Promise(requestAnimationFrame);
      samples.push({ transform: getComputedStyle(document.querySelector(".journey-stream__strip")).transform,
        observation: window.__streamObservation, navigations: [...window.__streamNavigations],
        paused: Boolean(document.querySelector(".journey-stream__paused")) });
    }
    return samples;
  });
  for (const sample of samples) assert.deepEqual(sample, expected, "Input changed the inactive Stream or left release inertia");
}
try {
  for (const viewport of viewports) {
    const mobile = viewport.width !== 1280;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(5_000);
    await page.route("**/__stream_input_qa?*", (route) => route.fulfill({ contentType: "text/html", body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/${output}/harness.tsx"></script>` }));
    await page.route("**/api/uploads/assets/*/read-url", (route) => {
      const asset = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({ json: { url: `${origin}${asset === "video" ? "/demo-media/east-star-orbit.webm" : "/artworks/hokusai-wave.jpg"}`,
        expiresAt: "2099-01-01T00:00:00.000Z" } });
    });
    try {
      await page.goto(`${origin}/__stream_input_qa?entry=photo`, { waitUntil: "domcontentloaded" });
      const photo = page.getByRole("button", { name: "查看 photo.jpg", exact: true });
      await photo.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const photo = document.querySelector('button[aria-label="查看 photo.jpg"] img');
        return photo?.complete && photo.naturalWidth > 0 && window.__streamObservation?.assetId === "photo";
      });
      await settle(page);
      const buttons = await page.locator(".journey-stream button").count();
      await photo.click();
      const lightbox = page.getByRole("dialog", { name: "大图", exact: true });
      await lightbox.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector(".journey-stream__lightbox")?.contains(document.activeElement));
      assert.equal(await lightbox.getAttribute("aria-modal"), "true");
      assert.equal(await page.locator(".journey-stream__flow").evaluate((node) => node.inert), true);
      const behind = await state(page);
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        assert.equal(await lightbox.evaluate((node) => node.contains(document.activeElement)), true, "Focus escaped the existing large-photo surface");
      }
      // Space on the close button remains native activation; with the dialog
      // itself focused it must not pause the background stream.
      await lightbox.focus();
      await page.keyboard.press("Space");
      await unchangedForFrames(page, behind);
      await page.keyboard.press("Escape");
      await lightbox.waitFor({ state: "detached" });
      assert.equal(await photo.evaluate((node) => document.activeElement === node), true, "Escape restores the existing photo trigger");
      assert.equal(await page.locator(".journey-stream button").count(), buttons, "No replacement controls appear after closing");

      // Cancel a genuine drag. Capture-loss uses the browser's real release API;
      // touch uses its cancellation event, not dispatchEvent or a state setter.
      const flow = page.locator(".journey-stream__flow");
      await flow.evaluate((node) => node.addEventListener("gotpointercapture", (event) => {
        if (event.target === node) window.__streamCapturedPointer = event.pointerId;
      }));
      const start = { x: mobile ? 16 : 96, y: viewport.height * .6 };
      if (mobile) {
        const cdp = await context.newCDPSession(page);
        try {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + 30, id: 1 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + 50, id: 1 }] });
          await page.waitForFunction(() => window.__streamCapturedPointer !== undefined);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        } finally { await cdp.detach(); }
      } else {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x, start.y + 50, { steps: 4 });
        await page.waitForFunction(() => window.__streamCapturedPointer !== undefined);
        await flow.evaluate((node) => node.releasePointerCapture(window.__streamCapturedPointer));
        await page.mouse.move(start.x, start.y + 51);
        await page.mouse.up();
      }
      await unchangedForFrames(page, await state(page));
      assert.equal(await page.locator(".journey-stream__lightbox").count(), 0, "Cancellation synthesized a photo activation");
      await page.screenshot({ path: `${output}/${viewport.width}x${viewport.height}-stream.png` });

      await page.goto(`${origin}/__stream_input_qa?entry=video`, { waitUntil: "domcontentloaded" });
      const video = page.locator(".journey-stream__frame video");
      await video.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const video = document.querySelector(".journey-stream__frame video");
        return video?.readyState >= 2 && window.__streamObservation?.assetId === "video";
      });
      await settle(page);
      const nativeBefore = await state(page);
      const box = await video.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height * .25;
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x, y }), "VIDEO");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 18, y + 30, { steps: 3 });
      await page.mouse.up();
      await unchangedForFrames(page, nativeBefore);
      assert.equal(await video.evaluate((node) => node.controls), true);
      await video.focus();
      if (await video.evaluate((node) => !node.paused)) {
        await page.keyboard.press("Space");
        await page.waitForFunction(() => document.querySelector(".journey-stream__frame video")?.paused === true);
      }
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector(".journey-stream__frame video")?.paused === false);
      assert.equal(await page.locator(".journey-stream__paused").count(), 0, "Video Space reached Stream pause instead of the native transport");
      assert.deepEqual(errors, []);
      results.push({ viewport, lightboxIsolation: true, focusReturn: true, dragCancellation: true, nativeVideoIsolation: true, addedControls: 0 });
    } finally { await context.close(); }
  }
} catch (error) {
  console.error("STREAM_INPUT_FAILURE", error);
  throw error;
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results));
