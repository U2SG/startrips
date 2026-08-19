import { chromium } from "playwright-core";

const EMAIL = "mapqa-1787023856@example.test";
const PASSWORD = "map-qa-password-2026";
const ORIGIN = "https://106.53.130.142";

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  page.on("console", (message) => {
    if (message.type() === "error") issues.push(`[console.error] ${message.text()}`);
  });
  page.on("pageerror", (error) => issues.push(`[pageerror] ${error.message}`));
  page.on("requestfailed", (request) =>
    issues.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`),
  );

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const amapRequests = [];
  const proxyRequests = [];
  const allRequests = [];
  page.on("request", (request) => {
    allRequests.push(request.url().slice(0, 140));
    if (request.url().includes("is.autonavi.com")) amapRequests.push(request.url().slice(0, 120));
    if (request.url().includes("/api/mapstyle")) proxyRequests.push(request.url().slice(0, 120));
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/mapstyle")) {
      console.log(`[mapstyle response] ${response.status()} ${response.url().slice(0, 120)}`);
    }
  });

  // Sign in through the API with a shared cookie jar, then load the app.
  const signIn = await page.context().request.post(`${ORIGIN}/api/auth/sign-in/email`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  console.log(`sign-in status: ${signIn.status()}`);
  const orgList = await page.context().request.get(`${ORIGIN}/api/auth/organization/list`);
  console.log(`org-list status: ${orgList.status()}`);
  const orgText = await orgList.text();
  console.log(`org-list body: ${orgText.slice(0, 300)}`);
  const orgs = JSON.parse(orgText);
  const organizationId = orgs?.data?.[0]?.id ?? orgs?.[0]?.id;
  if (organizationId) {
    const setActive = await page.context().request.post(
      `${ORIGIN}/api/auth/organization/set-active`,
      { data: { organizationId }, headers: { origin: ORIGIN } },
    );
    console.log(`set-active status: ${setActive.status()}`);
  } else {
    console.log("no organization found for QA account");
  }
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const hasGlobe = await page.locator(".living-atlas-globe").count();
  console.log(`logged in, globe present: ${hasGlobe > 0}`);
  const diag = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    authCard: !!document.querySelector(".auth-card"),
    authMessage: document.querySelector(".auth-message")?.textContent ?? null,
    loading: document.querySelector(".auth-loading")?.textContent ?? null,
    livingAtlas: !!document.querySelector(".living-atlas"),
    accountDock: !!document.querySelector(".account-dock"),
  }));
  console.log("=== DIAG ===");
  console.log(JSON.stringify(diag, null, 2));

  const modeButton = page.locator(".living-atlas-globe__mode");
  if (await modeButton.count()) {
    await modeButton.click();
    await page.waitForTimeout(6000);
    const early = await page.evaluate(() => ({
      mapError: document.querySelector(".detailed-earth-map")?.dataset.mapError ?? null,
      mapReady: document.querySelector(".detailed-earth-map")?.dataset.mapReady ?? null,
      earthMode: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") ?? null,
    }));
    console.log("=== EARLY STATE (6s) ===");
    console.log(JSON.stringify(early, null, 2));
    await page.waitForTimeout(10000);
  }

  const state = await page.evaluate(() => {
    const globe = document.querySelector(".living-atlas-globe");
    const detail = document.querySelector(".detailed-earth-map");
    const canvases = [...document.querySelectorAll("canvas")].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      visible: canvas.getBoundingClientRect().width > 0,
    }));
    return {
      earthMode: globe?.getAttribute("data-earth-mode") ?? null,
      detailDataset: detail ? { ...detail.dataset } : null,
      canvases,
      transitionStatus: document.querySelector(".living-atlas-globe__transition-status")?.textContent ?? null,
    };
  });
  console.log("=== STATE ===");
  console.log(JSON.stringify(state, null, 2));
  console.log(`=== AMAP TILE REQUESTS: ${amapRequests.length} ===`);
  amapRequests.slice(0, 5).forEach((url) => console.log(url));
  console.log(`=== MAP PROXY REQUESTS: ${proxyRequests.length} ===`);
  proxyRequests.slice(0, 5).forEach((url) => console.log(url));
  console.log(`=== ALL REQUESTS (${allRequests.length}) ===`);
  allRequests.slice(0, 40).forEach((url) => console.log(url));
  console.log("=== ISSUES ===");
  issues.slice(0, 15).forEach((line) => console.log(line));
  if (issues.length === 0) console.log("(none)");

  await page.screenshot({ path: "D:\\startrips\\map-qa-screenshot.png", fullPage: false });
  await browser.close();
}

main().catch((error) => {
  console.error("QA FAILED:", error);
  process.exit(1);
});
