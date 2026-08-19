import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:5173";
const STYLES = ["default", "stream", "ribbon", "neon"];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const issues = [];
page.on("pageerror", (error) => issues.push(`[pageerror] ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") issues.push(`[console] ${message.text()}`);
});

await page.goto(`${ORIGIN}/?qaState=journey-routes`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => document.querySelectorAll(".particle-earth-route").length >= 5
    && document.querySelector(".particle-earth-scene")?.dataset.sceneReady === "true",
  undefined,
  { timeout: 60000 },
);
await page.waitForTimeout(2500);
console.log(`routes: ${await page.locator(".particle-earth-route").count()}`);

const snap = (label, extra = {}) => {
  console.log(JSON.stringify({ stage: label, ...extra }));
};

for (const style of STYLES) {
  await page.click(`[data-route-style-option="${style}"]`);
  await page.waitForTimeout(style === "stream" ? 1400 : 900);
  const dataset = await page.evaluate(() => ({
    routeStyle: document.querySelector(".particle-earth-scene")?.dataset.routeStyle ?? null,
    streamParticles: Number(
      document.querySelector(".particle-earth-scene")?.dataset.journeyRouteStreamParticles ?? 0,
    ),
  }));
  snap(style.toUpperCase(), dataset);
  await page.screenshot({ path: `D:\\startrips\\qa-style-${style}.png` });
}

// Activate one journey: the active route must be alone in is-active while
// every other route stays visible but muted.
await page.click('[data-qa-route="qa-route-rhine"]');
await page.waitForTimeout(1200);
const states = await page.evaluate(() => ({
  active: document.querySelectorAll(".particle-earth-route.is-active").length,
  muted: document.querySelectorAll(".particle-earth-route.is-muted").length,
  idle: document.querySelectorAll(".particle-earth-route.is-idle").length,
}));
snap("ACTIVE (rhine selected, stream style)", states);
await page.screenshot({ path: "D:\\startrips\\qa-style-active.png" });

// Drag the globe while the stream style is live to exercise the per-frame
// particle update path, then confirm the scene is still healthy.
const canvas = page.locator(".living-atlas-globe canvas").first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 160, cy - 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(800);
snap("AFTER DRAG (stream style)", {
  sceneAlive: await page.evaluate(() => Boolean(
    document.querySelector(".particle-earth-scene canvas"),
  )),
});
await page.screenshot({ path: "D:\\startrips\\qa-style-after-drag.png" });

console.log("=== ISSUES ===");
issues.slice(0, 8).forEach((line) => console.log(line));
if (issues.length === 0) console.log("(none)");
await browser.close();
