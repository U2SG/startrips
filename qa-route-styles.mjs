import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:5173";
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

const snap = (label, extra = {}) => {
  console.log(JSON.stringify({ stage: label, ...extra }));
};

snap("INIT", await page.evaluate(() => {
  const group = [...document.querySelectorAll(".particle-earth-route")]
    .find((g) => g.querySelector(".particle-earth-route__core")?.getAttribute("d")?.length > 0);
  return {
    routeStyle: document.querySelector(".particle-earth-scene")?.dataset.routeStyle ?? null,
    switcherRemoved: document.querySelectorAll("[data-route-style-option]").length === 0,
    strandA: Boolean(group?.querySelector(".particle-earth-route__strand-a")),
    strandB: Boolean(group?.querySelector(".particle-earth-route__strand-b")),
    strandDash: group ? getComputedStyle(group.querySelector(".particle-earth-route__strand-a")).strokeDasharray : null,
    coreGradient: group?.querySelector(".particle-earth-route__core")?.getAttribute("stroke")?.startsWith("url(#") ?? false,
  };
}));
await page.screenshot({ path: "D:\\startrips\\qa-style-strands.png" });

// Activate one journey: active alone, others muted but visible.
await page.click('[data-qa-route="qa-route-rhine"]');
await page.waitForTimeout(1200);
snap("ACTIVE (rhine selected)", await page.evaluate(() => ({
  active: document.querySelectorAll(".particle-earth-route.is-active").length,
  muted: document.querySelectorAll(".particle-earth-route.is-muted").length,
  idle: document.querySelectorAll(".particle-earth-route.is-idle").length,
})));
await page.screenshot({ path: "D:\\startrips\\qa-style-active.png" });

// Ambience toggle.
await page.click("[data-ambience-toggle]");
await page.waitForTimeout(400);
snap("AMBIENCE ON", await page.evaluate(() => ({
  ambience: document.querySelector(".living-atlas-globe")?.dataset.ambience ?? null,
  blobs: document.querySelectorAll(".living-atlas-ambience__blob").length,
})));
await page.screenshot({ path: "D:\\startrips\\qa-style-ambience.png" });
await page.click("[data-ambience-toggle]");
await page.waitForTimeout(300);
snap("AMBIENCE OFF", await page.evaluate(() => ({
  ambience: document.querySelector(".living-atlas-globe")?.dataset.ambience ?? null,
  blobs: document.querySelectorAll(".living-atlas-ambience__blob").length,
})));

// Drag the globe to exercise the projection path, then confirm health.
const canvas = page.locator(".living-atlas-globe canvas").first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 160, cy - 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(800);
snap("AFTER DRAG", {
  sceneAlive: await page.evaluate(() => Boolean(
    document.querySelector(".particle-earth-scene canvas"),
  )),
});
await page.screenshot({ path: "D:\\startrips\\qa-style-after-drag.png" });

console.log("=== ISSUES ===");
issues.slice(0, 8).forEach((line) => console.log(line));
if (issues.length === 0) console.log("(none)");
await browser.close();
