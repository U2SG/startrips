import { chromium } from "playwright-core";

const EMAIL = "mapqa-1787023856@example.test";
const PASSWORD = "map-qa-password-2026";
const ORIGIN = "https://106.53.130.142";

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await context.request.post(`${ORIGIN}/api/auth/sign-in/email`, { data: { email: EMAIL, password: PASSWORD } });
  const orgs = await (await context.request.get(`${ORIGIN}/api/auth/organization/list`)).json();
  await context.request.post(`${ORIGIN}/api/auth/organization/set-active`, {
    data: { organizationId: orgs[0].id },
    headers: { origin: ORIGIN },
  });

  const created = await context.request.post(`${ORIGIN}/api/journeys`, {
    data: {
      title: "Position QA Journey",
      startedOn: "2026-08-18",
      endedOn: null,
      note: "",
      lightColor: "#f4ce73",
      routePoints: [{ latitude: 22.5, longitude: 114.05, label: "Shenzhen", isStop: true, occurredAt: null }],
    },
    headers: { origin: ORIGIN },
  });
  console.log("create journey:", created.status());

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);

  // Scroll the page to the middle before opening the story.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => ({ scrollY: window.scrollY, bodyH: document.body.scrollHeight }));

  // Activate a journey from the rail first, then open the story.
  const railCard = page.locator(".living-atlas__journey-rail li button", { hasText: "Position QA Journey" }).first();
  if (await railCard.count()) {
    await railCard.click();
    await page.waitForTimeout(1000);
  }
  const openButton = page.locator(".living-atlas__active button", { hasText: "打开故事" });
  if (await openButton.count()) {
    await openButton.click();
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      const story = document.querySelector(".journey-story");
      const rect = story?.getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        storyRect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        viewport: { w: innerWidth, h: innerHeight },
        copyScrollTop: document.querySelector(".journey-story__copy")?.scrollTop ?? null,
      };
    });
    console.log("BEFORE:", JSON.stringify(before));
    console.log("AFTER OPEN:", JSON.stringify(state));
  } else {
    console.log("open story button not found");
  }

  await browser.close();
}

main().catch((error) => { console.error("FAILED:", error); process.exit(1); });
