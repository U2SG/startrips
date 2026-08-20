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

snap("INIT", await page.evaluate(() => {
  const group = [...document.querySelectorAll(".particle-earth-route")]
    .find((g) => g.querySelector(".particle-earth-route__core")?.getAttribute("d")?.length > 0);
  return {
    routeStyle: document.querySelector(".particle-earth-scene")?.dataset.routeStyle ?? null,
    switcherRemoved: document.querySelectorAll("[data-route-style-option]").length === 0,
    strandA: Boolean(group?.querySelector(".particle-earth-route__strand-a")),
    coreGradient: group?.querySelector(".particle-earth-route__core")?.getAttribute("stroke")?.startsWith("url(#") ?? false,
    shinyBrand: Boolean(document.querySelector(".living-atlas__brand h1 [data-shiny-text]")),
    countUpText: document.querySelector(".living-atlas__journey-rail > p")?.textContent ?? null,
    borderGlow: (() => {
      const card = document.querySelector(".living-atlas__active");
      return card ? getComputedStyle(card, "::after").animationName : null;
    })(),
  };
}));
await page.screenshot({ path: "D:\\startrips\\prod-style-strands.png" });

// Select a journey and verify focus/context states.
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
