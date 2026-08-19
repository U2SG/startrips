import { chromium } from "playwright-core";
const EMAIL = "mapqa-1787023856@example.test";
const PASSWORD = "map-qa-password-2026";
const ORIGIN = "https://106.53.130.142";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const issues = [];
page.on("pageerror", (error) => issues.push(`[pageerror] ${error.message}`));
await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
await page.context().request.post(`${ORIGIN}/api/auth/sign-in/email`, { data: { email: EMAIL, password: PASSWORD } });
const orgList = await page.context().request.get(`${ORIGIN}/api/auth/organization/list`);
const orgs = JSON.parse(await orgList.text());
const organizationId = orgs?.data?.[0]?.id ?? orgs?.[0]?.id;
if (organizationId) await page.context().request.post(`${ORIGIN}/api/auth/organization/set-active`, { data: { organizationId }, headers: { origin: ORIGIN } });
await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Number(document.querySelector(".particle-earth-scene")?.dataset.journeyCityLabelCount ?? 0) > 0, { timeout: 60000 });
await page.waitForTimeout(2000);
const probe = () => {
  const dbg = window.__particleEarthDebug?.();
  const host = document.querySelector(".particle-earth-scene");
  return {
    debug: dbg,
    cityCount: host?.dataset.journeyCityLabelCount ?? null,
    visibleCities: [...document.querySelectorAll(".particle-earth-city")]
      .filter((el) => el.style.display !== "none").map((el) => el.textContent),
  };
};
const afterLoad = await page.evaluate(probe);
console.log("AFTER LOAD:", JSON.stringify({ zoom: afterLoad.debug?.zoom, scale: afterLoad.debug?.scale, count: afterLoad.cityCount, cities: afterLoad.visibleCities.slice(0, 14) }));
await page.screenshot({ path: "D:\\startrips\\qa-city-default.png" });
const canvas = page.locator(".living-atlas-globe canvas").first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 20, cy, { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(400);
for (let index = 0; index < 12; index += 1) {
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(3000);
const maxZoom = await page.evaluate(probe);
console.log("MAX ZOOM:", JSON.stringify({ zoom: maxZoom.debug?.zoom, scale: maxZoom.debug?.scale, count: maxZoom.cityCount, cities: maxZoom.visibleCities.slice(0, 24) }));
await page.screenshot({ path: "D:\\startrips\\qa-city-maxzoom.png" });
console.log("=== ISSUES ===");
issues.slice(0, 8).forEach((line) => console.log(line));
if (issues.length === 0) console.log("(none)");
await browser.close();
