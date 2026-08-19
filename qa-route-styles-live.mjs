import { chromium } from "playwright-core";

const EMAIL = "mapqa-1787023856@example.test";
const PASSWORD = "map-qa-password-2026";
const ORIGIN = "https://106.53.130.142";
const STYLES = ["default", "stream", "ribbon", "neon", "strands", "laser"];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const issues = [];
page.on("pageerror", (error) => issues.push(`[pageerror] ${error.message}`));

await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
await page.context().request.post(`${ORIGIN}/api/auth/sign-in/email`, { data: { email: EMAIL, password: PASSWORD } });
const orgList = await page.context().request.get(`${ORIGIN}/api/auth/organization/list`);
const orgs = JSON.parse(await orgList.text());
const organizationId = orgs?.data?.[0]?.id ?? orgs?.[0]?.id;
if (organizationId) {
  await page.context().request.post(`${ORIGIN}/api/auth/organization/set-active`, {
    data: { organizationId },
    headers: { origin: ORIGIN },
  });
}
await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => Number(document.querySelector(".particle-earth-scene")?.dataset.journeyRouteCount ?? 0) > 0,
  undefined,
  { timeout: 60000 },
);
await page.waitForTimeout(2500);

const snap = (label, extra = {}) => {
  console.log(JSON.stringify({ stage: label, ...extra }));
};

const switcherCount = await page.locator("[data-route-style-option]").count();
snap("INIT", {
  switcherButtons: switcherCount,
  routeStyle: await page.evaluate(() => document.querySelector(".particle-earth-scene")?.dataset.routeStyle ?? null),
  routes: await page.evaluate(() => Number(document.querySelector(".particle-earth-scene")?.dataset.journeyRouteCount ?? 0)),
});
await page.screenshot({ path: "D:\\startrips\\prod-style-default.png" });

for (const style of STYLES.slice(1)) {
  await page.click(`[data-route-style-option="${style}"]`);
  await page.waitForTimeout(style === "stream" ? 1400 : 900);
  snap(style.toUpperCase(), {
    routeStyle: await page.evaluate(() => document.querySelector(".particle-earth-scene")?.dataset.routeStyle ?? null),
    streamParticles: await page.evaluate(() => Number(document.querySelector(".particle-earth-scene")?.dataset.journeyRouteStreamParticles ?? 0)),
  });
  await page.screenshot({ path: `D:\\startrips\\prod-style-${style}.png` });
}

// Select the first journey from the rail and verify focus/context states.
await page.click(".living-atlas__journey-rail ol li button", { timeout: 15000 });
await page.waitForTimeout(1200);
snap("ACTIVE SELECTED", await page.evaluate(() => ({
  active: document.querySelectorAll(".particle-earth-route.is-active").length,
  muted: document.querySelectorAll(".particle-earth-route.is-muted").length,
  idle: document.querySelectorAll(".particle-earth-route.is-idle").length,
})));
await page.screenshot({ path: "D:\\startrips\\prod-style-active.png" });

// Ambience toggle on the live site.
await page.click("[data-ambience-toggle]");
await page.waitForTimeout(500);
snap("AMBIENCE ON", await page.evaluate(() => ({
  ambience: document.querySelector(".living-atlas-globe")?.dataset.ambience ?? null,
  blobs: document.querySelectorAll(".living-atlas-ambience__blob").length,
})));
await page.screenshot({ path: "D:\\startrips\\prod-style-ambience.png" });
await page.click("[data-ambience-toggle]");

console.log("=== ISSUES ===");
issues.slice(0, 8).forEach((line) => console.log(line));
if (issues.length === 0) console.log("(none)");
await browser.close();
